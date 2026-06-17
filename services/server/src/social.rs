use serde::Deserialize;

/// Full sub-agent row returned by the social server API (matches `SubAgentRow`).
#[derive(Debug, Clone, Deserialize)]
pub struct SocialSubAgent {
    pub agent_object_id: String,
    pub derived_address: String,
    pub account_id: String,
    pub label: String,
    pub identity_class: i16,
    pub role_tags: i64,
    pub capabilities: i64,
    pub delegatable_caps: i64,
    pub register_scope: i16,
    pub approval_required_caps: i64,
    pub max_action_spend: Option<i64>,
    pub platform_scope: Option<String>,
    pub parent_object_id: Option<String>,
    pub depth: i16,
    pub registered_by: String,
    pub expires_at_ms: Option<i64>,
    #[serde(default = "default_true")]
    pub active: bool,
    pub created_at_ms: i64,
    pub deactivated_at_ms: Option<i64>,
    pub revoked_at_ms: Option<i64>,
    pub updated_at_ms: i64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug)]
pub enum SocialApiError {
    Http(String),
    NotFound,
    Parse(String),
}

impl std::fmt::Display for SocialApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SocialApiError::Http(msg) => write!(f, "social API HTTP error: {}", msg),
            SocialApiError::NotFound => write!(f, "sub-agent not found in social index"),
            SocialApiError::Parse(msg) => write!(f, "social API parse error: {}", msg),
        }
    }
}

impl std::error::Error for SocialApiError {}

/// Fetch a sub-agent by derived address from the social server.
pub async fn fetch_sub_agent_by_derived_address(
    http_client: &reqwest::Client,
    base_url: &str,
    derived_address: &str,
) -> Result<SocialSubAgent, SocialApiError> {
    let url = format!(
        "{}/sub-agents/{}",
        base_url.trim_end_matches('/'),
        derived_address
    );
    get_json(http_client, &url).await
}

/// Fetch a sub-agent by on-chain object id.
pub async fn fetch_sub_agent_by_object_id(
    http_client: &reqwest::Client,
    base_url: &str,
    agent_object_id: &str,
) -> Result<SocialSubAgent, SocialApiError> {
    let url = format!(
        "{}/sub-agents/by-object/{}",
        base_url.trim_end_matches('/'),
        agent_object_id
    );
    get_json(http_client, &url).await
}

async fn get_json(
    http_client: &reqwest::Client,
    url: &str,
) -> Result<SocialSubAgent, SocialApiError> {
    let response = http_client
        .get(url)
        .send()
        .await
        .map_err(|e| SocialApiError::Http(e.to_string()))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(SocialApiError::NotFound);
    }

    if !response.status().is_success() {
        return Err(SocialApiError::Http(format!(
            "status {}",
            response.status()
        )));
    }

    response
        .json::<SocialSubAgent>()
        .await
        .map_err(|e| SocialApiError::Parse(e.to_string()))
}

/// Walk parent chain up to root, mirroring `assert_ancestor_chain_active_from_table`.
/// Returns ancestors ordered from immediate parent to root (excludes `agent` itself).
pub async fn fetch_ancestor_chain(
    http_client: &reqwest::Client,
    base_url: &str,
    agent: &SocialSubAgent,
) -> Result<Vec<SocialSubAgent>, SocialApiError> {
    use crate::memory_contract::MAX_AGENT_DEPTH;

    let mut ancestors = Vec::new();
    let mut current_parent = agent.parent_object_id.clone();
    let mut hops = 0u8;

    while let Some(parent_id) = current_parent {
        hops += 1;
        if hops > MAX_AGENT_DEPTH {
            return Err(SocialApiError::Parse(
                "ancestor chain exceeds max depth".into(),
            ));
        }

        let parent = fetch_sub_agent_by_object_id(http_client, base_url, &parent_id).await?;
        current_parent = parent.parent_object_id.clone();
        ancestors.push(parent);
    }

    Ok(ancestors)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn social_sub_agent_deserializes_full_row() {
        let json = r#"{
            "agent_object_id": "0xagent",
            "derived_address": "0xderived",
            "account_id": "0xaccount",
            "label": "laptop",
            "identity_class": 1,
            "role_tags": 0,
            "capabilities": 3,
            "delegatable_caps": 0,
            "register_scope": 3,
            "approval_required_caps": 0,
            "max_action_spend": null,
            "platform_scope": null,
            "parent_object_id": null,
            "depth": 1,
            "registered_by": "0xowner",
            "expires_at_ms": null,
            "active": true,
            "created_at_ms": 1,
            "deactivated_at_ms": null,
            "revoked_at_ms": null,
            "updated_at_ms": 1
        }"#;
        let row: SocialSubAgent = serde_json::from_str(json).unwrap();
        assert_eq!(row.account_id, "0xaccount");
        assert_eq!(row.capabilities, 3);
        assert!(row.active);
    }

    #[tokio::test]
    async fn fetch_sub_agent_hits_mock_social_api() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock social server");
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = vec![0u8; 4096];
            let _ = socket.read(&mut buf).await;
            let body = r#"{"agent_object_id":"0xagent","derived_address":"0xderived","account_id":"0xaccount","label":"x","identity_class":1,"role_tags":0,"capabilities":3,"delegatable_caps":0,"register_scope":3,"approval_required_caps":0,"max_action_spend":null,"platform_scope":null,"parent_object_id":null,"depth":1,"registered_by":"0xowner","expires_at_ms":null,"active":true,"created_at_ms":1,"deactivated_at_ms":null,"revoked_at_ms":null,"updated_at_ms":1}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.ok();
        });

        let client = reqwest::Client::new();
        let base = format!("http://{}", addr);
        let row = fetch_sub_agent_by_derived_address(&client, &base, "0xderived")
            .await
            .expect("fetch");
        assert_eq!(row.account_id, "0xaccount");
    }
}
