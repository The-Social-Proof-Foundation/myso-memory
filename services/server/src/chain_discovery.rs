use crate::memory_contract::normalize_object_id;
use crate::types::{Config, SocialChainConfig};
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::BTreeSet;

const LOCAL_MESSAGING_PACKAGE_ID: &str = "0xe110";

#[derive(Debug, Default)]
pub struct DiscoveryReport {
    pub discovered: Vec<&'static str>,
    pub unresolved: Vec<&'static str>,
}

struct ObjectTarget {
    alias: &'static str,
    env_name: &'static str,
    module: &'static str,
    struct_name: &'static str,
    messaging: bool,
}

const TARGETS: &[ObjectTarget] = &[
    ObjectTarget {
        alias: "usernameRegistry",
        env_name: "USERNAME_REGISTRY_ID",
        module: "profile",
        struct_name: "UsernameRegistry",
        messaging: false,
    },
    ObjectTarget {
        alias: "platformRegistry",
        env_name: "PLATFORM_REGISTRY_ID",
        module: "platform",
        struct_name: "PlatformRegistry",
        messaging: false,
    },
    ObjectTarget {
        alias: "platform",
        env_name: "PLATFORM_OBJECT_ID",
        module: "platform",
        struct_name: "Platform",
        messaging: false,
    },
    ObjectTarget {
        alias: "blockListRegistry",
        env_name: "BLOCK_LIST_REGISTRY_ID",
        module: "block_list",
        struct_name: "BlockListRegistry",
        messaging: false,
    },
    ObjectTarget {
        alias: "postConfig",
        env_name: "POST_CONFIG_ID",
        module: "post",
        struct_name: "PostConfig",
        messaging: false,
    },
    ObjectTarget {
        alias: "memoryConfig",
        env_name: "MEMORY_CONFIG_ID",
        module: "memory",
        struct_name: "MemoryConfig",
        messaging: false,
    },
    ObjectTarget {
        alias: "mydataRegistry",
        env_name: "MYDATA_REGISTRY_ID",
        module: "mydata",
        struct_name: "MyDataRegistry",
        messaging: false,
    },
    ObjectTarget {
        alias: "socialGraph",
        env_name: "SOCIAL_GRAPH_ID",
        module: "social_graph",
        struct_name: "SocialGraph",
        messaging: false,
    },
    ObjectTarget {
        alias: "messagingVersion",
        env_name: "MESSAGING_VERSION_ID",
        module: "version",
        struct_name: "Version",
        messaging: true,
    },
    ObjectTarget {
        alias: "messagingConfig",
        env_name: "MESSAGING_CONFIG_ID",
        module: "messaging_config",
        struct_name: "MessagingConfig",
        messaging: true,
    },
    ObjectTarget {
        alias: "messagingNamespace",
        env_name: "MESSAGING_NAMESPACE_ID",
        module: "messaging",
        struct_name: "MessagingNamespace",
        messaging: true,
    },
    ObjectTarget {
        alias: "messagingGroupManager",
        env_name: "MESSAGING_GROUP_MANAGER_ID",
        module: "group_manager",
        struct_name: "GroupManager",
        messaging: true,
    },
    ObjectTarget {
        alias: "messagingGroupLeaver",
        env_name: "MESSAGING_GROUP_LEAVER_ID",
        module: "group_leaver",
        struct_name: "GroupLeaver",
        messaging: true,
    },
];

pub async fn discover_missing_chain_ids(
    config: &mut Config,
    client: &Client,
) -> Result<DiscoveryReport, String> {
    if !config.social_chain_auto_discovery {
        return Ok(DiscoveryReport::default());
    }
    let graphql_url = config.social_chain_graphql_url.as_deref().ok_or_else(|| {
        "SOCIAL_CHAIN_GRAPHQL_URL is required when auto-discovery is enabled".to_string()
    })?;
    assert_safe_discovery_url(graphql_url, &config.myso_network)?;

    let social_package = normalize_object_id(&config.package_id);
    let messaging_package = if config.social_chain.messaging_package_id.is_empty() {
        normalize_object_id(LOCAL_MESSAGING_PACKAGE_ID)
    } else {
        normalize_object_id(&config.social_chain.messaging_package_id)
    };
    let query = discovery_query(&social_package, &messaging_package);
    let response = client
        .post(graphql_url)
        .json(&json!({ "query": query }))
        .send()
        .await
        .map_err(|error| format!("GraphQL discovery request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("GraphQL discovery returned {}", response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("GraphQL discovery response was invalid: {error}"))?;
    if let Some(errors) = body.get("errors") {
        return Err(format!("GraphQL discovery returned errors: {errors}"));
    }

    let mut report = DiscoveryReport::default();
    if config.social_chain.messaging_package_id.is_empty() {
        let discovered_package = body
            .pointer("/data/messagingPackage/address")
            .and_then(Value::as_str)
            .map(normalize_object_id);
        if discovered_package.as_deref() == Some(messaging_package.as_str()) {
            config.social_chain.messaging_package_id = messaging_package.clone();
            report.discovered.push("MESSAGING_PACKAGE_ID");
        } else {
            report.unresolved.push("MESSAGING_PACKAGE_ID");
        }
    }

    for target in TARGETS {
        let package = if target.messaging {
            &messaging_package
        } else {
            &social_package
        };
        let configured = chain_value(&config.social_chain, target.alias).to_string();
        if !configured.is_empty() {
            if verify_shared_object(
                client,
                &config.myso_rpc_url,
                &configured,
                package,
                target.module,
                target.struct_name,
            )
            .await
            {
                continue;
            }
            if config.myso_network != "localnet" {
                // Remote deployments keep explicit pins authoritative and fail
                // closed instead of replacing them from an indexer response.
                report.unresolved.push(target.env_name);
                continue;
            }
            // Local force-regenesis invalidates old object IDs. Clear only a
            // fullnode-proven stale pin, then resolve the current singleton.
            set_chain_value(&mut config.social_chain, target.alias, String::new());
        }
        let candidates = graphql_candidates(&body, target.alias);
        let mut live = BTreeSet::new();
        for candidate in candidates {
            if verify_shared_object(
                client,
                &config.myso_rpc_url,
                &candidate,
                package,
                target.module,
                target.struct_name,
            )
            .await
            {
                live.insert(normalize_object_id(&candidate));
            }
        }
        if live.len() == 1 {
            let value = live.into_iter().next().expect("one live candidate");
            set_chain_value(&mut config.social_chain, target.alias, value);
            report.discovered.push(target.env_name);
        } else {
            report.unresolved.push(target.env_name);
        }
    }
    Ok(report)
}

fn assert_safe_discovery_url(url: &str, network: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| format!("SOCIAL_CHAIN_GRAPHQL_URL is invalid: {error}"))?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if parsed.scheme() != "https" && !(network == "localnet" && local) {
        return Err(
            "GraphQL auto-discovery requires HTTPS except for localnet localhost".to_string(),
        );
    }
    Ok(())
}

fn discovery_query(social_package: &str, messaging_package: &str) -> String {
    let mut fields = vec![format!(
        "messagingPackage: package(address: \"{messaging_package}\") {{ address }}"
    )];
    for target in TARGETS {
        let package = if target.messaging {
            messaging_package
        } else {
            social_package
        };
        fields.push(format!(
            "{}: objects(filter: {{ type: \"{}::{}::{}\", ownerKind: SHARED }}, last: 10) {{ nodes {{ address }} }}",
            target.alias, package, target.module, target.struct_name,
        ));
    }
    format!(
        "query MemoryRelayerChainDiscovery {{ {} }}",
        fields.join("\n")
    )
}

fn graphql_candidates(body: &Value, alias: &str) -> Vec<String> {
    body.pointer(&format!("/data/{alias}/nodes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|node| node.get("address").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

async fn verify_shared_object(
    client: &Client,
    rpc_url: &str,
    object_id: &str,
    package: &str,
    module: &str,
    struct_name: &str,
) -> bool {
    let Ok(response) = client
        .post(rpc_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "myso_getObject",
            "params": [object_id, { "showType": true, "showOwner": true }],
        }))
        .send()
        .await
    else {
        return false;
    };
    let Ok(body) = response.json::<Value>().await else {
        return false;
    };
    let Some(actual_type) = body.pointer("/result/data/type").and_then(Value::as_str) else {
        return false;
    };
    let shared = body.pointer("/result/data/owner/Shared").is_some();
    shared && move_type_matches(actual_type, package, module, struct_name)
}

fn move_type_matches(actual: &str, package: &str, module: &str, struct_name: &str) -> bool {
    let mut parts = actual.split("::");
    let Some(actual_package) = parts.next() else {
        return false;
    };
    parts.next() == Some(module)
        && parts.next() == Some(struct_name)
        && parts.next().is_none()
        && normalize_object_id(actual_package) == normalize_object_id(package)
}

fn chain_value<'a>(chain: &'a SocialChainConfig, alias: &str) -> &'a str {
    match alias {
        "usernameRegistry" => &chain.username_registry_id,
        "platformRegistry" => &chain.platform_registry_id,
        "platform" => &chain.platform_object_id,
        "blockListRegistry" => &chain.block_list_registry_id,
        "postConfig" => &chain.post_config_id,
        "memoryConfig" => &chain.memory_config_id,
        "mydataRegistry" => &chain.mydata_registry_id,
        "socialGraph" => &chain.social_graph_id,
        "messagingVersion" => &chain.messaging_version_id,
        "messagingConfig" => &chain.messaging_config_id,
        "messagingNamespace" => &chain.messaging_namespace_id,
        "messagingGroupManager" => &chain.messaging_group_manager_id,
        "messagingGroupLeaver" => &chain.messaging_group_leaver_id,
        _ => "",
    }
}

fn set_chain_value(chain: &mut SocialChainConfig, alias: &str, value: String) {
    match alias {
        "usernameRegistry" => chain.username_registry_id = value,
        "platformRegistry" => chain.platform_registry_id = value,
        "platform" => chain.platform_object_id = value,
        "blockListRegistry" => chain.block_list_registry_id = value,
        "postConfig" => chain.post_config_id = value,
        "memoryConfig" => chain.memory_config_id = value,
        "mydataRegistry" => chain.mydata_registry_id = value,
        "socialGraph" => chain.social_graph_id = value,
        "messagingVersion" => chain.messaging_version_id = value,
        "messagingConfig" => chain.messaging_config_id = value,
        "messagingNamespace" => chain.messaging_namespace_id = value,
        "messagingGroupManager" => chain.messaging_group_manager_id = value,
        "messagingGroupLeaver" => chain.messaging_group_leaver_id = value,
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_type_matching_normalizes_package_addresses() {
        assert!(move_type_matches(
            "0x00000000000000000000000000000000000000000000000000000000000050c1::memory::MemoryConfig",
            "0x50c1",
            "memory",
            "MemoryConfig",
        ));
        assert!(!move_type_matches(
            "0x50c1::memory::MemoryAccount",
            "0x50c1",
            "memory",
            "MemoryConfig",
        ));
    }

    #[test]
    fn discovery_query_is_exact_type_and_shared_only() {
        let query = discovery_query("0x50c1", "0xe110");
        assert!(query.contains("0x50c1::memory::MemoryConfig"));
        assert!(query.contains("0xe110::messaging::MessagingNamespace"));
        assert!(query.contains("ownerKind: SHARED"));
        assert!(!query.contains("first: 1"));
    }

    #[test]
    fn remote_plain_http_discovery_is_rejected() {
        assert!(assert_safe_discovery_url("http://example.com/graphql", "testnet").is_err());
        assert!(assert_safe_discovery_url("http://127.0.0.1:9125/graphql", "localnet").is_ok());
    }
}
