//! `webhook` jobs: ask the owner's endpoint what to do about an event, then run the answer as a
//! registered action.
//!
//! This is the "agent brain" hook. The endpoint receives the signed event and replies with a
//! directive, `{"action_id": "task.deliver.v1", "params": {...}}` or `{"noop": true}`. The
//! directive can only name an action on the job's allowlist, and it executes through the same
//! bridge path (and the same on-chain limits) as a `registered_action` job, so a hostile or buggy
//! endpoint can do no more than the job's delegate is already allowed to.
//!
//! The engine is the one making the outbound request, so the destination is untrusted input:
//! HTTPS only, a per-job host allowlist, no redirects, private / loopback / link-local / metadata
//! addresses refused after DNS resolution (and the connection pinned to the address that was
//! checked), a short timeout and a response size cap. `AUTOMATION_WEBHOOK_ALLOW_PRIVATE=1` lifts
//! the address and scheme rules for local development only.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::memory_bridge::BridgeError;
use crate::registered_action::{valid_action_id, ActionPolicy, MAX_PARAMS_BYTES};
use crate::{AutomationJob, Config, PlatformEvent};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_ALLOWED_HOSTS: usize = 8;
const MAX_ALLOWED_ACTIONS: usize = 16;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebhookConfig {
    pub url: String,
    /// Shared secret for the request signature. Never returned by the relayer's job listing.
    pub secret: String,
    pub allowed_hosts: Vec<String>,
    /// The only actions a directive from this endpoint may name.
    pub allowed_action_ids: Vec<String>,
    /// Checked before the endpoint is called, so out-of-scope events never leave the engine.
    #[serde(default)]
    pub policy: ActionPolicy,
    #[serde(default)]
    pub key_ref: Option<String>,
}

/// What the endpoint decided.
#[derive(Debug, Clone, PartialEq)]
pub enum Directive {
    Noop(Option<String>),
    Act { action_id: String, params: Value },
}

pub fn parse_config(value: &Value) -> Result<WebhookConfig, String> {
    serde_json::from_value(value.clone()).map_err(|e| format!("invalid webhook config: {e}"))
}

pub fn validate_config(config: &WebhookConfig, allow_private: bool) -> Result<(), String> {
    if config.secret.len() < 16 {
        return Err("webhook secret must be at least 16 characters".into());
    }
    if config.allowed_hosts.is_empty() || config.allowed_hosts.len() > MAX_ALLOWED_HOSTS {
        return Err(format!("allowed_hosts needs 1 to {MAX_ALLOWED_HOSTS} entries"));
    }
    if config.allowed_action_ids.is_empty() || config.allowed_action_ids.len() > MAX_ALLOWED_ACTIONS {
        return Err(format!("allowed_action_ids needs 1 to {MAX_ALLOWED_ACTIONS} entries"));
    }
    if let Some(bad) = config.allowed_action_ids.iter().find(|id| !valid_action_id(id)) {
        return Err(format!("`{bad}` is not a valid action id"));
    }
    if let Some(key_ref) = &config.key_ref {
        if key_ref.trim().is_empty() {
            return Err("key_ref must not be blank".into());
        }
    }
    config.policy.validate()?;
    validate_url(&config.url, &config.allowed_hosts, allow_private).map(|_| ())
}

fn host_allowed(host: &str, allowed_hosts: &[String]) -> bool {
    allowed_hosts
        .iter()
        .any(|allowed| allowed.trim().trim_end_matches('.').eq_ignore_ascii_case(host.trim_end_matches('.')))
}

/// Static checks on the destination URL. Address checks happen after DNS resolution, in `call`.
pub fn validate_url(
    url: &str,
    allowed_hosts: &[String],
    allow_private: bool,
) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("webhook url is invalid: {e}"))?;
    match parsed.scheme() {
        "https" => {}
        "http" if allow_private => {}
        _ => return Err("webhook url must use https".into()),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("webhook url must not embed credentials".into());
    }
    let host = parsed.host_str().ok_or("webhook url has no host")?;
    if !host_allowed(host, allowed_hosts) {
        return Err(format!("host `{host}` is not in allowed_hosts"));
    }
    if !allow_private && parsed.port().is_some_and(|port| port != 443) {
        return Err("webhook url must use the default https port".into());
    }
    if !allow_private {
        if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>() {
            if is_blocked_ip(ip) {
                return Err("webhook url points at a private or reserved address".into());
            }
        }
    }
    Ok(parsed)
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local() // 169.254.0.0/16, which includes the cloud metadata address
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || (a == 100 && (64..=127).contains(&b)) // carrier-grade NAT
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 192 && b == 0 && c == 2) // TEST-NET-1
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || (a == 198 && b == 51 && c == 100) // TEST-NET-2
        || (a == 203 && b == 0 && c == 113) // TEST-NET-3
        || a >= 240 // reserved
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_blocked_v4(mapped);
    }
    let first = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (first & 0xfe00) == 0xfc00 // unique local
        || (first & 0xffc0) == 0xfe80 // link local
        || (first == 0x2001 && ip.segments()[1] == 0x0db8) // documentation
}

/// Addresses the engine must never connect to on a job's behalf.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => is_blocked_v6(v6),
    }
}

/// HMAC-SHA256 (RFC 2104). Implemented on `sha2` so the engine adds no dependency for one call.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36u8; 64];
    let mut outer_pad = [0x5cu8; 64];
    for i in 0..64 {
        inner_pad[i] ^= block[i];
        outer_pad[i] ^= block[i];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// `v1=<hex>` over `"<timestamp>.<body>"`, so a captured request cannot be replayed with a new
/// timestamp.
pub fn signature_header(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let mut message = format!("{timestamp}.").into_bytes();
    message.extend_from_slice(body);
    format!("v1={}", hex::encode(hmac_sha256(secret.as_bytes(), &message)))
}

#[derive(Deserialize)]
struct RawDirective {
    #[serde(default)]
    noop: bool,
    #[serde(default)]
    action_id: Option<String>,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    reason: Option<String>,
}

/// Parse and constrain the endpoint's reply.
pub fn parse_directive(bytes: &[u8], allowed_action_ids: &[String]) -> Result<Directive, BridgeError> {
    let invalid = |message: String| BridgeError::Invalid { message };
    let raw: RawDirective = serde_json::from_slice(bytes)
        .map_err(|e| invalid(format!("webhook reply is not a directive object: {e}")))?;
    if raw.noop {
        return Ok(Directive::Noop(raw.reason));
    }
    let action_id = raw
        .action_id
        .ok_or_else(|| invalid("webhook directive has neither `noop` nor `action_id`".into()))?;
    if !allowed_action_ids.iter().any(|allowed| allowed == &action_id) {
        return Err(invalid(format!(
            "webhook directive named `{action_id}`, which is not in allowed_action_ids"
        )));
    }
    let params = raw.params.unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err(invalid("webhook directive params must be an object".into()));
    }
    let size = serde_json::to_vec(&params).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > MAX_PARAMS_BYTES {
        return Err(invalid(format!("webhook directive params are {size} bytes; the limit is {MAX_PARAMS_BYTES}")));
    }
    Ok(Directive::Act { action_id, params })
}

#[derive(Clone)]
pub struct WebhookClient {
    allow_private: bool,
}

impl WebhookClient {
    pub fn new(config: &Config) -> Self {
        Self {
            allow_private: config.webhook_allow_private,
        }
    }

    pub fn allow_private(&self) -> bool {
        self.allow_private
    }

    /// Resolve the host and return the one address the connection will be pinned to.
    async fn resolve(&self, url: &reqwest::Url) -> Result<SocketAddr, BridgeError> {
        let host = url.host_str().unwrap_or_default().to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|e| BridgeError::Unavailable {
                message: format!("cannot resolve webhook host `{host}`: {e}"),
            })?
            .collect();
        if addrs.is_empty() {
            return Err(BridgeError::Unavailable {
                message: format!("webhook host `{host}` has no addresses"),
            });
        }
        // Any blocked answer rejects the host: an attacker-controlled name can return a public
        // address and an internal one and hope the client picks the internal one.
        if !self.allow_private && addrs.iter().any(|addr| is_blocked_ip(addr.ip())) {
            return Err(BridgeError::Invalid {
                message: format!("webhook host `{host}` resolves to a private or reserved address"),
            });
        }
        Ok(addrs[0])
    }

    /// Deliver the event and return the endpoint's directive.
    pub async fn call(
        &self,
        config: &WebhookConfig,
        job: &AutomationJob,
        event: &PlatformEvent,
        delivery_id: &str,
    ) -> Result<Directive, BridgeError> {
        let url = validate_url(&config.url, &config.allowed_hosts, self.allow_private)
            .map_err(|message| BridgeError::Invalid { message })?;
        let pinned = self.resolve(&url).await?;
        let host = url.host_str().unwrap_or_default().to_string();

        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .user_agent("myso-automation/1")
            .resolve(&host, pinned)
            .build()
            .map_err(|e| BridgeError::Unavailable {
                message: format!("cannot build webhook client: {e}"),
            })?;

        let body = serde_json::to_vec(&json!({
            "version": 1,
            "delivery_id": delivery_id,
            "job_id": job.id,
            "job_name": job.name,
            "account_id": job.account_id,
            "allowed_action_ids": config.allowed_action_ids,
            "event": event,
        }))
        .map_err(|e| BridgeError::Invalid { message: e.to_string() })?;
        let timestamp = chrono::Utc::now().timestamp();

        let mut response = client
            .post(url)
            .header("content-type", "application/json")
            .header("x-myso-timestamp", timestamp.to_string())
            .header("x-myso-delivery", delivery_id)
            .header("x-myso-signature", signature_header(&config.secret, timestamp, &body))
            .body(body)
            .send()
            .await
            .map_err(|e| BridgeError::Unavailable {
                message: format!("webhook request failed: {e}"),
            })?;

        let status = response.status();
        if status.is_redirection() {
            return Err(BridgeError::Invalid {
                message: format!("webhook answered {status}; redirects are not followed"),
            });
        }

        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| BridgeError::Unavailable {
            message: format!("reading webhook reply failed: {e}"),
        })? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(BridgeError::Invalid {
                    message: format!("webhook reply exceeds {MAX_RESPONSE_BYTES} bytes"),
                });
            }
            bytes.extend_from_slice(&chunk);
        }

        if status.is_server_error() || status.as_u16() == 429 {
            return Err(BridgeError::Unavailable {
                message: format!("webhook answered {status}"),
            });
        }
        if !status.is_success() {
            return Err(BridgeError::Rejected {
                status: status.as_u16(),
                message: format!("webhook answered {status}"),
            });
        }
        parse_directive(&bytes, &config.allowed_action_ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts(list: &[&str]) -> Vec<String> {
        list.iter().map(|h| (*h).to_string()).collect()
    }

    fn config(overrides: Value) -> WebhookConfig {
        let mut base = json!({
            "url": "https://worker.example.com/hook",
            "secret": "0123456789abcdef0123",
            "allowed_hosts": ["worker.example.com"],
            "allowed_action_ids": ["task.deliver.v1"],
        });
        if let (Some(base), Some(extra)) = (base.as_object_mut(), overrides.as_object()) {
            base.extend(extra.clone());
        }
        parse_config(&base).unwrap()
    }

    #[test]
    fn hmac_matches_the_rfc_4231_vectors() {
        let case_1 = hmac_sha256(&[0x0b; 20], b"Hi There");
        assert_eq!(
            hex::encode(case_1),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        let case_2 = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex::encode(case_2),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Keys longer than the block size are hashed first (RFC 4231 case 6).
        let case_6 = hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(
            hex::encode(case_6),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn the_signature_binds_timestamp_and_body() {
        let a = signature_header("0123456789abcdef", 100, b"{}");
        assert!(a.starts_with("v1="));
        assert_eq!(a, signature_header("0123456789abcdef", 100, b"{}"));
        assert_ne!(a, signature_header("0123456789abcdef", 101, b"{}"));
        assert_ne!(a, signature_header("0123456789abcdef", 100, b"{ }"));
        assert_ne!(a, signature_header("fedcba9876543210", 100, b"{}"));
    }

    #[test]
    fn private_and_reserved_addresses_are_blocked() {
        for blocked in [
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0",
            "100.64.0.1", "224.0.0.1", "255.255.255.255", "198.18.0.1", "240.0.0.1", "::1", "::",
            "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
            "2001:db8::1",
        ] {
            assert!(is_blocked_ip(blocked.parse().unwrap()), "{blocked} should be blocked");
        }
        for public in ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "100.63.255.255", "172.32.0.1"] {
            assert!(!is_blocked_ip(public.parse().unwrap()), "{public} should be allowed");
        }
    }

    #[test]
    fn urls_must_be_https_on_an_allowed_host() {
        let allowed = hosts(&["worker.example.com"]);
        assert!(validate_url("https://worker.example.com/hook", &allowed, false).is_ok());
        assert!(validate_url("https://WORKER.example.com./hook", &allowed, false).is_ok());
        for bad in [
            "http://worker.example.com/hook",
            "https://evil.example.com/hook",
            "https://worker.example.com.evil.com/hook",
            "https://user:pass@worker.example.com/hook",
            "https://worker.example.com:8443/hook",
            "ftp://worker.example.com/hook",
            "not a url",
        ] {
            assert!(validate_url(bad, &allowed, false).is_err(), "{bad}");
        }
    }

    #[test]
    fn ip_literals_and_metadata_hosts_are_refused_even_when_allowlisted() {
        let allowed = hosts(&["169.254.169.254", "127.0.0.1", "[::1]"]);
        for bad in ["https://169.254.169.254/latest", "https://127.0.0.1/x", "https://[::1]/x"] {
            assert!(validate_url(bad, &allowed, false).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_dev_override_allows_local_http_but_not_a_host_outside_the_allowlist() {
        let allowed = hosts(&["localhost"]);
        assert!(validate_url("http://localhost:9000/hook", &allowed, true).is_ok());
        assert!(validate_url("http://localhost:9000/hook", &allowed, false).is_err());
        assert!(validate_url("http://evil.test:9000/hook", &allowed, true).is_err());
    }

    #[test]
    fn config_validation_enforces_secret_strength_and_allowlists() {
        assert!(validate_config(&config(json!({})), false).is_ok());
        assert!(validate_config(&config(json!({ "secret": "short" })), false).is_err());
        assert!(validate_config(&config(json!({ "allowed_hosts": [] })), false).is_err());
        assert!(validate_config(&config(json!({ "allowed_action_ids": [] })), false).is_err());
        assert!(validate_config(&config(json!({ "allowed_action_ids": ["not an id"] })), false).is_err());
        assert!(validate_config(&config(json!({ "url": "https://evil.example.com/" })), false).is_err());
        assert!(parse_config(&json!({ "url": "https://a.b/", "secret": "x" })).is_err());
        assert!(parse_config(&json!({
            "url": "https://worker.example.com/", "secret": "0123456789abcdef",
            "allowed_hosts": ["worker.example.com"], "allowed_action_ids": ["task.deliver.v1"],
            "extra": true
        }))
        .is_err());
    }

    #[test]
    fn directives_are_constrained_to_the_allowlist() {
        let allowed = vec!["task.deliver.v1".to_string()];
        let act = parse_directive(
            br#"{"action_id":"task.deliver.v1","params":{"taskId":"0x1","digestHex":"ab"}}"#,
            &allowed,
        )
        .unwrap();
        assert_eq!(
            act,
            Directive::Act {
                action_id: "task.deliver.v1".into(),
                params: json!({ "taskId": "0x1", "digestHex": "ab" }),
            }
        );
        assert_eq!(parse_directive(br#"{"noop":true,"reason":"too big"}"#, &allowed).unwrap(), Directive::Noop(Some("too big".into())));
        assert_eq!(
            parse_directive(br#"{"action_id":"task.deliver.v1"}"#, &allowed).unwrap(),
            Directive::Act { action_id: "task.deliver.v1".into(), params: json!({}) }
        );

        for bad in [
            &br#"{"action_id":"task.settle.v1","params":{}}"#[..],
            br#"{"action_id":"social.create_post.v1"}"#,
            br#"{"params":{}}"#,
            br#"{"action_id":"task.deliver.v1","params":[1]}"#,
            br#"[]"#,
            b"not json",
            b"",
        ] {
            assert!(
                matches!(parse_directive(bad, &allowed), Err(BridgeError::Invalid { .. })),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn oversized_directive_params_are_rejected() {
        let allowed = vec!["task.deliver.v1".to_string()];
        let body = serde_json::to_vec(&json!({
            "action_id": "task.deliver.v1",
            "params": { "blob": "x".repeat(MAX_PARAMS_BYTES + 1) },
        }))
        .unwrap();
        assert!(parse_directive(&body, &allowed).is_err());
    }
}
