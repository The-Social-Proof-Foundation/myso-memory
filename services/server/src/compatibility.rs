//! Public relayer/API compatibility metadata.
//!
//! Keep in sync with docs/relayer/versioning-and-compatibility.md and
//! packages/sdk/src/compatibility.ts; scripts/check-compatibility-contract.mjs verifies in CI.

use serde::Serialize;
use std::collections::BTreeMap;

pub const RELAYER_API_VERSION: &str = "1.1.1";
pub const MIN_TYPESCRIPT_SDK_VERSION: &str = "0.6.0";
pub const MIN_MCP_PACKAGE_VERSION: &str = "0.1.0";

#[derive(Debug, Clone, Serialize)]
pub struct VersionResponse {
    #[serde(rename = "relayerVersion")]
    pub relayer_version: String,
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    #[serde(rename = "minSupportedSdk")]
    pub min_supported_sdk: MinSupportedSdk,
    #[serde(rename = "featureFlags")]
    pub feature_flags: BTreeMap<String, bool>,
    pub deprecations: Vec<DeprecationNotice>,
    pub build: BuildMetadata,
}

#[derive(Debug, Clone, Serialize)]
pub struct MinSupportedSdk {
    pub typescript: String,
    pub mcp: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeprecationNotice {
    pub surface: String,
    #[serde(rename = "deprecatedSince")]
    pub deprecated_since: String,
    #[serde(rename = "removalApiVersion")]
    pub removal_api_version: String,
    pub guidance: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(rename = "buildTimestamp", skip_serializing_if = "Option::is_none")]
    pub build_timestamp: Option<String>,
}

pub fn version_response() -> VersionResponse {
    VersionResponse {
        relayer_version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: RELAYER_API_VERSION.to_string(),
        min_supported_sdk: MinSupportedSdk {
            typescript: MIN_TYPESCRIPT_SDK_VERSION.to_string(),
            mcp: MIN_MCP_PACKAGE_VERSION.to_string(),
        },
        feature_flags: feature_flags(),
        deprecations: deprecations(),
        build: BuildMetadata {
            commit: first_metadata_value(&[
                option_env!("GIT_SHA"),
                option_env!("GITHUB_SHA"),
                option_env!("RAILWAY_GIT_COMMIT_SHA"),
            ])
            .or_else(|| first_runtime_env(&["GIT_SHA", "GITHUB_SHA", "RAILWAY_GIT_COMMIT_SHA"])),
            build_timestamp: first_metadata_value(&[
                option_env!("BUILD_TIMESTAMP"),
                option_env!("SOURCE_DATE_EPOCH"),
            ])
            .or_else(|| first_runtime_env(&["BUILD_TIMESTAMP", "SOURCE_DATE_EPOCH"])),
        },
    }
}

pub fn is_compatible_sdk_version(sdk_version: &str) -> bool {
    compare_semver(sdk_version, MIN_TYPESCRIPT_SDK_VERSION) >= 0
}

fn feature_flags() -> BTreeMap<String, bool> {
    BTreeMap::from([
        ("auth.accountBoundNonce".to_string(), true),
        ("auth.mydataSessionHeader".to_string(), true),
        ("config.publicDeploymentMetadata".to_string(), true),
        ("remember.asyncJobs".to_string(), true),
        ("remember.bulk".to_string(), true),
        ("recall.compositeRanker".to_string(), true),
        ("social.subAgentActions".to_string(), true),
        ("subAgent.v1PolicyHardening".to_string(), true),
        ("runtime.versionEndpoint".to_string(), true),
    ])
}

fn deprecations() -> Vec<DeprecationNotice> {
    vec![
        DeprecationNotice {
            surface: "request.namespace-as-primary".to_string(),
            deprecated_since: "1.0.0".to_string(),
            removal_api_version: "2.0.0".to_string(),
            guidance: "Use agent_object_id from sub-agent auth; optional sub_label replaces namespace for tagging.".to_string(),
        },
        DeprecationNotice {
            surface: "header:x-delegate-key".to_string(),
            deprecated_since: "1.0.0".to_string(),
            removal_api_version: "2.0.0".to_string(),
            guidance: "Use x-mydata-session for relayer-managed MYDATA decrypt flows.".to_string(),
        },
        DeprecationNotice {
            surface: "subAgent.approvalRequiredCaps".to_string(),
            deprecated_since: "1.1.1".to_string(),
            removal_api_version: "2.0.0".to_string(),
            guidance: "Relayer does not enforce approval_required_caps in v1; use 0 for autonomous agents. On-chain social txs still abort if set.".to_string(),
        },
        DeprecationNotice {
            surface: "subAgent.maxActionSpend".to_string(),
            deprecated_since: "1.1.1".to_string(),
            removal_api_version: "2.0.0".to_string(),
            guidance: "Relayer does not enforce max_action_spend in v1; reserved for v2 spend policy.".to_string(),
        },
        DeprecationNotice {
            surface: "social.ownerCoSignForCreates".to_string(),
            deprecated_since: "1.1.1".to_string(),
            removal_api_version: "2.0.0".to_string(),
            guidance: "Owner HTTP co-sign applies to social delete routes only, not creates.".to_string(),
        },
    ]
}

fn first_metadata_value(values: &[Option<&'static str>]) -> Option<String> {
    values
        .iter()
        .flatten()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn first_runtime_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

fn compare_semver(a: &str, b: &str) -> i32 {
    let parse = |v: &str| -> Option<[u32; 3]> {
        let parts: Vec<_> = v.trim().split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        Some([
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ])
    };
    let Some(left) = parse(a) else {
        return -1;
    };
    let Some(right) = parse(b) else {
        return 1;
    };
    for i in 0..3 {
        if left[i] != right[i] {
            return left[i] as i32 - right[i] as i32;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::{
        is_compatible_sdk_version, version_response, MIN_MCP_PACKAGE_VERSION,
        MIN_TYPESCRIPT_SDK_VERSION, RELAYER_API_VERSION,
    };

    #[test]
    fn version_response_exposes_contract_metadata() {
        let response = version_response();

        assert_eq!(response.relayer_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(response.api_version, "1.1.1");
        assert_eq!(
            response.min_supported_sdk.typescript,
            MIN_TYPESCRIPT_SDK_VERSION
        );
        assert_eq!(response.min_supported_sdk.mcp, MIN_MCP_PACKAGE_VERSION);
        assert_eq!(
            response.feature_flags.get("runtime.versionEndpoint"),
            Some(&true)
        );
        assert!(response
            .deprecations
            .iter()
            .any(|notice| notice.surface == "request.namespace-as-primary"));
    }

    #[test]
    fn sdk_version_check() {
        assert!(is_compatible_sdk_version("0.6.0"));
        assert!(!is_compatible_sdk_version("0.5.0"));
    }
}
