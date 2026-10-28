//! Fixed, authenticated read facade. Callers cannot choose an upstream URL or identity.
use crate::types::{AppError, AppState, AuthInfo};
use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures::{stream, StreamExt, TryStreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, sync::Arc};

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ReadQuery {
    pub id: Option<String>,
    pub username: Option<String>,
    pub role: Option<String>,
    pub status: Option<String>,
    pub proposal_type: Option<i16>,
    pub owner: Option<String>,
    pub profile_id: Option<String>,
    pub post_id: Option<String>,
    pub state: Option<String>,
    pub round: Option<u32>,
    pub subject_kind: Option<i16>,
    pub subject_id: Option<String>,
    pub sort: Option<String>,
    pub category: Option<String>,
    pub bucket: Option<String>,
    pub min_reviews: Option<u32>,
    pub active: Option<bool>,
    pub insured: Option<String>,
    #[serde(rename = "market_id")]
    pub market_id: Option<String>,
    #[serde(rename = "vault_id")]
    pub vault_id: Option<String>,
    pub period_days: Option<u32>,
    pub min_revenue: Option<String>,
    #[serde(rename = "revenue_source")]
    pub revenue_source: Option<String>,
    #[serde(rename = "revenue_type")]
    pub revenue_type: Option<String>,
    #[serde(rename = "content_id")]
    pub content_id: Option<String>,
    #[serde(rename = "content_type")]
    pub content_type: Option<String>,
    pub period: Option<String>,
    pub points: Option<u32>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub seq: Option<String>,
    #[serde(rename = "serviceId")]
    pub service_id: Option<String>,
    #[serde(rename = "planId")]
    pub plan_id: Option<String>,
    pub cursor: Option<String>,
    #[serde(rename = "coinType", alias = "coin_type")]
    pub coin_type: Option<String>,
    pub recipient: Option<String>,
    #[serde(rename = "idempotency_key", alias = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(rename = "amountBaseUnits")]
    pub amount_base_units: Option<String>,
    pub query: Option<String>,
    pub page: Option<u32>,
    pub filter_types: Option<String>,
    pub org_type: Option<i16>,
    pub active_only: Option<bool>,
    pub approved: Option<bool>,
    pub governance: Option<bool>,
    #[serde(rename = "registryId")]
    pub registry_id: Option<String>,
    #[serde(rename = "proposalId")]
    pub proposal_id: Option<String>,
    #[serde(rename = "voteCount")]
    pub vote_count: Option<String>,
    pub window: Option<String>,
    pub member: Option<String>,
    pub agent: Option<String>,
    pub action: Option<String>,
    pub actor: Option<String>,
    pub target_type: Option<String>,
    pub source: Option<String>,
    #[serde(rename = "min_roster")]
    pub min_roster: Option<u32>,
    pub reservation_nonce: Option<i64>,
    pub pool_name: Option<String>,
    #[serde(rename = "poolId")]
    pub pool_id: Option<String>,
    #[serde(rename = "tradeKind")]
    pub trade_kind: Option<String>,
    pub levels_per_side: Option<u32>,
    pub address: Option<String>,
    pub follower: Option<String>,
    pub following: Option<String>,
    pub token_type: Option<i16>,
    pub include_reservations: Option<bool>,
    pub interval: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub min_tier_level: Option<i64>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub creator: Option<String>,
    pub media_type: Option<String>,
    pub platform_id: Option<String>,
    pub submitter: Option<String>,
    pub sort_by: Option<String>,
}
fn object_id(value: &str) -> Result<String, AppError> {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    if hex.is_empty() || hex.len() > 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("invalid object ID".into()));
    }
    Ok(format!("0x{:0>64}", hex.to_ascii_lowercase()))
}
fn same_id(a: &str, b: &str) -> bool {
    match (object_id(a), object_id(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[derive(Deserialize)]
struct OrderbookMarketRow {
    pool_id: String,
    pool_name: String,
    base_asset_id: String,
    base_asset_decimals: Option<i16>,
    base_asset_symbol: Option<String>,
    base_asset_name: Option<String>,
    quote_asset_id: String,
    quote_asset_decimals: Option<i16>,
    quote_asset_symbol: Option<String>,
    quote_asset_name: Option<String>,
    min_size: i64,
    lot_size: i64,
    tick_size: i64,
}

fn orderbook_indexer_base(config: &crate::types::Config) -> Option<String> {
    if let Some(configured) = config.orderbook_indexer_url.as_deref() {
        return Some(configured.trim_end_matches('/').to_string());
    }
    match config.myso_network.trim().to_ascii_lowercase().as_str() {
        "mainnet" => Some("https://orderbook.mainnet.mysocial.network".into()),
        "testnet" => Some("https://orderbook.testnet.mysocial.network".into()),
        _ => None,
    }
}

pub(crate) fn orderbook_indexer_available(config: &crate::types::Config) -> bool {
    let Some(base) = orderbook_indexer_base(config) else {
        return false;
    };
    let Ok(url) = reqwest::Url::parse(&base) else {
        return false;
    };
    url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")))
}

pub(crate) async fn orderbook_markets(state: &AppState) -> Result<Value, AppError> {
    let base = orderbook_indexer_base(&state.config).ok_or_else(|| {
        AppError::Internal("Orderbook Indexer is not configured for this network".into())
    })?;
    let url = reqwest::Url::parse(&format!("{base}/get_pools"))
        .map_err(|_| AppError::Internal("Orderbook Indexer URL is invalid".into()))?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")))
    {
        return Err(AppError::Internal(
            "Orderbook Indexer must use HTTPS except on local loopback".into(),
        ));
    }
    let response = state
        .http_client
        .get(url)
        .header("accept", "application/json")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|_| AppError::Internal("Orderbook market catalog is unavailable".into()))?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "Orderbook market catalog returned {}",
            response.status()
        )));
    }
    let bytes = response.bytes().await.map_err(|_| {
        AppError::Internal("Orderbook market catalog response could not be read".into())
    })?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(AppError::Internal(
            "Orderbook market catalog exceeded the response limit".into(),
        ));
    }
    let rows: Vec<OrderbookMarketRow> = serde_json::from_slice(&bytes).map_err(|_| {
        AppError::Internal("Orderbook market catalog had an unexpected shape".into())
    })?;
    if rows.len() > 2_000 {
        return Err(AppError::Internal(
            "Orderbook market catalog exceeded the row limit".into(),
        ));
    }
    let valid_symbol = |value: &str| {
        !value.is_empty()
            && value.len() <= 32
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    };
    let valid_asset = |value: &str| {
        !value.is_empty()
            && value.len() <= 256
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
    };
    let valid_pool_name = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    };
    let mut markets = Vec::with_capacity(rows.len());
    for row in rows {
        if row.pool_id.is_empty()
            || row.pool_id.len() > 128
            || !valid_pool_name(&row.pool_name)
            || !valid_asset(&row.base_asset_id)
            || !valid_asset(&row.quote_asset_id)
            || row
                .base_asset_symbol
                .as_deref()
                .is_some_and(|value| !valid_symbol(value))
            || row
                .quote_asset_symbol
                .as_deref()
                .is_some_and(|value| !valid_symbol(value))
            || row
                .base_asset_decimals
                .is_some_and(|value| !(0..=18).contains(&value))
            || row
                .quote_asset_decimals
                .is_some_and(|value| !(0..=18).contains(&value))
            || row.min_size < 0
            || row.lot_size <= 0
            || row.tick_size <= 0
        {
            return Err(AppError::Internal(
                "Orderbook market catalog contained an invalid pool row".into(),
            ));
        }
        markets.push(serde_json::json!({
            "poolId": row.pool_id, "poolName": row.pool_name,
            "baseAssetId": row.base_asset_id, "baseSymbol": row.base_asset_symbol,
            "baseName": row.base_asset_name, "baseDecimals": row.base_asset_decimals,
            "quoteAssetId": row.quote_asset_id, "quoteSymbol": row.quote_asset_symbol,
            "quoteName": row.quote_asset_name, "quoteDecimals": row.quote_asset_decimals,
            "minSizeBaseUnits": row.min_size.to_string(), "lotSizeBaseUnits": row.lot_size.to_string(),
            "tickSizeQuoteUnits": row.tick_size.to_string(),
        }));
    }
    Ok(serde_json::json!({
        "network": state.config.myso_network,
        "markets": markets,
        "source": "configured Orderbook Indexer /get_pools",
        "notice": "Indexed pool configuration only; this does not prove current pool pause state, liquidity, live tradability, or execution success. Check live pool state before trading."
    }))
}

async fn orderbook_market_details(state: &AppState, pool_name: &str) -> Result<Value, AppError> {
    let catalog = orderbook_markets(state).await?;
    let market = catalog
        .get("markets")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("poolName").and_then(Value::as_str) == Some(pool_name))
        })
        .cloned()
        .ok_or_else(|| {
            AppError::BadRequest("pool is not in the configured Orderbook market catalog".into())
        })?;
    let pool_id = crate::chain_reads::id(
        market
            .get("poolId")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Internal("Orderbook market catalog is invalid".into()))?,
    )?;
    let pool = crate::chain_reads::object(state, &pool_id).await?;
    if pool.pointer("/owner/Shared").is_none() {
        return Err(AppError::Conflict(
            "Catalog pool is not currently a shared live pool".into(),
        ));
    }
    let pool_type = crate::chain_reads::coin_type(
        pool.pointer("/content/type")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Internal("Orderbook pool type is unavailable".into()))?,
    )?;
    let open = pool_type.find('<').ok_or_else(|| {
        AppError::Conflict("Catalog object is not an Orderbook generic pool".into())
    })?;
    let root = &pool_type[..open];
    if !pool_type.ends_with('>') || !root.ends_with("::pool::Pool") {
        return Err(AppError::Conflict(
            "Catalog object is not an Orderbook v3 pool".into(),
        ));
    }
    let inner = &pool_type[open + 1..pool_type.len() - 1];
    let mut depth = 0i32;
    let split = inner
        .char_indices()
        .find_map(|(i, c)| match c {
            '<' => {
                depth += 1;
                None
            }
            '>' => {
                depth -= 1;
                None
            }
            ',' if depth == 0 => Some(i),
            _ => None,
        })
        .ok_or_else(|| AppError::Conflict("Orderbook pool type arguments are invalid".into()))?;
    let base = crate::chain_reads::coin_type(inner[..split].trim())?;
    let quote = crate::chain_reads::coin_type(inner[split + 1..].trim())?;
    let package_id = crate::chain_reads::id(
        root.split("::")
            .next()
            .ok_or_else(|| AppError::Internal("Orderbook package ID is invalid".into()))?,
    )?;
    if base
        != crate::chain_reads::coin_type(
            market
                .get("baseAssetId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Internal("Orderbook base type is unavailable".into()))?,
        )?
        || quote
            != crate::chain_reads::coin_type(
                market
                    .get("quoteAssetId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::Internal("Orderbook quote type is unavailable".into())
                    })?,
            )?
    {
        return Err(AppError::Conflict(
            "Live pool type no longer matches the Orderbook market catalog".into(),
        ));
    }
    Ok(
        serde_json::json!({"market":market,"poolId":pool_id,"orderbookPackageId":package_id,"poolType":pool_type,"baseAssetType":base,"quoteAssetType":quote,"poolOwner":"shared","source":"configured Orderbook REST catalog plus configured fullnode live object","checkedAtMs":chrono::Utc::now().timestamp_millis()}),
    )
}

fn orderbook_level_value(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.is_empty() && value.len() <= 80 => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

async fn orderbook_snapshot(
    state: &AppState,
    pool_name: &str,
    levels_per_side: u32,
) -> Result<Value, AppError> {
    if pool_name.is_empty()
        || pool_name.len() > 128
        || !pool_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return Err(AppError::BadRequest("invalid orderbook pool name".into()));
    }
    let catalog = orderbook_markets(state).await?;
    let market = catalog
        .get("markets")
        .and_then(Value::as_array)
        .and_then(|markets| {
            markets
                .iter()
                .find(|market| market.get("poolName").and_then(Value::as_str) == Some(pool_name))
        })
        .cloned()
        .ok_or_else(|| {
            AppError::BadRequest("pool is not in the configured Orderbook market catalog".into())
        })?;
    let base = orderbook_indexer_base(&state.config).ok_or_else(|| {
        AppError::Internal("Orderbook Indexer is not configured for this network".into())
    })?;
    let mut url = reqwest::Url::parse(&format!("{base}/orderbook/{pool_name}"))
        .map_err(|_| AppError::Internal("Orderbook Indexer URL is invalid".into()))?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")))
    {
        return Err(AppError::Internal(
            "Orderbook Indexer must use HTTPS except on local loopback".into(),
        ));
    }
    url.query_pairs_mut()
        .append_pair("depth", &(levels_per_side * 2).to_string())
        .append_pair("level", "2");
    let response = state
        .http_client
        .get(url)
        .header("accept", "application/json")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|_| AppError::Internal("Orderbook snapshot is unavailable".into()))?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "Orderbook snapshot returned {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| AppError::Internal("Orderbook snapshot response could not be read".into()))?;
    if bytes.len() > 512 * 1024 {
        return Err(AppError::Internal(
            "Orderbook snapshot exceeded the response limit".into(),
        ));
    }
    let snapshot: Value = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::Internal("Orderbook snapshot had an unexpected shape".into()))?;
    let parse_side = |name: &str| -> Result<Vec<Value>, AppError> {
        let levels = snapshot
            .get(name)
            .and_then(Value::as_array)
            .ok_or_else(|| {
                AppError::Internal("Orderbook snapshot had an unexpected shape".into())
            })?;
        if levels.len() > levels_per_side as usize {
            return Err(AppError::Internal(
                "Orderbook snapshot exceeded the requested depth".into(),
            ));
        }
        levels
            .iter()
            .map(|level| {
                let pair = level
                    .as_array()
                    .filter(|pair| pair.len() == 2)
                    .ok_or_else(|| {
                        AppError::Internal("Orderbook snapshot had an invalid price level".into())
                    })?;
                let price = orderbook_level_value(&pair[0]).ok_or_else(|| {
                    AppError::Internal("Orderbook snapshot had an invalid price".into())
                })?;
                let size = orderbook_level_value(&pair[1]).ok_or_else(|| {
                    AppError::Internal("Orderbook snapshot had an invalid size".into())
                })?;
                Ok(serde_json::json!({"price": price, "size": size}))
            })
            .collect()
    };
    let bids = parse_side("bids")?;
    let asks = parse_side("asks")?;
    Ok(serde_json::json!({
        "network": state.config.myso_network,
        "market": market,
        "bids": bids,
        "asks": asks,
        "levelsPerSide": levels_per_side,
        "source": "configured Orderbook /orderbook endpoint",
        "notice": "Current on-chain pool snapshot returned by the Orderbook service; depth may change before execution and does not guarantee a fill or execution success."
    }))
}

async fn orderbook_market(state: &AppState, pool_name: &str) -> Result<Value, AppError> {
    if pool_name.is_empty()
        || pool_name.len() > 128
        || !pool_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return Err(AppError::BadRequest("invalid orderbook pool name".into()));
    }
    let catalog = orderbook_markets(state).await?;
    catalog
        .get("markets")
        .and_then(Value::as_array)
        .and_then(|markets| {
            markets
                .iter()
                .find(|market| market.get("poolName").and_then(Value::as_str) == Some(pool_name))
        })
        .cloned()
        .ok_or_else(|| {
            AppError::BadRequest("pool is not in the configured Orderbook market catalog".into())
        })
}

async fn orderbook_get_json(
    state: &AppState,
    path: &str,
    query: &[(&str, String)],
    max_bytes: usize,
) -> Result<Value, AppError> {
    let base = orderbook_indexer_base(&state.config).ok_or_else(|| {
        AppError::Internal("Orderbook Indexer is not configured for this network".into())
    })?;
    let mut url = reqwest::Url::parse(&format!("{base}{path}"))
        .map_err(|_| AppError::Internal("Orderbook Indexer URL is invalid".into()))?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")))
    {
        return Err(AppError::Internal(
            "Orderbook Indexer must use HTTPS except on local loopback".into(),
        ));
    }
    url.query_pairs_mut()
        .extend_pairs(query.iter().map(|(key, value)| (*key, value.as_str())));
    let response = state
        .http_client
        .get(url)
        .header("accept", "application/json")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|_| AppError::Internal("Orderbook read is unavailable".into()))?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "Orderbook read returned {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| AppError::Internal("Orderbook response could not be read".into()))?;
    if bytes.len() > max_bytes {
        return Err(AppError::Internal(
            "Orderbook response exceeded the response limit".into(),
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::Internal("Orderbook response had an unexpected shape".into()))
}

async fn orderbook_summary(state: &AppState, pool_name: &str) -> Result<Value, AppError> {
    let market = orderbook_market(state, pool_name).await?;
    let rows = orderbook_get_json(state, "/summary", &[], 2 * 1024 * 1024).await?;
    let rows = rows
        .as_array()
        .ok_or_else(|| AppError::Internal("Orderbook summary had an unexpected shape".into()))?;
    if rows.len() > 2_000 {
        return Err(AppError::Internal(
            "Orderbook summary exceeded the row limit".into(),
        ));
    }
    let summary = rows
        .iter()
        .find(|row| row.get("trading_pairs").and_then(Value::as_str) == Some(pool_name))
        .cloned()
        .ok_or_else(|| AppError::BlobNotFound("market summary unavailable".into()))?;
    Ok(
        serde_json::json!({"network": state.config.myso_network, "market": market, "summary": summary,
        "source": "configured Orderbook /summary", "notice": "Indexed market summary; values can be stale and are not an execution quote or fill guarantee."}),
    )
}

async fn orderbook_ticker(state: &AppState, pool_name: &str) -> Result<Value, AppError> {
    let market = orderbook_market(state, pool_name).await?;
    let ticker = orderbook_get_json(state, "/ticker", &[], 2 * 1024 * 1024).await?;
    let value = ticker
        .get(pool_name)
        .cloned()
        .ok_or_else(|| AppError::BlobNotFound("market ticker unavailable".into()))?;
    Ok(
        serde_json::json!({"network": state.config.myso_network, "market": market, "ticker": value,
        "source": "configured Orderbook /ticker", "notice": "Indexed market ticker; values can be stale and are not an execution quote or fill guarantee."}),
    )
}

async fn orderbook_trades(
    state: &AppState,
    pool_name: &str,
    limit: u32,
) -> Result<Value, AppError> {
    let market = orderbook_market(state, pool_name).await?;
    let trades = orderbook_get_json(
        state,
        &format!("/trades/{pool_name}"),
        &[("limit", limit.clamp(1, 100).to_string())],
        512 * 1024,
    )
    .await?;
    let trades = trades
        .as_array()
        .ok_or_else(|| AppError::Internal("Orderbook trades had an unexpected shape".into()))?;
    if trades.len() > limit as usize || trades.len() > 100 {
        return Err(AppError::Internal(
            "Orderbook trades exceeded the requested limit".into(),
        ));
    }
    Ok(
        serde_json::json!({"network": state.config.myso_network, "market": market, "trades": trades,
        "source": "configured Orderbook /trades", "notice": "Recent indexed trades; records can be delayed and do not guarantee current price or liquidity."}),
    )
}

async fn orderbook_status(state: &AppState) -> Result<Value, AppError> {
    let status = orderbook_get_json(state, "/status", &[], 256 * 1024).await?;
    Ok(
        serde_json::json!({"network": state.config.myso_network, "status": status,
        "source": "configured Orderbook /status", "notice": "Indexer health and checkpoint lag are operational metadata, not proof of market availability or transaction success."}),
    )
}

pub(crate) fn task_receipt_context(
    action: &str,
    parameters: &Value,
    auth: &AuthInfo,
    platform_id: &str,
) -> Result<Option<Value>, AppError> {
    if !action.starts_with("task.") {
        return Ok(None);
    }
    let task_id = if action == "task.create.v1" {
        None
    } else {
        Some(object_id(
            parameters
                .get("taskId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::BadRequest("task action is missing taskId".into()))?,
        )?)
    };
    let seller_agent_id = parameters
        .get("sellerAgentId")
        .and_then(Value::as_str)
        .map(object_id)
        .transpose()?;
    let seller_account_id = if action == "task.create.v1" {
        Some(object_id(
            parameters
                .get("sellerAccountId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::BadRequest("task offer receipt is missing sellerAccountId".into())
                })?,
        )?)
    } else {
        None
    };
    let case_id = parameters
        .get("caseId")
        .and_then(Value::as_str)
        .map(object_id)
        .transpose()?;
    let mut context = serde_json::json!({
        "registryAction": action,
        "taskId": task_id,
        "sellerAgentId": seller_agent_id,
        "sellerAccountId": seller_account_id,
        "caseId": case_id,
        "actingAgentId": object_id(&auth.agent_object_id)?,
        "executionPlatformId": object_id(platform_id)?
    });
    if action == "task.review.v1" {
        let role = parameters.get("raterRole").and_then(Value::as_str)
            .filter(|role| matches!(*role, "buyer" | "seller"))
            .ok_or_else(|| AppError::BadRequest("task review receipt has an invalid raterRole".into()))?;
        let stars = parameters.get("stars").and_then(Value::as_u64)
            .filter(|stars| (1..=5).contains(stars))
            .ok_or_else(|| AppError::BadRequest("task review receipt stars must be from 1 to 5".into()))?;
        let rater_agent_parameter = if role == "buyer" { "buyerAgentId" } else { "sellerAgentId" };
        let rater_agent_id = parameters.get(rater_agent_parameter).and_then(Value::as_str)
            .map(object_id).transpose()?;
        context["raterRole"] = Value::String(role.to_owned());
        context["stars"] = Value::Number(stars.into());
        context["raterPrincipal"] = Value::String(object_id(&auth.owner)?);
        context["raterAgentId"] = serde_json::to_value(rater_agent_id)
            .map_err(|_| AppError::Internal("task review receipt identity is invalid".into()))?;
    }
    if action == "task.create.v1" {
        let amount = parameters
            .get("amountMist")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::BadRequest("task offer receipt is missing amountMist".into())
            })?;
        let amount = crate::chain_reads::u64_value(Some(&Value::String(amount.to_owned())))
            .map_err(|_| AppError::BadRequest("task offer amountMist is invalid".into()))?;
        let digest = parameters
            .get("scopeDigestHex")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::BadRequest("task offer receipt is missing scopeDigestHex".into())
            })?;
        let digest = digest
            .strip_prefix("0x")
            .unwrap_or(digest)
            .to_ascii_lowercase();
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::BadRequest(
                "task offer scopeDigestHex must be 32 bytes".into(),
            ));
        }
        let title = parameters
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::BadRequest("task offer receipt is missing title".into()))?;
        context["buyerPrincipal"] = Value::String(object_id(&auth.owner)?);
        context["buyerMemoryAccountId"] = Value::String(object_id(&auth.account_id)?);
        context["buyerAgentId"] = Value::String(object_id(&auth.agent_object_id)?);
        context["amountMist"] = Value::String(amount.to_string());
        context["scopeDigestHex"] = Value::String(digest);
        context["title"] = Value::String(title.to_owned());
        for (parameter, field) in [
            ("acceptWindowMs", "acceptWindowMs"),
            ("deliveryWindowMs", "deliveryWindowMs"),
            ("settleWindowMs", "settleWindowMs"),
        ] {
            let value = parameters
                .get(parameter)
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::BadRequest(format!("task offer receipt is missing {parameter}"))
                })?;
            let value = crate::chain_reads::u64_value(Some(&Value::String(value.to_owned())))
                .map_err(|_| AppError::BadRequest(format!("task offer {parameter} is invalid")))?;
            context[field] = Value::String(value.to_string());
        }
        context["roomGroupId"] = parameters
            .get("roomGroupId")
            .and_then(Value::as_str)
            .map(object_id)
            .transpose()?
            .map(Value::String)
            .unwrap_or(Value::Null);
    }
    if action == "task.deliver.v1" {
        let digest = parameters
            .get("digestHex")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::BadRequest("task delivery receipt is missing digestHex".into())
            })?;
        let digest = digest
            .strip_prefix("0x")
            .unwrap_or(digest)
            .to_ascii_lowercase();
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::BadRequest(
                "task delivery digestHex must be 32 bytes".into(),
            ));
        }
        let uri = parameters
            .get("uri")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 2048)
            .ok_or_else(|| {
                AppError::BadRequest("task delivery receipt is missing a valid URI".into())
            })?;
        context["deliverableDigestHex"] = Value::String(digest);
        context["deliverableUri"] = Value::String(uri.to_owned());
    }
    Ok(Some(context))
}

pub(crate) fn task_room_binding_receipt_context(
    parameters: &Value,
    auth: &AuthInfo,
    platform_id: &str,
) -> Result<Option<Value>, AppError> {
    let group_id = parameters
        .get("groupId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("room binding receipt is missing groupId".into()))?;
    let task_id = parameters
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("room binding receipt is missing taskId".into()))?;
    Ok(Some(serde_json::json!({
        "registryAction": "messaging.bind_room_to_task.v1",
        "groupId": object_id(group_id)?,
        "taskId": object_id(task_id)?,
        "actingAgentId": object_id(&auth.agent_object_id)?,
        "actingPrincipal": object_id(&auth.owner)?,
        "executionPlatformId": object_id(platform_id)?
    })))
}

pub(crate) fn messaging_group_creation_receipt_context(
    parameters: &Value,
    auth: &AuthInfo,
    platform_id: &str,
    sender: &str,
) -> Result<Option<Value>, AppError> {
    let name=parameters.get("name").and_then(Value::as_str).filter(|value|!value.is_empty()&&value.len()<=1024)
        .ok_or_else(||AppError::BadRequest("group creation receipt is missing a valid name".into()))?;
    let uuid=parameters.get("uuid").and_then(Value::as_str).filter(|value|!value.is_empty()&&value.len()<=128)
        .ok_or_else(||AppError::BadRequest("group creation receipt is missing a valid UUID".into()))?;
    Ok(Some(serde_json::json!({
        "registryAction":"messaging.create_group.v1",
        "groupName":name,
        "groupUuid":uuid,
        "sender":object_id(sender)?,
        "actingAgentId":object_id(&auth.agent_object_id)?,
        "actingPrincipal":object_id(&auth.owner)?,
        "executionPlatformId":object_id(platform_id)?
    })))
}

pub(crate) async fn messaging_group_creation_receipt(
    state:&AppState,
    auth:&AuthInfo,
    digest:&str,
)->Result<Value,AppError>{
    crate::chain_reads::digest_bytes(digest).map_err(|_|AppError::BadRequest("Invalid group creation receipt digest".into()))?;
    let row=crate::chain_actions::get_by_digest(&state.db,&auth.account_id,&auth.agent_object_id,digest).await?
        .filter(|row|row.registry_action=="messaging.create_group.v1")
        .ok_or_else(||AppError::BlobNotFound("Group creation receipt is outside this account/agent scope".into()))?;
    let context=row.receipt_context.as_ref().ok_or_else(||AppError::Conflict("Prepared group creation receipt context is unavailable".into()))?;
    let package=object_id(&state.config.social_chain.messaging_package_id)?;
    if !same_id(&row.package_id,&package)
        || context["registryAction"].as_str()!=Some("messaging.create_group.v1")
        || !context["actingAgentId"].as_str().is_some_and(|id|same_id(id,&auth.agent_object_id))
        || !context["actingPrincipal"].as_str().is_some_and(|id|same_id(id,&auth.owner))
        || !context["executionPlatformId"].as_str().is_some_and(|id|same_id(id,&state.config.social_chain.platform_object_id))
        || !context["sender"].as_str().is_some_and(|id|same_id(id,&row.sender))
    { return Err(AppError::BlobNotFound("Group creation receipt is outside this platform or agent scope".into())); }
    let transaction=crate::chain_reads::rpc(state,"myso_getTransactionBlock",serde_json::json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;
    if transaction["digest"].as_str()!=Some(digest){return Err(AppError::Internal("Invalid group creation transaction evidence".into()));}
    let sender=transaction.pointer("/transaction/data/sender").or_else(||transaction.pointer("/transaction/sender")).and_then(Value::as_str)
        .ok_or_else(||AppError::Internal("Group creation transaction sender is unavailable".into()))?;
    if !same_id(sender,&row.sender)||!same_id(sender,context["sender"].as_str().unwrap_or("")) {return Err(AppError::Conflict("Group creation transaction sender does not match its prepared action".into()));}
    let checkpoint=transaction.get("checkpoint").filter(|value|!value.is_null());
    let status=match transaction.pointer("/effects/status/status").and_then(Value::as_str){Some("success") if checkpoint.is_some()=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"};
    let events=transaction.get("events").and_then(Value::as_array).ok_or_else(||AppError::Internal("Group creation transaction events are unavailable".into()))?;
    let event_type=format!("{package}::messaging::AgentGroupCreated");
    let mut matches=Vec::new();
    for event in events {
        if event.get("type").and_then(Value::as_str)!=Some(event_type.as_str()){continue;}
        let Some(data)=event.get("parsedJson") else {continue;};
        let optional_id=|value:Option<&Value>|->Option<String>{
            match value? {
                Value::Null=>None,
                Value::String(text)=>Some(text.clone()),
                other=>other.get("id").and_then(Value::as_str).or_else(||other.get("vec").and_then(Value::as_array).filter(|items|items.len()==1).and_then(|items|items[0].as_str().or_else(||items[0].get("id").and_then(Value::as_str)))).map(str::to_owned)
                    .or_else(||other.get("fields").and_then(|fields|fields.get("id")).and_then(Value::as_str).map(str::to_owned))
                    .or_else(||other.get("fields").and_then(|fields|fields.get("vec")).and_then(Value::as_array).filter(|items|items.len()==1).and_then(|items|items[0].as_str().or_else(||items[0].get("id").and_then(Value::as_str))).map(str::to_owned))
            }
        };
        let group_id=optional_id(data.get("group_id"));
        let organization_id=optional_id(data.get("organization_id"));
        if group_id.as_deref().is_some_and(|id|object_id(id).is_ok())
            && data.get("group_name").and_then(Value::as_str)==context["groupName"].as_str()
            && data.get("group_uuid").and_then(Value::as_str)==context["groupUuid"].as_str()
            && data.get("creator_actor").and_then(Value::as_str).is_some_and(|id|same_id(id,sender))
            && data.get("creator_principal").and_then(Value::as_str).is_some_and(|id|same_id(id,&auth.owner))
            && optional_id(data.get("creator_sub_agent_id")).as_deref().is_some_and(|id|same_id(id,&auth.agent_object_id))
            && data.get("creator_identity_class").and_then(Value::as_u64).is_some_and(|value|value<=2)
        { matches.push(serde_json::json!({"type":event_type,"data":{
            "group_id":group_id,
            "creator_actor":data.get("creator_actor"),
            "creator_principal":data.get("creator_principal"),
            "creator_sub_agent_id":optional_id(data.get("creator_sub_agent_id")),
            "creator_identity_class":data.get("creator_identity_class"),
            "organization_id":organization_id,
            "group_name":data.get("group_name"),
            "group_uuid":data.get("group_uuid"),
            "created_at":data.get("created_at")
        }})); }
    }
    if status=="finalized"&&matches.len()!=1{return Err(AppError::Conflict("No unique finalized AgentGroupCreated event matched the prepared group and creator".into()));}
    let group_id=matches.first().and_then(|event|event.pointer("/data/group_id")).and_then(|value|value.as_str().map(str::to_owned).or_else(||value.get("id").and_then(Value::as_str).map(str::to_owned)));
    let checkpoint=checkpoint.and_then(|value|value.as_str().map(str::to_owned).or_else(||value.as_u64().map(|number|number.to_string())));
    Ok(serde_json::json!({"digest":digest,"registryAction":"messaging.create_group.v1","groupId":group_id,"groupName":context["groupName"],"groupUuid":context["groupUuid"],"status":status,"checkpoint":checkpoint,"events":matches,"evidenceSource":"configured_fullnode_and_scoped_action_record"}))
}

pub(crate) async fn messaging_membership_change_receipt(
    state:&AppState,
    auth:&AuthInfo,
    digest:&str,
)->Result<Value,AppError>{
    crate::chain_reads::digest_bytes(digest).map_err(|_|AppError::BadRequest("Invalid room membership receipt digest".into()))?;
    let transaction=crate::chain_reads::rpc(state,"myso_getTransactionBlock",serde_json::json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;
    if transaction["digest"].as_str()!=Some(digest){return Err(AppError::Internal("Invalid room membership transaction evidence".into()));}
    let sender=transaction.pointer("/transaction/data/sender").or_else(||transaction.pointer("/transaction/sender")).and_then(Value::as_str)
        .ok_or_else(||AppError::Internal("Room membership transaction sender is unavailable".into()))?;
    if !same_id(sender,&auth.derived_address){return Err(AppError::BlobNotFound("Room membership receipt is outside this authenticated agent".into()));}
    let checkpoint=transaction.get("checkpoint").filter(|value|!value.is_null());
    let status=match transaction.pointer("/effects/status/status").and_then(Value::as_str){Some("success") if checkpoint.is_some()=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"};
    let messaging_package=object_id(&state.config.social_chain.messaging_package_id)?;
    let events=transaction.get("events").and_then(Value::as_array).ok_or_else(||AppError::Internal("Room membership transaction events are unavailable".into()))?;
    if events.len()>512{return Err(AppError::Internal("Room membership transaction exceeded the event bound".into()));}
    let mut group_id:Option<String>=None;
    let mut removed=Vec::new();
    let mut granted:HashMap<String,HashSet<String>>=HashMap::new();
    let mut key_rotation:Option<Value>=None;
    let mut public_events=Vec::new();
    let framework_event=|ty:&str,name:&str| {
        let mut parts=ty.split("::");
        let package=parts.next();
        let module=parts.next();
        let event=parts.next().unwrap_or("");
        let Some((event_name,generic))=event.split_once('<') else{return false;};
        let generic=generic.strip_suffix('>').unwrap_or("");
        let mut generic_parts=generic.split("::");
        package.is_some_and(|id|same_id(id,"0x2"))&&module==Some("permissioned_group")&&event_name==name
            &&generic_parts.next().is_some_and(|id|same_id(id,&messaging_package))
            &&generic_parts.next()==Some("messaging")&&generic_parts.next()==Some("Messaging")&&generic_parts.next().is_none()
    };
    for event in events {
        let Some(ty)=event.get("type").and_then(Value::as_str) else {continue;};
        let Some(data)=event.get("parsedJson") else {continue;};
        if framework_event(ty,"MemberRemoved") {
            let id=data.get("group_id").and_then(|value|value.as_str().or_else(||value.get("id").and_then(Value::as_str))).ok_or_else(||AppError::Internal("Room removal event omitted group ID".into()))?;
            let member=data.get("member").and_then(Value::as_str).ok_or_else(||AppError::Internal("Room removal event omitted member".into()))?;
            let id=object_id(id)?;let member=object_id(member)?;
            if group_id.as_deref().is_some_and(|expected|!same_id(expected,&id)){return Err(AppError::Conflict("Room membership transaction changed multiple groups".into()));}
            group_id=Some(id.clone());removed.push(member.clone());
            public_events.push(serde_json::json!({"type":"MemberRemoved","groupId":id,"member":member,"permissions":[]}));
            if public_events.len()>256{return Err(AppError::Internal("Room membership receipt exceeded the event bound".into()));}
        } else if framework_event(ty,"PermissionsGranted") {
            let id=data.get("group_id").and_then(|value|value.as_str().or_else(||value.get("id").and_then(Value::as_str))).ok_or_else(||AppError::Internal("Room permission event omitted group ID".into()))?;
            let member=data.get("member").and_then(Value::as_str).ok_or_else(||AppError::Internal("Room permission event omitted member".into()))?;
            let id=object_id(id)?;let member=object_id(member)?;
            if group_id.as_deref().is_some_and(|expected|!same_id(expected,&id)){return Err(AppError::Conflict("Room membership transaction changed multiple groups".into()));}
            group_id=Some(id.clone());
            let permissions=data.get("permissions").and_then(Value::as_array).ok_or_else(||AppError::Internal("Room permission event omitted permission types".into()))?;
            if permissions.len()>32{return Err(AppError::Internal("Room permission event exceeded its bound".into()));}
            let mut names=Vec::new();
            for permission in permissions {
                let name=permission.as_str().or_else(||permission.get("name").and_then(Value::as_str)).ok_or_else(||AppError::Internal("Room permission event contains an invalid type name".into()))?;
                if name.len()>512{return Err(AppError::Internal("Room permission type name exceeded its bound".into()));}
                names.push(name.to_owned());granted.entry(member.clone()).or_default().insert(name.to_owned());
            }
            public_events.push(serde_json::json!({"type":"PermissionsGranted","groupId":id,"member":member,"permissions":names}));
            if public_events.len()>256{return Err(AppError::Internal("Room membership receipt exceeded the event bound".into()));}
        } else if {
            let mut parts=ty.split("::");
            parts.next().is_some_and(|id|same_id(id,&messaging_package))&&parts.next()==Some("encryption_history")&&parts.next()==Some("EncryptionKeyRotated")
        } {
            let id=data.get("group_id").and_then(|value|value.as_str().or_else(||value.get("id").and_then(Value::as_str))).ok_or_else(||AppError::Internal("Room key rotation event omitted group ID".into()))?;
            if group_id.as_deref().is_some_and(|expected|!same_id(expected,id)){return Err(AppError::Conflict("Room membership transaction changed multiple groups".into()));}
            group_id=Some(object_id(id)?);
            if key_rotation.is_some(){return Err(AppError::Conflict("Room membership transaction rotated multiple encryption histories".into()));}
            let history_id=data.get("encryption_history_id").and_then(Value::as_str).or_else(||data.get("encryption_history_id").and_then(|value|value.get("id")).and_then(Value::as_str)).ok_or_else(||AppError::Internal("Room key rotation event omitted encryption history ID".into()))?;
            let history_id=object_id(history_id)?;
            let new_version=data.get("new_key_version").and_then(|value|value.as_u64().map(|number|number.to_string()).or_else(||value.as_str().map(str::to_owned))).ok_or_else(||AppError::Internal("Room key rotation event omitted new key version".into()))?;
            key_rotation=Some(serde_json::json!({"encryptionHistoryId":history_id,"newKeyVersion":new_version}));
        }
    }
    if (status=="failed"||status=="unknown")&&(!public_events.is_empty()||key_rotation.is_some()){
        return Err(AppError::Internal("Room membership transaction status does not support event evidence".into()));
    }
    let actor=object_id(&auth.derived_address)?;
    let kind=if !removed.is_empty()&&key_rotation.is_some(){
        if removed.len()>50||public_events.len()!=removed.len()||public_events.iter().any(|event|event["type"]!="MemberRemoved"){
            return Err(AppError::Conflict("Room removal receipt contains unexpected membership events".into()));
        }
        let mut unique=HashSet::new();
        if removed.iter().any(|member|!unique.insert(member.to_lowercase())){return Err(AppError::Conflict("Room removal receipt contains duplicate members".into()));}
        if removed.iter().any(|member|same_id(member,&actor)){return Err(AppError::Conflict("Room removal receipt contains the acting agent".into()));}
        Some("remove_and_rotate")
    }else if removed.len()==1&&public_events.len()==1&&same_id(&removed[0],&actor)&&key_rotation.is_none(){Some("leave")}
    else if removed.is_empty()&&key_rotation.is_none()&&!granted.is_empty(){
        if public_events.iter().any(|event|event["type"]!="PermissionsGranted"){return Err(AppError::Conflict("Room invitation receipt contains unexpected membership events".into()));}
        let has_permission=|permissions:&HashSet<String>,name:&str|permissions.iter().any(|permission|{
            let suffix=format!("::messaging::{name}");
            permission.strip_suffix(&suffix).is_some_and(|package|same_id(package,&messaging_package))
        });
        if granted.values().any(|permissions|!has_permission(permissions,"MessagingReader")||!has_permission(permissions,"MessagingSender")){
            return Err(AppError::Conflict("Room invitation receipt did not grant both reader and sender permissions".into()));
        }
        Some("invite")
    }else{None};
    let mut member_list:Vec<String>=if kind==Some("leave"){vec![actor.clone()]}else if kind==Some("invite"){granted.keys().cloned().collect()}else{removed};
    member_list.sort();
    if member_list.len()>50{return Err(AppError::Internal("Room membership receipt exceeded the member bound".into()));}
    let key_rotation=key_rotation.unwrap_or(Value::Null);
    let checkpoint=checkpoint.and_then(|value|value.as_str().map(str::to_owned).or_else(||value.as_u64().map(|number|number.to_string())));
    Ok(serde_json::json!({"digest":digest,"status":status,"kind":kind,"groupId":group_id,"actor":actor,"members":member_list,"keyRotation":key_rotation,"events":public_events,"checkpoint":checkpoint,"evidenceSource":"configured_fullnode_transaction_events"}))
}

pub(crate) async fn task_room_binding_receipt(
    state: &AppState,
    auth: &AuthInfo,
    digest: &str,
) -> Result<Value, AppError> {
    crate::chain_reads::digest_bytes(digest)
        .map_err(|_| AppError::BadRequest("Invalid room binding receipt digest".into()))?;
    let row = crate::chain_actions::get_by_digest(
        &state.db,
        &auth.account_id,
        &auth.agent_object_id,
        digest,
    )
    .await?
    .filter(|row| row.registry_action == "messaging.bind_room_to_task.v1")
    .ok_or_else(|| {
        AppError::BlobNotFound("Room binding receipt is outside this account/agent scope".into())
    })?;
    let context = row.receipt_context.as_ref().ok_or_else(|| {
        AppError::Conflict("Prepared room binding receipt context is unavailable".into())
    })?;
    if context["registryAction"].as_str() != Some("messaging.bind_room_to_task.v1")
        || !context["actingAgentId"]
            .as_str()
            .is_some_and(|id| same_id(id, &auth.agent_object_id))
        || !context["actingPrincipal"]
            .as_str()
            .is_some_and(|id| same_id(id, &auth.owner))
        || !context["executionPlatformId"]
            .as_str()
            .is_some_and(|id| same_id(id, &state.config.social_chain.platform_object_id))
    {
        return Err(AppError::BlobNotFound(
            "Room binding receipt is outside this platform or agent scope".into(),
        ));
    }
    let transaction = crate::chain_reads::rpc(
        state,
        "myso_getTransactionBlock",
        serde_json::json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if transaction["digest"].as_str() != Some(digest) {
        return Err(AppError::Internal(
            "Invalid room binding transaction evidence".into(),
        ));
    }
    let sender = transaction
        .pointer("/transaction/data/sender")
        .or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Internal("Room binding transaction sender is unavailable".into())
        })?;
    if !same_id(sender, &row.sender) {
        return Err(AppError::Conflict(
            "Room binding transaction sender does not match its prepared action".into(),
        ));
    }
    let checkpoint = transaction
        .get("checkpoint")
        .filter(|value| !value.is_null());
    let status = match transaction
        .pointer("/effects/status/status")
        .and_then(Value::as_str)
    {
        Some("success") if checkpoint.is_some() => "finalized",
        Some("success") => "checkpoint_pending",
        Some("failure") => "failed",
        _ => "unknown",
    };
    fn event_id(value: Option<&Value>) -> Option<&str> {
        value.and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("id").and_then(Value::as_str))
        })
    }
    let package = object_id(&row.package_id)?;
    let mut matches = Vec::new();
    let events = transaction
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::Internal("Room binding transaction events are unavailable".into())
        })?;
    for event in events {
        let Some(ty) = event.get("type").and_then(Value::as_str) else {
            continue;
        };
        let mut parts = ty.split("::");
        let (Some(event_package), Some(module), Some(name)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if parts.next().is_some()
            || module != "messaging"
            || name != "AgentRoomTaskBound"
            || !same_id(event_package, &package)
        {
            continue;
        }
        let parsed = event
            .get("parsedJson")
            .ok_or_else(|| AppError::Internal("Room binding event data is unavailable".into()))?;
        let matched = event_id(parsed.get("group_id"))
            .zip(context["groupId"].as_str())
            .is_some_and(|(a, b)| same_id(a, b))
            && event_id(parsed.get("task_id"))
                .zip(context["taskId"].as_str())
                .is_some_and(|(a, b)| same_id(a, b))
            && parsed
                .get("binder_actor")
                .and_then(Value::as_str)
                .is_some_and(|id| same_id(id, &auth.derived_address))
            && parsed
                .get("binder_principal")
                .and_then(Value::as_str)
                .is_some_and(|id| same_id(id, &auth.owner));
        if matched {
            matches.push(serde_json::json!({"type":ty,"data":parsed}));
        }
    }
    if status == "finalized" && matches.len() != 1 {
        return Err(AppError::Conflict(
            "No unique AgentRoomTaskBound event matched the prepared task and room".into(),
        ));
    }
    Ok(
        serde_json::json!({"digest":digest,"registryAction":row.registry_action,"groupId":context["groupId"],"taskId":context["taskId"],"status":status,"events":matches,"evidenceSource":"configured_fullnode_and_scoped_action_record","verification":if status == "finalized" {"finalized_agent_room_task_bound_event"} else {"task_room_binding_not_finalized"}}),
    )
}

/// Receipt identity for the jury actions that directly drive juror assignment, voting, rounds,
/// and case finality. Other `jury.*` actions use their subject-specific event readers.
pub(crate) fn jury_receipt_context(
    action: &str,
    parameters: &Value,
    agent_id: &str,
    platform_id: &str,
) -> Result<Option<Value>, AppError> {
    let supported = matches!(
        action,
        "jury.accept.v1"
            | "jury.commit_vote.v1"
            | "jury.reveal_vote.v1"
            | "jury.claim_fee.v1"
            | "jury.select_jury.v1"
            | "jury.replace_no_shows.v1"
            | "jury.finalize_round.v1"
            | "jury.finalize_case.v1"
            | "jury.execute_task_verdict.v1"
            | "jury.start_neutral_resolution.v1"
            | "jury.execute_neutral_resolution.v1"
            | "jury.settle_dispute_fees.v1"
            | "jury.escalate_proposal.v1"
            | "jury.finalize_proposal.v1"
            | "jury.apply_proposal_decision.v1"
            | "jury.sweep_vote_refunds.v1"
            | "jury.sweep_case.v1"
            | "jury.refresh_roster_entry.v1"
            | "jury.evict_ineligible.v1"
    );
    if !supported {
        return Ok(None);
    }
    let required_id = |key: &str| -> Result<String, AppError> {
        object_id(
            parameters
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::BadRequest(format!("jury action is missing {key}")))?,
        )
    };
    let case_id = if matches!(
        action,
        "jury.accept.v1"
            | "jury.commit_vote.v1"
            | "jury.reveal_vote.v1"
            | "jury.claim_fee.v1"
            | "jury.select_jury.v1"
            | "jury.replace_no_shows.v1"
            | "jury.finalize_round.v1"
            | "jury.finalize_case.v1"
            | "jury.execute_task_verdict.v1"
            | "jury.start_neutral_resolution.v1"
            | "jury.settle_dispute_fees.v1"
            | "jury.apply_proposal_decision.v1"
            | "jury.sweep_case.v1"
    ) {
        Some(required_id("caseId")?)
    } else {
        None
    };
    let task_id = if matches!(
        action,
        "jury.execute_task_verdict.v1"
            | "jury.start_neutral_resolution.v1"
            | "jury.execute_neutral_resolution.v1"
            | "jury.settle_dispute_fees.v1"
    ) {
        Some(required_id("taskId")?)
    } else {
        None
    };
    let proposal_id = if matches!(
        action,
        "jury.escalate_proposal.v1"
            | "jury.finalize_proposal.v1"
            | "jury.apply_proposal_decision.v1"
            | "jury.sweep_vote_refunds.v1"
    ) {
        Some(required_id("proposalId")?)
    } else {
        None
    };
    let registry_id = if proposal_id.is_some() {
        Some(required_id("registryId")?)
    } else {
        None
    };
    let juror_id = if matches!(
        action,
        "jury.accept.v1" | "jury.commit_vote.v1" | "jury.reveal_vote.v1" | "jury.claim_fee.v1"
    ) {
        Some(required_id("agentId")?)
    } else {
        None
    };
    let subject_agent_id = if matches!(
        action,
        "jury.refresh_roster_entry.v1" | "jury.evict_ineligible.v1"
    ) {
        Some(required_id("agentId")?)
    } else {
        None
    };
    let roster_owner_account_id = if action == "jury.refresh_roster_entry.v1" {
        Some(required_id("accountId")?)
    } else {
        None
    };
    if matches!(
        action,
        "jury.accept.v1" | "jury.commit_vote.v1" | "jury.reveal_vote.v1" | "jury.claim_fee.v1"
    ) && juror_id.as_deref().is_none_or(|id| !same_id(id, agent_id))
    {
        return Err(AppError::Forbidden(
            "jury receipt agent must be the authenticated juror".into(),
        ));
    }
    let mut context = serde_json::json!({
        "registryAction": action,
        "actingAgentId": object_id(agent_id)?,
        "executionPlatformId": object_id(platform_id)?
    });
    if let Some(case_id) = case_id {
        context["caseId"] = Value::String(case_id);
    }
    if let Some(task_id) = task_id {
        context["taskId"] = Value::String(task_id);
    }
    if let Some(proposal_id) = proposal_id {
        context["proposalId"] = Value::String(proposal_id);
    }
    if let Some(registry_id) = registry_id {
        context["registryId"] = Value::String(registry_id);
    }
    if let Some(agent_id) = subject_agent_id {
        context["subjectAgentId"] = Value::String(agent_id);
    }
    if let Some(account_id) = roster_owner_account_id {
        context["rosterOwnerAccountId"] = Value::String(account_id);
    }
    if action == "jury.escalate_proposal.v1" {
        let stage = crate::chain_reads::u64_value(parameters.get("stage"))
            .map_err(|_| AppError::BadRequest("jury proposal stage must fit u8".into()))?;
        if stage > u8::MAX as u64 {
            return Err(AppError::BadRequest(
                "jury proposal stage must fit u8".into(),
            ));
        }
        context["stage"] = Value::Number(stage.into());
    }
    if let Some(juror_id) = juror_id {
        context["jurorId"] = Value::String(juror_id);
    }
    let digest_hex = |key: &str| -> Result<String, AppError> {
        let raw = parameters
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::BadRequest(format!("jury action is missing {key}")))?;
        let normalized = raw.strip_prefix("0x").unwrap_or(raw).to_ascii_lowercase();
        if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::BadRequest(format!(
                "jury {key} must be a 32-byte hex digest"
            )));
        }
        Ok(normalized)
    };
    if action == "jury.commit_vote.v1" {
        context["commitmentHex"] = Value::String(digest_hex("commitmentHex")?);
    }
    if action == "jury.reveal_vote.v1" {
        let outcome = crate::chain_reads::u64_value(parameters.get("outcome"))
            .map_err(|_| AppError::BadRequest("jury outcome must fit u8".into()))?;
        if outcome > u8::MAX as u64 {
            return Err(AppError::BadRequest("jury outcome must fit u8".into()));
        }
        let refs = parameters
            .get("evidenceRefs")
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::BadRequest("jury reveal is missing evidenceRefs".into()))?
            .iter()
            .map(|value| {
                crate::chain_reads::u64_value(Some(value))
                    .map(|value| Value::String(value.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        context["outcome"] = Value::Number(outcome.into());
        context["rationaleDigestHex"] = Value::String(digest_hex("rationaleDigestHex")?);
        context["evidenceRefs"] = Value::Array(refs);
        context["bundleDigestHex"] = Value::String(digest_hex("bundleDigestHex")?);
    }
    Ok(Some(context))
}

pub(crate) fn governance_vote_receipt_context(
    parameters: &Value,
    owner: &str,
    platform_id: &str,
) -> Result<Option<Value>, AppError> {
    let proposal_id = parameters
        .get("proposalId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Governance vote is missing proposalId".into()))?;
    let registry_id = parameters
        .get("registryId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Governance vote is missing registryId".into()))?;
    let vote_count = crate::chain_reads::u64_value(parameters.get("voteCount")).map_err(|_| {
        AppError::BadRequest("Governance vote voteCount must be a decimal u64".into())
    })?;
    if vote_count == 0 {
        return Err(AppError::BadRequest(
            "Governance vote voteCount must be positive".into(),
        ));
    }
    let approve = parameters
        .get("approve")
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::BadRequest("Governance vote approve must be boolean".into()))?;
    Ok(Some(serde_json::json!({
        "registryId": crate::chain_reads::id(registry_id)?,
        "proposalId": crate::chain_reads::id(proposal_id)?,
        "voteCount": vote_count.to_string(),
        "approve": approve,
        "voter": crate::chain_reads::id(owner)?,
        "executionPlatformId": crate::chain_reads::id(platform_id)?
    })))
}

pub(crate) fn governance_delegate_vote_receipt_context(
    parameters: &Value,
    owner: &str,
    platform_id: &str,
) -> Result<Option<Value>, AppError> {
    let registry_id = parameters
        .get("registryId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Delegate vote is missing registryId".into()))?;
    let proposal_id = parameters
        .get("proposalId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Delegate vote is missing proposalId".into()))?;
    let route = parameters
        .get("route")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "ecosystem" | "platform"))
        .ok_or_else(|| {
            AppError::BadRequest("Delegate vote route must be ecosystem or platform".into())
        })?;
    let approve = parameters
        .get("approve")
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::BadRequest("Delegate vote approve must be boolean".into()))?;
    let reason = match parameters.get("reason") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(text)) if !text.is_empty() && text.len() <= 1000 => {
            Value::String(text.clone())
        }
        _ => {
            return Err(AppError::BadRequest(
                "Delegate vote reason must contain 1–1000 characters when supplied".into(),
            ))
        }
    };
    Ok(Some(serde_json::json!({
        "registryId": crate::chain_reads::id(registry_id)?,
        "proposalId": crate::chain_reads::id(proposal_id)?,
        "route": route,
        "approve": approve,
        "reason": reason,
        "delegate": crate::chain_reads::id(owner)?,
        "executionPlatformId": crate::chain_reads::id(platform_id)?
    })))
}

async fn governance_vote_receipt(
    state: &AppState,
    auth: &AuthInfo,
    digest: &str,
) -> Result<Value, AppError> {
    use crate::chain_reads::{coin_type, digest_bytes, rpc, same, u64_value};
    digest_bytes(digest)
        .map_err(|_| AppError::BadRequest("Invalid governance vote receipt digest".into()))?;
    let row = crate::chain_actions::get_by_digest(
        &state.db,
        &auth.account_id,
        &auth.agent_object_id,
        digest,
    )
    .await?
    .filter(|row| {
        row.registry_action == "governance.vote.v1"
            && same(&row.package_id, &state.config.package_id)
    })
    .ok_or_else(|| {
        AppError::BlobNotFound("Governance vote receipt is outside this account/agent scope".into())
    })?;
    let context = row.receipt_context.as_ref().ok_or_else(|| {
        AppError::Conflict("Prepared governance vote context is unavailable".into())
    })?;
    if !same(
        context["voter"]
            .as_str()
            .ok_or_else(|| AppError::Internal("Invalid governance vote context".into()))?,
        &auth.owner,
    ) || !same(
        context["executionPlatformId"]
            .as_str()
            .ok_or_else(|| AppError::Internal("Invalid governance vote context".into()))?,
        &state.config.social_chain.platform_object_id,
    ) {
        return Err(AppError::BlobNotFound(
            "Governance vote receipt is outside this principal or platform".into(),
        ));
    }
    let transaction = rpc(
        state,
        "myso_getTransactionBlock",
        serde_json::json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if transaction["digest"].as_str() != Some(digest) {
        return Err(AppError::Internal(
            "Invalid governance vote transaction evidence".into(),
        ));
    }
    let sender = transaction
        .pointer("/transaction/data/sender")
        .or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Governance vote sender is unavailable".into()))?;
    if !same(sender, &auth.owner) || !same(sender, &row.sender) {
        return Err(AppError::Conflict(
            "Governance vote sender does not match its approving principal".into(),
        ));
    }
    let status = transaction
        .pointer("/effects/status/status")
        .and_then(Value::as_str);
    let checkpoint = transaction
        .get("checkpoint")
        .filter(|value| !value.is_null());
    let finalized = status == Some("success") && checkpoint.is_some();
    let expected_type = coin_type(&format!(
        "{}::governance::CommunityVoteEvent",
        state.config.package_id
    ))?;
    let events = transaction
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Internal("Governance vote events are unavailable".into()))?;
    let matches = events
        .iter()
        .filter(|event| {
            event
                .get("type")
                .and_then(Value::as_str)
                .and_then(|value| coin_type(value).ok())
                .as_deref()
                == Some(expected_type.as_str())
        })
        .filter(|event| {
            let data = &event["parsedJson"];
            same(
                data["proposal_id"].as_str().unwrap_or(""),
                context["proposalId"].as_str().unwrap_or(""),
            ) && same(
                data["voter"].as_str().unwrap_or(""),
                context["voter"].as_str().unwrap_or(""),
            ) && u64_value(data.get("vote_weight")).ok() == u64_value(context.get("voteCount")).ok()
                && data["approve"].as_bool() == context["approve"].as_bool()
        })
        .collect::<Vec<_>>();
    if finalized && matches.len() != 1 {
        return Err(AppError::Conflict(
            "Unique exact governance vote event could not be verified".into(),
        ));
    }
    let vote = matches.first().map(|event| &event["parsedJson"]).map(|data| {
        Ok::<Value, AppError>(serde_json::json!({
            "proposal_id": data.get("proposal_id").and_then(Value::as_str).ok_or_else(|| AppError::Internal("Governance vote proposal ID is unavailable".into()))?,
            "voter": data.get("voter").and_then(Value::as_str).ok_or_else(|| AppError::Internal("Governance vote voter is unavailable".into()))?,
            "vote_weight": u64_value(data.get("vote_weight"))?.to_string(),
            "approve": data.get("approve").and_then(Value::as_bool).ok_or_else(|| AppError::Internal("Governance vote choice is unavailable".into()))?,
            "vote_time": u64_value(data.get("vote_time"))?.to_string(),
            "vote_cost": u64_value(data.get("vote_cost"))?.to_string(),
        }))
    }).transpose()?;
    Ok(serde_json::json!({
        "digest": digest,
        "registryAction": "governance.vote.v1",
        "status": match status { Some("success") if finalized => "finalized", Some("success") => "checkpoint_pending", Some("failure") => "failed", _ => "unknown" },
        "checkpoint": checkpoint.map(Value::to_string),
        "vote": vote,
        "evidenceSource": "configured_fullnode_and_scoped_preparation"
    }))
}

async fn governance_delegate_vote_receipt(
    state: &AppState,
    auth: &AuthInfo,
    digest: &str,
) -> Result<Value, AppError> {
    use crate::chain_reads::{coin_type, digest_bytes, rpc, same, u64_value};
    digest_bytes(digest)
        .map_err(|_| AppError::BadRequest("Invalid delegate vote receipt digest".into()))?;
    let row = crate::chain_actions::get_by_digest(
        &state.db,
        &auth.account_id,
        &auth.agent_object_id,
        digest,
    )
    .await?
    .filter(|row| {
        row.registry_action == "governance.delegate_vote.v1"
            && same(&row.package_id, &state.config.package_id)
    })
    .ok_or_else(|| {
        AppError::BlobNotFound("Delegate vote receipt is outside this account/agent scope".into())
    })?;
    let context = row.receipt_context.as_ref().ok_or_else(|| {
        AppError::Conflict("Prepared delegate vote context is unavailable".into())
    })?;
    if !same(
        context["delegate"]
            .as_str()
            .ok_or_else(|| AppError::Internal("Invalid delegate vote context".into()))?,
        &auth.owner,
    ) || !same(
        context["executionPlatformId"]
            .as_str()
            .ok_or_else(|| AppError::Internal("Invalid delegate vote context".into()))?,
        &state.config.social_chain.platform_object_id,
    ) {
        return Err(AppError::BlobNotFound(
            "Delegate vote receipt is outside this principal or platform".into(),
        ));
    }
    let transaction = rpc(
        state,
        "myso_getTransactionBlock",
        serde_json::json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if transaction["digest"].as_str() != Some(digest) {
        return Err(AppError::Internal(
            "Invalid delegate vote transaction evidence".into(),
        ));
    }
    let sender = transaction
        .pointer("/transaction/data/sender")
        .or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Delegate vote sender is unavailable".into()))?;
    if !same(sender, &auth.owner) || !same(sender, &row.sender) {
        return Err(AppError::Conflict(
            "Delegate vote sender does not match its approving principal".into(),
        ));
    }
    let status = transaction
        .pointer("/effects/status/status")
        .and_then(Value::as_str);
    let checkpoint = transaction
        .get("checkpoint")
        .filter(|value| !value.is_null());
    let finalized = status == Some("success") && checkpoint.is_some();
    let expected_type = coin_type(&format!(
        "{}::governance::DelegateVoteEvent",
        state.config.package_id
    ))?;
    let events = transaction
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Internal("Delegate vote events are unavailable".into()))?;
    let matches = events
        .iter()
        .filter(|event| {
            event
                .get("type")
                .and_then(Value::as_str)
                .and_then(|value| coin_type(value).ok())
                .as_deref()
                == Some(expected_type.as_str())
        })
        .filter(|event| {
            let data = &event["parsedJson"];
            let expected_reason = &context["reason"];
            data["proposal_id"]
                .as_str()
                .is_some_and(|id| same(id, context["proposalId"].as_str().unwrap_or("")))
                && data["delegate_address"]
                    .as_str()
                    .is_some_and(|id| same(id, context["delegate"].as_str().unwrap_or("")))
                && data["approve"].as_bool() == context["approve"].as_bool()
                && data.get("reason").unwrap_or(&Value::Null) == expected_reason
        })
        .collect::<Vec<_>>();
    if finalized && matches.len() != 1 {
        return Err(AppError::Conflict(
            "Unique exact delegate vote event could not be verified".into(),
        ));
    }
    let vote = matches.first().map(|event| &event["parsedJson"]).map(|data| {
        Ok::<Value, AppError>(serde_json::json!({
            "proposal_id": data.get("proposal_id").and_then(Value::as_str).ok_or_else(|| AppError::Internal("Delegate vote proposal ID is unavailable".into()))?,
            "delegate_address": data.get("delegate_address").and_then(Value::as_str).ok_or_else(|| AppError::Internal("Delegate vote address is unavailable".into()))?,
            "approve": data.get("approve").and_then(Value::as_bool).ok_or_else(|| AppError::Internal("Delegate vote choice is unavailable".into()))?,
            "vote_time": u64_value(data.get("vote_time"))?.to_string(),
            "reason": data.get("reason").cloned().unwrap_or(Value::Null),
        }))
    }).transpose()?;
    Ok(serde_json::json!({
        "digest": digest,
        "registryAction": "governance.delegate_vote.v1",
        "status": match status { Some("success") if finalized => "finalized", Some("success") => "checkpoint_pending", Some("failure") => "failed", _ => "unknown" },
        "checkpoint": checkpoint.map(Value::to_string),
        "route": context["route"],
        "vote": vote,
        "evidenceSource": "configured_fullnode_and_scoped_preparation"
    }))
}

async fn governance_vote_quote(
    state: &AppState,
    registry_id: &str,
    proposal_id: &str,
    vote_count: &str,
) -> Result<Value, AppError> {
    use crate::chain_reads::{coin_type, id, object, u64_value};
    let registry_id = id(registry_id)
        .map_err(|_| AppError::BadRequest("Invalid governance registry ID".into()))?;
    let proposal_id =
        id(proposal_id).map_err(|_| AppError::BadRequest("Invalid proposal ID".into()))?;
    let requested = crate::chain_reads::u64_value(Some(&Value::String(vote_count.to_owned())))
        .map_err(|_| AppError::BadRequest("voteCount must be a canonical decimal u64".into()))?;
    if requested == 0 {
        return Err(AppError::BadRequest("voteCount must be positive".into()));
    }
    let registry = object(state, &registry_id).await?;
    let proposal = object(state, &proposal_id).await?;
    let expected_registry = coin_type(&format!(
        "{}::governance::GovernanceDAO",
        state.config.package_id
    ))?;
    let expected_proposal = coin_type(&format!(
        "{}::governance::Proposal",
        state.config.package_id
    ))?;
    if coin_type(
        registry
            .pointer("/content/type")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Internal("Governance registry type is unavailable".into()))?,
    )? != expected_registry
        || coin_type(
            proposal
                .pointer("/content/type")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Internal("Proposal type is unavailable".into()))?,
        )? != expected_proposal
    {
        return Err(AppError::BadRequest(
            "The supplied objects are not a governance registry and proposal".into(),
        ));
    }
    let registry_fields = registry
        .pointer("/content/fields")
        .ok_or_else(|| AppError::Internal("Governance registry fields are unavailable".into()))?;
    let proposal_fields = proposal
        .pointer("/content/fields")
        .ok_or_else(|| AppError::Internal("Proposal fields are unavailable".into()))?;
    let maximum = u64_value(registry_fields.get("max_votes_per_user"))?;
    let base = u64_value(registry_fields.get("quadratic_base_cost"))?;
    let status = u64_value(proposal_fields.get("status"))?;
    if requested > maximum {
        return Err(AppError::BadRequest(
            "voteCount exceeds the current registry maximum".into(),
        ));
    }
    let cost = if requested <= 1 {
        0u128
    } else {
        u128::from(requested)
            .checked_mul(u128::from(requested))
            .and_then(|squared| squared.checked_sub(1))
            .and_then(|factor| u128::from(base).checked_mul(factor))
            .ok_or_else(|| {
                AppError::BadRequest(
                    "quadratic vote cost exceeds the quote arithmetic limit".into(),
                )
            })?
    };
    if cost > u128::from(u64::MAX) {
        return Err(AppError::BadRequest(
            "quadratic vote cost exceeds the native u64 limit".into(),
        ));
    }
    Ok(serde_json::json!({
        "registryId": registry_id,
        "proposalId": proposal_id,
        "voteCount": requested.to_string(),
        "approve": "must_be_chosen_by_owner",
        "registryMaxVotesPerUser": maximum.to_string(),
        "quadraticBaseCostMist": base.to_string(),
        "estimatedVoteCostMist": cost.to_string(),
        "proposalStatus": status,
        "communityVotingStatus": 2,
        "currentlyInCommunityVoting": status == 2,
        "votingStartTimeMs": proposal_fields.get("voting_start_time").and_then(Value::as_u64).map(|v| v.to_string()),
        "votingEndTimeMs": proposal_fields.get("voting_end_time").and_then(Value::as_u64).map(|v| v.to_string()),
        "quoteSource": "configured_fullnode_current_object_state",
        "warning": "Quote is a current object-state estimate; the native vote entry rechecks proposal membership, phase, time, eligibility and payment at execution. Registry membership is not proven by this object read."
    }))
}

async fn task_receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    crate::chain_reads::digest_bytes(digest)
        .map_err(|_| AppError::BadRequest("Invalid task receipt digest".into()))?;
    let row = crate::chain_actions::get_by_digest(
        &state.db,
        &auth.account_id,
        &auth.agent_object_id,
        digest,
    )
    .await?
    .filter(|row| {
        row.registry_action.starts_with("task.")
            && same_id(&row.package_id, &state.config.package_id)
    })
    .ok_or_else(|| {
        AppError::BlobNotFound("Task receipt is outside this account/agent scope".into())
    })?;
    let context = row
        .receipt_context
        .as_ref()
        .ok_or_else(|| AppError::Conflict("Prepared task receipt context is unavailable".into()))?;
    if context["registryAction"].as_str() != Some(row.registry_action.as_str())
        || !same_id(
            context["actingAgentId"]
                .as_str()
                .ok_or_else(|| AppError::Internal("Invalid task receipt context".into()))?,
            &auth.agent_object_id,
        )
        || !same_id(
            context["executionPlatformId"]
                .as_str()
                .ok_or_else(|| AppError::Internal("Invalid task receipt context".into()))?,
            &state.config.social_chain.platform_object_id,
        )
    {
        return Err(AppError::BlobNotFound(
            "Task receipt is outside this platform or agent scope".into(),
        ));
    }
    let transaction = crate::chain_reads::rpc(
        state,
        "myso_getTransactionBlock",
        serde_json::json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if transaction["digest"].as_str() != Some(digest) {
        return Err(AppError::Internal(
            "Invalid task transaction evidence".into(),
        ));
    }
    let sender = transaction
        .pointer("/transaction/data/sender")
        .or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Task transaction sender is unavailable".into()))?;
    if !same_id(sender, &row.sender) {
        return Err(AppError::Conflict(
            "Task transaction sender does not match its prepared action".into(),
        ));
    }
    let checkpoint = transaction.get("checkpoint").filter(|v| !v.is_null());
    let effect_status = transaction
        .pointer("/effects/status/status")
        .and_then(Value::as_str);
    let status = match effect_status {
        Some("success") if checkpoint.is_some() => "finalized",
        Some("success") => "checkpoint_pending",
        Some("failure") => "failed",
        _ => "unknown",
    };
    let events = transaction
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Internal("Task transaction events are unavailable".into()))?;
    let package = object_id(&row.package_id)?;
    // `open_dispute` creates the case in this transaction, so its case ID is
    // learned from the exact TaskDisputed event rather than caller input.
    let opened_case_id = events.iter().find_map(|event| {
        let ty = event.get("type")?.as_str()?;
        if !ty.ends_with("::agent_task::TaskDisputed") {
            return None;
        }
        let parsed = event.get("parsedJson")?;
        let task_id = context.get("taskId")?.as_str()?;
        parsed
            .get("task_id")?
            .as_str()
            .filter(|id| same_id(id, task_id))?;
        parsed.get("case_id")?.as_str().map(str::to_owned)
    });
    let expected_case_id = context
        .get("caseId")
        .and_then(Value::as_str)
        .or(opened_case_id.as_deref());
    let mut related = Vec::new();
    for event in events {
        let ty = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Internal("Invalid task event type".into()))?;
        let mut parts = ty.split("::");
        let (Some(event_package), Some(module), Some(event_name)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if parts.next().is_some()
            || !["agent_task", "jury"].contains(&module)
            || !same_id(event_package, &package)
        {
            continue;
        }
        let parsed = event
            .get("parsedJson")
            .ok_or_else(|| AppError::Internal("Task event data is unavailable".into()))?;
        if row.registry_action == "task.create.v1" {
            if module != "agent_task"
                || event_name != "TaskOffered"
                || !task_offer_event_matches(parsed, context)
            {
                continue;
            }
        } else if module == "agent_task" {
            let expected_task = context["taskId"]
                .as_str()
                .ok_or_else(|| AppError::Conflict("Task receipt is missing its task ID".into()))?;
            if !parsed
                .get("task_id")
                .and_then(Value::as_str)
                .is_some_and(|id| same_id(id, expected_task))
            {
                continue;
            }
            if !task_action_event_matches(&row.registry_action, event_name, parsed, context) {
                continue;
            }
            if row.registry_action == "task.open_dispute.v1" && event_name == "TaskDisputed" {
                let Some(expected_case) = expected_case_id else {
                    continue;
                };
                if !parsed
                    .get("case_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| same_id(id, expected_case))
                {
                    continue;
                }
            }
            if row.registry_action == "task.deliver.v1" {
                let expected_digest =
                    context["deliverableDigestHex"].as_str().ok_or_else(|| {
                        AppError::Conflict(
                            "Task delivery receipt is missing its artifact digest".into(),
                        )
                    })?;
                let observed_digest = match parsed.get("deliverable_digest") {
                    Some(Value::Array(bytes)) => bytes
                        .iter()
                        .map(|byte| {
                            byte.as_u64()
                                .and_then(|n| u8::try_from(n).ok())
                                .map(|n| format!("{n:02x}"))
                        })
                        .collect::<Option<String>>(),
                    Some(Value::String(value)) => Some(
                        value
                            .strip_prefix("0x")
                            .unwrap_or(value)
                            .to_ascii_lowercase(),
                    ),
                    _ => None,
                };
                let expected_uri = context["deliverableUri"].as_str().ok_or_else(|| {
                    AppError::Conflict("Task delivery receipt is missing its artifact URI".into())
                })?;
                if observed_digest.as_deref() != Some(expected_digest)
                    || parsed.get("deliverable_uri").and_then(Value::as_str) != Some(expected_uri)
                    || !parsed
                        .get("seller_agent_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| same_id(id, &auth.agent_object_id))
                {
                    continue;
                }
            }
        } else {
            if !task_action_event_matches(&row.registry_action, event_name, parsed, context) {
                continue;
            }
            let Some(expected_case) = expected_case_id else {
                continue;
            };
            if !parsed
                .get("case_id")
                .and_then(Value::as_str)
                .is_some_and(|id| same_id(id, expected_case))
            {
                continue;
            }
            if event_name == "CaseOpened" {
                let expected_task = context["taskId"].as_str().ok_or_else(|| {
                    AppError::Conflict("Task receipt is missing its task ID".into())
                })?;
                if !parsed
                    .get("subject_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| same_id(id, expected_task))
                {
                    continue;
                }
            }
        }
        let event_sequence = event
            .pointer("/id/eventSeq")
            .and_then(|value| {
                value
                    .as_str()
                    .and_then(|text| text.parse::<u64>().ok())
                    .or_else(|| value.as_u64())
            });
        related.push(serde_json::json!({
            "type": ty,
            "data": parsed,
            "eventSeq": event_sequence.map(|value| value.to_string()),
            "occurredAtMs": transaction
                .get("timestampMs")
                .and_then(|value| value.as_str().and_then(|text| text.parse::<u64>().ok()).or_else(|| value.as_u64()))
                .map(|value| value.to_string())
        }));
    }
    if status == "finalized" && related.is_empty() {
        return Err(AppError::Conflict(
            "No task-contract event matched the prepared task identity".into(),
        ));
    }
    let required_events: &[&str] = match row.registry_action.as_str() {
        "task.open_dispute.v1" => &["::agent_task::TaskDisputed", "::jury::CaseOpened"],
        "task.appeal.v1" => &["::agent_task::TaskDisputeFeePaid", "::jury::CaseAppealed"],
        "task.cancel_dispute.v1" => &[
            "::agent_task::TaskDisputeCancelled",
            "::jury::CaseCancelled",
        ],
        _ => &[],
    };
    if status == "finalized"
        && required_events.iter().any(|suffix| {
            !related.iter().any(|event| {
                event["type"]
                    .as_str()
                    .is_some_and(|event_type| event_type.ends_with(suffix))
            })
        })
    {
        return Err(AppError::Conflict(
            "The finalized transaction is missing a required task transition event".into(),
        ));
    }
    if status == "finalized" && row.registry_action == "task.accept_dispute_settlement.v1" {
        let resolved = related.iter().find(|event| {
            event["type"]
                .as_str()
                .is_some_and(|event_type| event_type.ends_with("::agent_task::TaskDisputeResolved"))
        });
        let outcome = resolved
            .and_then(|event| event["data"].get("outcome"))
            .and_then(Value::as_u64)
            .ok_or_else(|| AppError::Conflict("The agreement receipt is missing its resolution outcome".into()))?;
        let expected_payout = if outcome == 1 {
            "::agent_task::TaskRefunded"
        } else {
            "::agent_task::TaskReceiptSettled"
        };
        let payout = related.iter().find(|event| {
            event["type"]
                .as_str()
                .is_some_and(|event_type| event_type.ends_with(expected_payout))
        });
        let payout_matches = payout.is_some_and(|event| {
            let data = &event["data"];
            if outcome == 1 {
                data.get("refund_kind").and_then(Value::as_u64) == Some(3)
            } else {
                let expected_kind = if outcome == 0 { 4 } else { 6 };
                data.get("settlement_kind").and_then(Value::as_u64) == Some(expected_kind)
            }
        });
        if !payout_matches {
            return Err(AppError::Conflict(
                "The finalized agreement receipt is missing its matching escrow payout event".into(),
            ));
        }
    }
    let offered_task_id = if row.registry_action == "task.create.v1" {
        related
            .iter()
            .find(|event| {
                event["type"]
                    .as_str()
                    .is_some_and(|value| value.ends_with("::agent_task::TaskOffered"))
            })
            .and_then(|event| event.pointer("/data/task_id"))
            .cloned()
    } else {
        None
    };
    let mut receipt = serde_json::json!({
        "digest": digest,
        "registryAction": row.registry_action,
        "taskId": context.get("taskId").filter(|v| !v.is_null()).cloned().or(offered_task_id),
        "caseId": expected_case_id.map(|value| Value::String(value.to_owned())).or_else(|| context.get("caseId").filter(|v| !v.is_null()).cloned()),
        "status": status,
        "checkpoint": checkpoint.map(|value| value.to_string()),
        "events": related,
        "evidenceSource": "configured_fullnode_and_scoped_action_record",
        "currentTaskState": "not_checked"
    });
    if row.registry_action == "task.deliver.v1" {
        receipt["deliverableDigestHex"] = context
            .get("deliverableDigestHex")
            .cloned()
            .unwrap_or(Value::Null);
        receipt["deliverableUri"] = context
            .get("deliverableUri")
            .cloned()
            .unwrap_or(Value::Null);
    }
    decimal_quantities(&mut receipt);
    Ok(receipt)
}

fn task_offer_event_matches(event: &Value, context: &Value) -> bool {
    fn same_optional_id(event: Option<&Value>, expected: Option<&Value>) -> bool {
        match (event, expected) {
            (Some(Value::Null), Some(Value::Null)) => true,
            (Some(Value::String(actual)), Some(Value::String(expected))) => {
                same_id(actual, expected)
            }
            _ => false,
        }
    }
    fn digest_hex(value: Option<&Value>) -> Option<String> {
        match value? {
            Value::String(text) => {
                let hex = text.strip_prefix("0x").unwrap_or(text).to_ascii_lowercase();
                (hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(hex)
            }
            Value::Array(bytes) => {
                let mut hex = String::with_capacity(64);
                for byte in bytes {
                    hex.push_str(&format!(
                        "{:02x}",
                        byte.as_u64().filter(|value| *value <= 255)?
                    ));
                }
                (hex.len() == 64).then_some(hex)
            }
            _ => None,
        }
    }
    let same_id_field = |event_key: &str, context_key: &str| {
        event
            .get(event_key)
            .and_then(Value::as_str)
            .zip(context.get(context_key).and_then(Value::as_str))
            .is_some_and(|(actual, expected)| same_id(actual, expected))
    };
    let same_u64_field = |event_key: &str, context_key: &str| {
        crate::chain_reads::u64_value(event.get(event_key)).ok()
            == crate::chain_reads::u64_value(context.get(context_key)).ok()
            && crate::chain_reads::u64_value(event.get(event_key)).is_ok()
    };
    same_id_field("buyer_principal", "buyerPrincipal")
        && same_optional_id(event.get("buyer_agent_id"), context.get("buyerAgentId"))
        && same_id_field("buyer_memory_account_id", "buyerMemoryAccountId")
        && same_id_field("seller_memory_account_id", "sellerAccountId")
        && same_id_field("seller_agent_id", "sellerAgentId")
        && same_u64_field("amount_mist", "amountMist")
        && event.get("title").and_then(Value::as_str)
            == context.get("title").and_then(Value::as_str)
        && digest_hex(event.get("scope_digest"))
            == context
                .get("scopeDigestHex")
                .and_then(Value::as_str)
                .map(str::to_owned)
        && same_u64_field("accept_window_ms", "acceptWindowMs")
        && same_u64_field("delivery_window_ms", "deliveryWindowMs")
        && same_u64_field("settle_window_ms", "settleWindowMs")
        && same_optional_id(event.get("room_group_id"), context.get("roomGroupId"))
}

/// Verify a journaled chain write through the action-family reader that owns
/// its prepared context. Callers provide a digest only after loading it from a
/// successful encrypted work operation; each delegated reader still enforces
/// its own account/agent scope, package, signer, and event checks.
fn preserve_json_integer_precision(value: &mut Value) {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let replacement = value.as_number().and_then(|number| {
        let unsafe_integer = number.as_u64().is_some_and(|value| value > MAX_SAFE_INTEGER)
            || number.as_i64().is_some_and(|value| {
                value > MAX_SAFE_INTEGER as i64 || value < -(MAX_SAFE_INTEGER as i64)
            });
        unsafe_integer.then(|| Value::String(number.to_string()))
    });
    if let Some(replacement) = replacement {
        *value = replacement;
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                preserve_json_integer_precision(item);
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                preserve_json_integer_precision(item);
            }
        }
        _ => {}
    }
}

pub(crate) async fn verify_prepared_action_receipt(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    digest: &str,
) -> Result<Value, AppError> {
    let row = crate::chain_actions::get_by_digest(
        &state.db,
        &auth.account_id,
        &auth.agent_object_id,
        digest,
    )
    .await?
    .ok_or_else(|| {
        AppError::BlobNotFound("Action receipt is outside this account/agent scope".into())
    })?;
    let id = Some(digest.to_owned());
    let query = ReadQuery {
        id,
        ..ReadQuery::default()
    };
    let receipt = match row.registry_action.as_str() {
        "messaging.create_group.v1" => messaging_group_creation_receipt(state, auth, digest).await,
        "messaging.bind_room_to_task.v1" => task_room_binding_receipt(state, auth, digest).await,
        action if action.starts_with("task.") => task_receipt(state, auth, digest).await,
        action if action.starts_with("jury.") => jury_receipt(state, auth, digest).await,
        "governance.vote.v1" => governance_vote_receipt(state, auth, digest).await,
        "governance.delegate_vote.v1" => {
            governance_delegate_vote_receipt(state, auth, digest).await
        }
        crate::spt::BUY_ACTION | crate::spt::SELL_ACTION => {
            crate::spt::receipt(state, auth, digest).await
        }
        crate::dex::ACTION => crate::dex::receipt(state, auth, digest).await,
        "account.rotate_owner_key.v1" => {
            crate::owner_agents::read(
                state,
                auth,
                "agent_admin_registered_rotation_receipt",
                &query,
            )
            .await
        }
        action if crate::owner_agents::is_action(action) => {
            crate::owner_agents::read(state, auth, "agent_admin_receipt", &query).await
        }
        crate::payments::ACTION => {
            crate::payments::read(state, auth, "payments_receipt", &query).await
        }
        crate::poc_vault::ACTION => {
            crate::poc_vault::read(state, auth, "poc_claim_receipt", Some(digest)).await
        }
        crate::poc_vault::ACCEPT_TRANSFER_ACTION => {
            crate::poc_vault::read(
                state,
                auth,
                "poc_beneficiary_transfer_receipt",
                Some(digest),
            )
            .await
        }
        crate::spot_payout::ACTION => {
            crate::spot_payout::read(state, auth, "spot_claim_receipt", Some(digest)).await
        }
        crate::spot_payout::BET_ACTION => {
            crate::spot_payout::read(state, auth, "spot_bet_receipt", Some(digest)).await
        }
        crate::spot_payout::CREATE_MARKET_ACTION => {
            crate::spot_payout::read(state, auth, "spot_market_receipt", Some(digest)).await
        }
        crate::assets::ACTION => {
            crate::assets::read(state, auth, "assets_transfer_receipt", &query).await
        }
        crate::assets::BURN_ACTION => {
            crate::assets::read(state, auth, "assets_burn_receipt", &query).await
        }
        action if crate::organization_treasury::is_action(action) => {
            crate::organization_treasury::read(state, auth, digest).await
        }
        action if crate::organization_actions::is_action(action) => {
            crate::organization_actions::read(state, auth, digest).await
        }
        action if crate::platform_admin_actions::is_action(action) => {
            crate::platform_admin_actions::read(state, auth, digest).await
        }
        action if crate::subscription_access::is_action(action) => {
            crate::subscription_access::read(state, auth, "subscription_receipt", &query).await
        }
        "access.purchase_mydata_access.v1" | "access.purchase_post_access.v1" => {
            crate::mydata_access::get_receipt(state, auth, digest).await
        }
        "access.share_mydata.v1" | "access.revoke_mydata_share.v1" => {
            crate::mydata_access::get_owner_receipt(state, auth, digest).await
        }
        action => return Err(AppError::Conflict(format!(
            "No scoped chain receipt verifier is registered for action {action}"
        ))),
    }?;
    let mut verified_receipt = receipt;
    preserve_json_integer_precision(&mut verified_receipt);
    let mut receipt = verified_receipt.as_object().cloned().ok_or_else(|| {
        AppError::Internal("Scoped chain receipt verifier returned a non-object response".into())
    })?;
    if receipt.get("digest").and_then(Value::as_str).is_some_and(|value| value != digest)
        || receipt
            .get("registryAction")
            .and_then(Value::as_str)
            .is_some_and(|value| value != row.registry_action)
    {
        return Err(AppError::Conflict(
            "Scoped chain receipt verifier returned conflicting action identity".into(),
        ));
    }
    receipt.insert("digest".into(), Value::String(digest.to_owned()));
    receipt.insert(
        "registryAction".into(),
        Value::String(row.registry_action),
    );
    // The work journal records gas separately from value transferred or purchased.
    // Read the configured fullnode effects directly; simulation estimates are not
    // used as evidence of the final sender charge.
    let effects = crate::chain_reads::rpc(
        state,
        "myso_getTransactionBlock",
        serde_json::json!([digest,{"showEffects":true}]),
    )
    .await?;
    if effects.get("digest").and_then(Value::as_str) != Some(digest) {
        return Err(AppError::Conflict("Fullnode gas effects do not match the verified action digest".into()));
    }
    let gas = effects
        .pointer("/effects/gasUsed")
        .ok_or_else(|| AppError::Conflict("Fullnode action effects omitted gas usage".into()))?;
    let computation = crate::chain_reads::u64_value(gas.get("computationCost"))?;
    let storage = crate::chain_reads::u64_value(gas.get("storageCost"))?;
    let rebate = crate::chain_reads::u64_value(gas.get("storageRebate"))?;
    let gross = computation
        .checked_add(storage)
        .ok_or_else(|| AppError::Conflict("Fullnode gas summary overflows".into()))?;
    let (gas_cost, gas_refund) = if rebate > gross { (0, rebate - gross) } else { (gross - rebate, 0) };
    receipt.insert("gasCostMist".into(), Value::String(gas_cost.to_string()));
    receipt.insert("gasRefundMist".into(), Value::String(gas_refund.to_string()));
    Ok(Value::Object(receipt))
}

async fn jury_receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    use crate::chain_reads::{digest_bytes, rpc, same, u64_value};
    const ACTIONS: &[&str] = &[
        "jury.accept.v1",
        "jury.commit_vote.v1",
        "jury.reveal_vote.v1",
        "jury.claim_fee.v1",
        "jury.select_jury.v1",
        "jury.replace_no_shows.v1",
        "jury.finalize_round.v1",
        "jury.finalize_case.v1",
        "jury.execute_task_verdict.v1",
        "jury.start_neutral_resolution.v1",
        "jury.execute_neutral_resolution.v1",
        "jury.settle_dispute_fees.v1",
        "jury.escalate_proposal.v1",
        "jury.finalize_proposal.v1",
        "jury.apply_proposal_decision.v1",
        "jury.sweep_vote_refunds.v1",
        "jury.sweep_case.v1",
        "jury.refresh_roster_entry.v1",
        "jury.evict_ineligible.v1",
    ];
    digest_bytes(digest).map_err(|_| AppError::BadRequest("Invalid jury receipt digest".into()))?;
    let row = crate::chain_actions::get_by_digest(
        &state.db,
        &auth.account_id,
        &auth.agent_object_id,
        digest,
    )
    .await?
    .filter(|row| {
        ACTIONS.contains(&row.registry_action.as_str())
            && same(&row.package_id, &state.config.package_id)
    })
    .ok_or_else(|| {
        AppError::BlobNotFound("Jury receipt is outside this account/agent scope".into())
    })?;
    let context = row
        .receipt_context
        .as_ref()
        .ok_or_else(|| AppError::Conflict("Prepared jury receipt context is unavailable".into()))?;
    let action = row.registry_action.as_str();
    if context["registryAction"].as_str() != Some(action)
        || !context["actingAgentId"]
            .as_str()
            .is_some_and(|id| same(id, &auth.agent_object_id))
        || !context["executionPlatformId"]
            .as_str()
            .is_some_and(|id| same(id, &state.config.social_chain.platform_object_id))
    {
        return Err(AppError::BlobNotFound(
            "Jury receipt is outside this platform or juror".into(),
        ));
    }
    let case_id = context["caseId"].as_str();
    let task_id = context["taskId"].as_str();
    let proposal_id = context["proposalId"].as_str();
    let transaction = rpc(
        state,
        "myso_getTransactionBlock",
        serde_json::json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if transaction["digest"].as_str() != Some(digest) {
        return Err(AppError::Internal(
            "Invalid jury transaction evidence".into(),
        ));
    }
    let sender = transaction
        .pointer("/transaction/data/sender")
        .or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Jury transaction sender is unavailable".into()))?;
    if !same(sender, &row.sender) {
        return Err(AppError::Conflict(
            "Jury transaction sender does not match its prepared action".into(),
        ));
    }
    let effect_status = transaction
        .pointer("/effects/status/status")
        .and_then(Value::as_str);
    let checkpoint = transaction
        .get("checkpoint")
        .filter(|value| !value.is_null());
    let status = match effect_status {
        Some("success") if checkpoint.is_some() => "finalized",
        Some("success") => "checkpoint_pending",
        Some("failure") => "failed",
        _ => "unknown",
    };
    let (expected_module, expected_events): (&str, &[&str]) = match action {
        "jury.accept.v1" => ("jury", &["AssignmentAccepted"]),
        "jury.commit_vote.v1" => ("jury", &["VoteCommitted"]),
        "jury.reveal_vote.v1" => ("jury", &["VoteRevealed"]),
        "jury.claim_fee.v1" => ("jury", &["JurorPaid"]),
        "jury.select_jury.v1" => ("jury", &["JuryDrawn"]),
        "jury.replace_no_shows.v1" => (
            "jury",
            &["JurorReplaced", "JuryDrawn", "VotingStarted", "CaseFailed"],
        ),
        "jury.finalize_round.v1" => ("jury", &["RoundFinalized"]),
        "jury.finalize_case.v1" => ("jury", &["CaseFinalized", "CaseFailed"]),
        "jury.execute_task_verdict.v1" => ("agent_task", &["TaskDisputeResolved"]),
        "jury.start_neutral_resolution.v1" => ("agent_task", &["TaskNeutralWindowOpened"]),
        "jury.execute_neutral_resolution.v1" => ("agent_task", &["TaskDisputeResolved"]),
        "jury.settle_dispute_fees.v1" => ("agent_task", &["TaskDisputeFeesSettled"]),
        "jury.escalate_proposal.v1" => (
            "governance",
            &["ProposalEscalatedToJuryEvent", "JuryUnavailableEvent"],
        ),
        "jury.finalize_proposal.v1" => (
            "governance",
            &[
                "ProposalApprovedForVotingEvent",
                "ProposalRejectedByCommunityEvent",
                "ProposalEscalatedToJuryEvent",
                "JuryUnavailableEvent",
                "JuryDecisionAppliedEvent",
            ],
        ),
        "jury.apply_proposal_decision.v1" => (
            "governance",
            &[
                "JuryDecisionAppliedEvent",
                "ProposalRejectedByJuryEvent",
                "ProposalApprovedEvent",
            ],
        ),
        "jury.sweep_vote_refunds.v1" => ("governance", &["VoteRefundsSweptEvent"]),
        "jury.sweep_case.v1" => ("governance", &["JuryCaseRemainderSweptEvent"]),
        "jury.refresh_roster_entry.v1" => ("jury", &["RosterEntryRefreshed"]),
        "jury.evict_ineligible.v1" => ("jury", &["RosterLeft"]),
        _ => return Err(AppError::Internal("Unsupported jury receipt action".into())),
    };
    let bytes_hex = |value: Option<&Value>| -> Option<String> {
        match value? {
            Value::Array(bytes) => bytes
                .iter()
                .map(|byte| {
                    byte.as_u64()
                        .and_then(|value| u8::try_from(value).ok())
                        .map(|value| format!("{value:02x}"))
                })
                .collect::<Option<String>>(),
            Value::String(value) => {
                let value = value
                    .strip_prefix("0x")
                    .unwrap_or(value)
                    .to_ascii_lowercase();
                (!value.is_empty()
                    && value.len() % 2 == 0
                    && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .then_some(value)
            }
            _ => None,
        }
    };
    let events = transaction
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Internal("Jury transaction events are unavailable".into()))?;
    let mut related = Vec::new();
    for event in events {
        let Some(ty) = event.get("type").and_then(Value::as_str) else {
            continue;
        };
        let mut parts = ty.split("::");
        let (Some(package), Some(module), Some(name)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if parts.next().is_some()
            || module != expected_module
            || !same(package, &row.package_id)
            || !expected_events.contains(&name)
        {
            continue;
        }
        let Some(data) = event.get("parsedJson") else {
            continue;
        };
        if let Some(case_id) = case_id {
            if !data
                .get("case_id")
                .and_then(Value::as_str)
                .is_some_and(|id| same(id, case_id))
            {
                continue;
            }
        }
        if let Some(task_id) = task_id {
            if !data
                .get("task_id")
                .and_then(Value::as_str)
                .is_some_and(|id| same(id, task_id))
            {
                continue;
            }
        }
        if let Some(proposal_id) = proposal_id {
            if !data
                .get("proposal_id")
                .and_then(Value::as_str)
                .is_some_and(|id| same(id, proposal_id))
            {
                continue;
            }
        }
        if let Some(agent_id) = context.get("subjectAgentId").and_then(Value::as_str) {
            if !data
                .get("agent_id")
                .and_then(Value::as_str)
                .is_some_and(|id| same(id, agent_id))
            {
                continue;
            }
        }
        if let Some(juror_id) = context.get("jurorId").and_then(Value::as_str) {
            if !data
                .get("agent_id")
                .and_then(Value::as_str)
                .is_some_and(|id| same(id, juror_id))
            {
                continue;
            }
        }
        match action {
            "jury.select_jury.v1"
                if data.get("replacement").and_then(Value::as_bool) != Some(false) =>
            {
                continue
            }
            "jury.replace_no_shows.v1"
                if name == "JuryDrawn"
                    && data.get("replacement").and_then(Value::as_bool) != Some(true) =>
            {
                continue
            }
            "jury.execute_task_verdict.v1" if u64_value(data.get("source")).ok() != Some(1) => {
                continue
            }
            "jury.execute_neutral_resolution.v1"
                if u64_value(data.get("source")).ok() != Some(3) =>
            {
                continue
            }
            "jury.escalate_proposal.v1" | "jury.finalize_proposal.v1"
                if context.get("stage").is_some()
                    && u64_value(data.get("stage")).ok()
                        != context.get("stage").and_then(Value::as_u64) =>
            {
                continue
            }
            "jury.apply_proposal_decision.v1" if name == "JuryDecisionAppliedEvent" => {
                let Some(expected) = case_id else {
                    return Err(AppError::Internal(
                        "Proposal jury receipt is missing its case identity".into(),
                    ));
                };
                let observed = data
                    .get("case_id")
                    .and_then(|value| value.get("Some"))
                    .and_then(Value::as_str)
                    .or_else(|| data.get("case_id").and_then(Value::as_str));
                if !observed.is_some_and(|id| same(id, expected)) {
                    continue;
                }
            }
            "jury.evict_ineligible.v1" if u64_value(data.get("reason")).ok() != Some(2) => continue,
            "jury.commit_vote.v1"
                if bytes_hex(data.get("commitment"))
                    != context
                        .get("commitmentHex")
                        .and_then(Value::as_str)
                        .map(str::to_owned) =>
            {
                continue
            }
            "jury.reveal_vote.v1" => {
                if u64_value(data.get("outcome")).ok()
                    != context.get("outcome").and_then(Value::as_u64)
                    || bytes_hex(data.get("rationale_digest"))
                        != context
                            .get("rationaleDigestHex")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    || bytes_hex(data.get("bundle_digest"))
                        != context
                            .get("bundleDigestHex")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                {
                    continue;
                }
                let refs = data
                    .get("evidence_refs")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .map(|value| {
                                u64_value(Some(value)).map(|value| Value::String(value.to_string()))
                            })
                            .collect::<Result<Vec<_>, _>>()
                    });
                if refs.as_ref().and_then(|result| result.as_ref().ok())
                    != context.get("evidenceRefs").and_then(Value::as_array)
                {
                    continue;
                }
            }
            _ => {}
        }
        related.push(serde_json::json!({"type":ty,"data":data}));
    }
    if status == "finalized" {
        let has_expected_effect = match action {
            "jury.replace_no_shows.v1" => related.iter().any(|event| {
                let Some(ty) = event["type"].as_str() else {
                    return false;
                };
                ["JuryDrawn", "VotingStarted", "CaseFailed"]
                    .iter()
                    .any(|name| ty.ends_with(&format!("::jury::{name}")))
            }),
            "jury.finalize_case.v1" => related.len() == 1,
            "jury.apply_proposal_decision.v1" => related.iter().any(|event| {
                event["type"]
                    .as_str()
                    .is_some_and(|ty| ty.ends_with("::governance::JuryDecisionAppliedEvent"))
            }),
            "jury.sweep_vote_refunds.v1" => related.len() == 1,
            "jury.escalate_proposal.v1" | "jury.finalize_proposal.v1" => !related.is_empty(),
            "jury.sweep_case.v1" | "jury.refresh_roster_entry.v1" | "jury.evict_ineligible.v1" => {
                related.len() == 1
            }
            _ => related.len() == 1,
        };
        if !has_expected_effect {
            return Err(AppError::Conflict(
                "Finalized jury transaction did not produce one matching transition event".into(),
            ));
        }
    }
    let mut receipt = serde_json::json!({
        "digest":digest,"registryAction":action,"caseId":context.get("caseId"),"taskId":context.get("taskId"),"proposalId":context.get("proposalId"),"registryId":context.get("registryId"),"jurorId":context.get("jurorId"),"subjectAgentId":context.get("subjectAgentId"),
        "status":status,"checkpoint":checkpoint.map(Value::to_string),"events":related,
        "evidenceSource":"configured_fullnode_and_scoped_jury_action"
    });
    decimal_quantities(&mut receipt);
    if serde_json::to_vec(&receipt).map_or(true, |bytes| bytes.len() > 512 * 1024) {
        return Err(AppError::Internal(
            "Jury receipt exceeds the supported response size".into(),
        ));
    }
    Ok(receipt)
}

async fn task_settlement_receipt(
    state: &AppState,
    auth: &AuthInfo,
    id: &str,
) -> Result<Value, AppError> {
    let task_id = object_id(id)?;
    let task = owned_task(state, auth, &task_id).await?;
    let status = task
        .get("status")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Internal("task status is unavailable".into()))?;
    if status != 3 {
        return Ok(
            serde_json::json!({"taskId": task_id, "settled": false, "status": status, "receipt": null, "verification": "task_not_indexed_as_settled"}),
        );
    }
    let indexed = fetch(state, &format!("/tasks/{task_id}/receipt"), &[]).await?;
    let indexed_task_id = indexed
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("task receipt is missing its task ID".into()))?;
    let receipt_id = indexed
        .get("receiptId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("task receipt ID is unavailable".into()))?;
    let digest = indexed
        .get("transactionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Internal("task settlement transaction digest is unavailable".into())
        })?;
    if !same_id(indexed_task_id, &task_id) || !same_id(receipt_id, &task_id) {
        return Err(AppError::Conflict(
            "Indexed settlement receipt belongs to another task".into(),
        ));
    }
    crate::chain_reads::digest_bytes(digest)
        .map_err(|_| AppError::Internal("indexed task settlement digest is invalid".into()))?;
    let transaction = crate::chain_reads::rpc(
        state,
        "myso_getTransactionBlock",
        serde_json::json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if transaction.get("digest").and_then(Value::as_str) != Some(digest)
        || transaction
            .pointer("/effects/status/status")
            .and_then(Value::as_str)
            != Some("success")
        || transaction.get("checkpoint").is_none_or(Value::is_null)
    {
        return Err(AppError::Conflict(
            "Task settlement transaction is not finalized successfully".into(),
        ));
    }
    let package = object_id(&state.config.package_id)?;
    let events = transaction
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Internal("task settlement events are unavailable".into()))?;
    let mut matched = Vec::new();
    for event in events {
        let Some(ty) = event.get("type").and_then(Value::as_str) else {
            continue;
        };
        if ty != format!("{package}::agent_task::TaskReceiptSettled") {
            continue;
        }
        let parsed = event.get("parsedJson").ok_or_else(|| {
            AppError::Internal("task settlement event data is unavailable".into())
        })?;
        if task_receipt_event_matches(parsed, &indexed) {
            matched.push(parsed.clone());
        }
    }
    if matched.len() != 1 {
        return Err(AppError::Conflict(
            "Finalized transaction did not contain one matching TaskReceiptSettled event".into(),
        ));
    }
    let mut result = serde_json::json!({
        "taskId": task_id,
        "settled": true,
        "status": status,
        "receipt": indexed,
        "transactionDigest": digest,
        "checkpoint": transaction.get("checkpoint"),
        "event": matched[0],
        "verification": "finalized_fullnode_task_receipt_settled_event",
    });
    decimal_quantities(&mut result);
    Ok(result)
}

async fn task_history(
    state: &AppState,
    auth: &AuthInfo,
    id: &str,
    limit: u32,
    offset: u32,
) -> Result<Value, AppError> {
    let task_id = object_id(id)?;
    owned_task(state, auth, &task_id).await?;
    let query = vec![
        ("limit".into(), limit.clamp(1, 100).to_string()),
        ("offset".into(), offset.min(100_000).to_string()),
    ];
    let history = fetch(state, &format!("/tasks/{task_id}/history"), &query).await?;
    if history
        .get("taskId")
        .and_then(Value::as_str)
        .is_none_or(|value| !same_id(value, &task_id))
        || history
            .get("events")
            .and_then(Value::as_array)
            .is_none_or(|events| events.len() > 100)
    {
        return Err(AppError::Internal(
            "task history response did not match the requested task".into(),
        ));
    }
    Ok(history)
}

pub(crate) async fn task_lifecycle_history(
    state: &AppState,
    auth: &AuthInfo,
    id: &str,
    limit: u32,
    offset: u32,
) -> Result<Value, AppError> {
    let mut history = task_history(state, auth, id, limit, offset).await?;
    let task_id = object_id(id)?;
    let events = history
        .get_mut("events")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| AppError::Internal("task history omitted its event page".into()))?;
    let indexed_events = std::mem::take(events);
    let task_id_ref = task_id.as_str();
    let mut verified = stream::iter(indexed_events.into_iter().enumerate())
        .map(|(index, event)| async move {
            (
                index,
                verify_task_lifecycle_event(state, task_id_ref, event).await,
            )
        })
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
    // RPC completion order is nondeterministic; preserve the indexer's stable
    // page order so clients can advance offsets and correlate evidence safely.
    verified.sort_by_key(|(index, _)| *index);
    history["events"] = Value::Array(verified.into_iter().map(|(_, event)| event).collect());
    history["evidenceSource"] = json!("participant_indexed_history_with_fullnode_event_checks");
    Ok(history)
}

async fn verify_task_lifecycle_event(state: &AppState, task_id: &str, mut event: Value) -> Value {
    let source = event
        .get("sourceEventId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let (digest, sequence) = source
        .rsplit_once(':')
        .and_then(|(digest, sequence)| {
            let sequence = sequence.parse::<u64>().ok()?;
            crate::chain_reads::digest_bytes(digest).ok()?;
            Some((digest.to_owned(), sequence))
        })
        .unwrap_or_default();
    if digest.is_empty() {
        event["verification"] = json!("indexer_preview");
        return event;
    }
    let indexed_type = event.get("eventType").and_then(Value::as_str).unwrap_or("");
    let allowed = [
        "TaskOffered",
        "TaskAccepted",
        "TaskDelivered",
        "TaskReceiptSettled",
        "TaskRefunded",
        "TaskCancelled",
        "TaskDisputed",
    ];
    let indexed_name = indexed_type.rsplit("::").next().unwrap_or("");
    if !allowed.contains(&indexed_name)
        || indexed_type.contains("::") && !indexed_type.contains("agent_task")
    {
        event["digest"] = json!(digest);
        event["verification"] = json!("indexer_preview");
        return event;
    }
    let tx = match crate::chain_reads::rpc(
        state,
        "myso_getTransactionBlock",
        json!([digest,{"showEffects":true,"showEvents":true}]),
    )
    .await
    {
        Ok(value) => value,
        Err(_) => {
            event["digest"] = json!(digest);
            event["verification"] = json!("fullnode_unavailable");
            return event;
        }
    };
    let tx_digest = tx.get("digest").and_then(Value::as_str);
    if tx_digest != Some(digest.as_str()) {
        event["digest"] = json!(digest);
        event["verification"] = json!("fullnode_mismatch");
        return event;
    }
    let exact = tx
        .get("events")
        .and_then(Value::as_array)
        .map(|chain_events| {
            chain_events
                .iter()
                .filter(|chain_event| {
                    let event_sequence = chain_event.pointer("/id/eventSeq").and_then(|value| {
                        value
                            .as_str()
                            .and_then(|text| text.parse::<u64>().ok())
                            .or_else(|| value.as_u64())
                    });
                    let event_type = chain_event
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let package_matches = event_type
                        .split("::")
                        .next()
                        .is_some_and(|package| same_id(package, &state.config.package_id));
                    let parsed = chain_event.get("parsedJson");
                    let task_matches = parsed
                        .and_then(|data| data.get("task_id"))
                        .and_then(Value::as_str)
                        .is_some_and(|actual| same_id(actual, task_id));
                    event_sequence == Some(sequence)
                        && package_matches
                        && event_type.contains("::agent_task::")
                        && event_type.ends_with(&format!("::{indexed_name}"))
                        && task_matches
                })
                .count()
        })
        .unwrap_or(0);
    let effect = tx.pointer("/effects/status/status").and_then(Value::as_str);
    let checkpoint = tx.get("checkpoint").filter(|value| !value.is_null());
    let verification = match (exact, effect, checkpoint.is_some()) {
        (1, Some("success"), true) => "finalized_fullnode_task_event",
        (1, Some("success"), false) => "checkpoint_pending_task_event",
        (0, Some("failure"), _) => "failed_task_transaction",
        (0, Some("success"), true) => "fullnode_event_mismatch",
        _ => "fullnode_unavailable_or_unknown",
    };
    event["digest"] = json!(digest);
    event["verification"] = json!(verification);
    event["checkpoint"] = checkpoint.cloned().unwrap_or(Value::Null);
    event
}

async fn task_room(state: &AppState, auth: &AuthInfo, id: &str) -> Result<Value, AppError> {
    let task_id = object_id(id)?;
    let task = owned_task(state, auth, &task_id).await?;
    let buyer = task
        .get("buyerMemoryAccountId")
        .and_then(Value::as_str)
        .is_some_and(|value| same_id(value, &auth.account_id))
        && task
            .get("buyerAgentId")
            .and_then(Value::as_str)
            .is_none_or(|value| same_id(value, &auth.agent_object_id));
    let seller = task
        .get("sellerMemoryAccountId")
        .and_then(Value::as_str)
        .is_some_and(|value| same_id(value, &auth.account_id))
        && task
            .get("sellerAgentId")
            .and_then(Value::as_str)
            .is_some_and(|value| same_id(value, &auth.agent_object_id));
    if !buyer && !seller {
        return Err(AppError::BlobNotFound("record unavailable".into()));
    }
    let room = fetch(state, &format!("/tasks/{task_id}/room"), &[]).await?;
    let expected_group = task
        .get("roomGroupId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BlobNotFound("Task has no linked room".into()))?;
    if room
        .get("taskId")
        .and_then(Value::as_str)
        .is_none_or(|value| !same_id(value, &task_id))
        || room
            .get("groupId")
            .and_then(Value::as_str)
            .is_none_or(|value| !same_id(value, expected_group))
        || room
            .get("groupUuid")
            .and_then(Value::as_str)
            .is_none_or(|value| value.is_empty() || value.len() > 128)
    {
        return Err(AppError::Conflict(
            "The task room index does not match the linked on-chain room".into(),
        ));
    }
    Ok(serde_json::json!({
        "taskId": task_id,
        "groupId": object_id(expected_group)?,
        "groupUuid": room["groupUuid"],
        "evidenceSource": "authorized_task_participant_and_social_indexer_room_binding",
        "messagingPermission": "not_proven_by_this_read"
    }))
}

/// Restrict a task action receipt to the Move event(s) emitted by that exact
/// transition. A matching task ID alone is insufficient because a transaction
/// can contain several task/jury events for the same task.
fn task_action_event_matches(
    action: &str,
    event_name: &str,
    event: &Value,
    context: &Value,
) -> bool {
    let expected = match action {
        "task.accept.v1" => &["TaskAccepted"][..],
        "task.decline.v1" | "task.cancel_offer.v1" | "task.expire_offer.v1" => {
            &["TaskCancelled"][..]
        }
        "task.deliver.v1" => &["TaskDelivered"][..],
        "task.settle.v1" | "task.release.v1" => &["TaskReceiptSettled"][..],
        "task.refund.v1" | "task.accept_refund.v1" => &["TaskRefunded"][..],
        "task.propose_refund.v1" => &["TaskRefundProposed"][..],
        "task.reject_refund.v1" | "task.withdraw_refund.v1" => &["TaskRefundProposalCleared"][..],
        "task.open_dispute.v1" => &["TaskDisputed", "CaseOpened"][..],
        "task.respond_dispute.v1" => &["TaskDisputeFeePaid"][..],
        "task.appeal.v1" => &["TaskDisputeFeePaid", "CaseAppealed"][..],
        "task.submit_evidence.v1" => &["EvidenceSubmitted"][..],
        "task.cancel_dispute.v1" => &["TaskDisputeCancelled", "CaseCancelled"][..],
        "task.propose_dispute_settlement.v1" => &["TaskDisputeSettlementProposed"][..],
        "task.accept_dispute_settlement.v1" => &["TaskDisputeResolved", "TaskReceiptSettled", "TaskRefunded"][..],
        "task.clear_dispute_settlement.v1" => &["TaskDisputeSettlementCleared"][..],
        "task.review.v1" => &["TaskReviewSubmitted"][..],
        _ => return false,
    };
    if !expected.contains(&event_name) {
        return false;
    }

    let exact_discriminator = match action {
        "task.decline.v1" => Some(("close_kind", 1)),
        "task.cancel_offer.v1" => Some(("close_kind", 0)),
        "task.expire_offer.v1" => Some(("close_kind", 2)),
        "task.settle.v1" => Some(("settlement_kind", 1)),
        "task.release.v1" => Some(("settlement_kind", 2)),
        "task.refund.v1" => Some(("refund_kind", 0)),
        "task.accept_refund.v1" => Some(("refund_kind", 1)),
        "task.reject_refund.v1" => Some(("reason", 1)),
        "task.withdraw_refund.v1" => Some(("reason", 0)),
        "task.respond_dispute.v1" => Some(("kind", 1)),
        "task.appeal.v1" => Some(("kind", 2)),
        _ => None,
    };
    if let Some((field, expected_value)) = exact_discriminator {
        if event.get(field).and_then(Value::as_u64) != Some(expected_value) {
            return false;
        }
    }

    match (action, event_name) {
        ("task.accept.v1", "TaskAccepted") => context
            .get("sellerAgentId")
            .and_then(Value::as_str)
            .zip(event.get("seller_agent_id").and_then(Value::as_str))
            .is_some_and(|(expected_id, observed_id)| same_id(expected_id, observed_id)),
        ("task.review.v1", "TaskReviewSubmitted") => {
            let expected_role = match context.get("raterRole").and_then(Value::as_str) {
                Some("buyer") => 1,
                Some("seller") => 2,
                _ => return false,
            };
            event.get("rater_role").and_then(Value::as_u64) == Some(expected_role)
                && event.get("stars").and_then(Value::as_u64) == context.get("stars").and_then(Value::as_u64)
                && context.get("raterPrincipal").and_then(Value::as_str)
                    .zip(event.get("rater_principal").and_then(Value::as_str))
                    .is_some_and(|(expected, observed)| same_id(expected, observed))
                && match (context.get("raterAgentId"), event.get("rater_agent_id")) {
                    (Some(Value::Null), Some(Value::Null)) => true,
                    (Some(Value::String(expected)), Some(Value::String(observed))) => same_id(expected, observed),
                    _ => false,
                }
        }
        ("task.open_dispute.v1", "TaskDisputed") => {
            event.get("case_id").and_then(Value::as_str).is_some()
        }
        ("task.accept_dispute_settlement.v1", "TaskDisputeResolved") => {
            event.get("case_id").and_then(Value::as_str).is_some()
                && event.get("source").and_then(Value::as_u64) == Some(2)
                && event.get("outcome").and_then(Value::as_u64).is_some_and(|outcome| outcome <= 2)
        }
        ("task.accept_dispute_settlement.v1", "TaskRefunded") => {
            event.get("refund_kind").and_then(Value::as_u64) == Some(3)
        }
        ("task.accept_dispute_settlement.v1", "TaskReceiptSettled") => {
            matches!(event.get("settlement_kind").and_then(Value::as_u64), Some(4 | 6))
        }
        _ => true,
    }
}

fn task_receipt_event_matches(event: &Value, receipt: &Value) -> bool {
    let same_id_field = |event_key: &str, receipt_key: &str| {
        event
            .get(event_key)
            .and_then(Value::as_str)
            .zip(receipt.get(receipt_key).and_then(Value::as_str))
            .is_some_and(|(event_value, receipt_value)| same_id(event_value, receipt_value))
    };
    let same_optional_id_field =
        |event_key: &str, receipt_key: &str| match (event.get(event_key), receipt.get(receipt_key))
        {
            (Some(Value::Null), Some(Value::Null)) => true,
            (Some(Value::String(event_value)), Some(Value::String(receipt_value))) => {
                same_id(event_value, receipt_value)
            }
            _ => false,
        };
    let same_u64_field = |event_key: &str, receipt_key: &str| {
        crate::chain_reads::u64_value(event.get(event_key)).ok()
            == crate::chain_reads::u64_value(receipt.get(receipt_key)).ok()
            && crate::chain_reads::u64_value(event.get(event_key)).is_ok()
    };
    let same_optional_text_field =
        |event_key: &str, receipt_key: &str| match (event.get(event_key), receipt.get(receipt_key))
        {
            (Some(Value::Null), Some(Value::Null)) => true,
            (Some(Value::String(event_value)), Some(Value::String(receipt_value))) => {
                event_value == receipt_value
            }
            _ => false,
        };
    let same_optional_digest_field = |event_key: &str, receipt_key: &str| {
        fn digest_hex(value: &Value) -> Option<String> {
            match value {
                Value::Null => None,
                Value::String(text) => {
                    let normalized = text.strip_prefix("0x").unwrap_or(text).to_ascii_lowercase();
                    (!normalized.is_empty()
                        && normalized.len() % 2 == 0
                        && normalized.bytes().all(|byte| byte.is_ascii_hexdigit()))
                    .then_some(normalized)
                }
                Value::Array(bytes) => {
                    let mut output = String::with_capacity(bytes.len() * 2);
                    for byte in bytes {
                        let value = byte.as_u64().filter(|value| *value <= 255)?;
                        output.push_str(&format!("{value:02x}"));
                    }
                    Some(output)
                }
                _ => None,
            }
        }
        match (event.get(event_key), receipt.get(receipt_key)) {
            (Some(Value::Null), Some(Value::Null)) => true,
            (Some(event_value), Some(receipt_value)) => digest_hex(event_value)
                .zip(digest_hex(receipt_value))
                .is_some_and(|(event_digest, receipt_digest)| event_digest == receipt_digest),
            _ => false,
        }
    };
    same_id_field("task_id", "taskId")
        && same_id_field("receipt_id", "receiptId")
        && same_id_field("buyer_principal", "buyerPrincipal")
        && same_optional_id_field("buyer_agent_id", "buyerAgentId")
        && same_id_field("seller_principal", "sellerPrincipal")
        && same_id_field("seller_agent_id", "sellerAgentId")
        && same_optional_id_field("organization_id", "organizationId")
        && same_optional_id_field("room_group_id", "roomGroupId")
        && same_u64_field("settlement_kind", "settlementKind")
        && same_u64_field("amount_mist", "amountMist")
        && same_u64_field("platform_fee_mist", "platformFeeMist")
        && same_u64_field("ecosystem_fee_mist", "ecosystemFeeMist")
        && same_u64_field("net_amount_mist", "netAmountMist")
        && same_u64_field("buyer_credibility_bps", "buyerCredibilityBps")
        && same_u64_field("seller_credibility_bps", "sellerCredibilityBps")
        && same_u64_field("settle_deadline_ms", "settleDeadlineMs")
        && same_u64_field("review_deadline_ms", "reviewDeadlineMs")
        && same_u64_field("settled_at_ms", "settledAtMs")
        && same_optional_digest_field("deliverable_digest", "deliverableDigest")
        && same_optional_text_field("deliverable_uri", "deliverableUri")
}
async fn fetch(
    state: &AppState,
    path: &str,
    query: &[(String, String)],
) -> Result<Value, AppError> {
    let url = format!(
        "{}{}",
        state.config.social_server_url.trim_end_matches('/'),
        path
    );
    let mut response = state
        .http_client
        .get(url)
        .query(query)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| AppError::Internal("social read service unavailable".into()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::BlobNotFound("record unavailable".into()));
    }
    if !response.status().is_success() {
        return Err(AppError::Internal(
            "social read service rejected the request".into(),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::Internal("social read failed".into()))?
    {
        if body.len().saturating_add(chunk.len()) > 512 * 1024 {
            return Err(AppError::Internal(
                "social read exceeded response limit".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let mut value: Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::Internal("invalid social response".into()))?;
    decimal_quantities(&mut value);
    Ok(value)
}

async fn jury_case_bundle(state: &AppState, auth: &AuthInfo, input: &ReadQuery) -> Result<Value, AppError> {
    let case_id = object_id(input.id.as_deref().ok_or_else(|| AppError::BadRequest("id is required".into()))?)?;
    let round = input.round.ok_or_else(|| AppError::BadRequest("round is required".into()))?;
    if round > 255 { return Err(AppError::BadRequest("round must not exceed 255".into())); }
    let indexed_case = fetch(state, &format!("/jury/cases/{case_id}"), &[]).await?;
    if !same_id(indexed_case.get("caseId").and_then(Value::as_str).unwrap_or(""), &case_id) {
        return Err(AppError::Internal("jury case reader returned a mismatched case".into()));
    }
    let assigned = indexed_case.get("jurors").and_then(Value::as_array).is_some_and(|jurors| jurors.iter().any(|juror| {
        same_id(juror.get("agentId").and_then(Value::as_str).unwrap_or(""), &auth.agent_object_id)
            && juror.get("round").and_then(|value| value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse().ok()))) == Some(round as u64)
    }));
    if !assigned { return Err(AppError::Forbidden("case bundle requires a juror assignment for this agent and round".into())); }

    let runner_base = state.config.jury_bundle_runner_url.as_deref().ok_or_else(|| AppError::Internal("jury bundle service is not configured".into()))?;
    let token = state.config.jury_bundle_runner_token.as_deref().ok_or_else(|| AppError::Internal("jury bundle service credential is not configured".into()))?;
    let base = reqwest::Url::parse(runner_base).map_err(|_| AppError::Internal("jury bundle service URL is invalid".into()))?;
    let loopback = matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if (base.scheme() != "https" && !(base.scheme() == "http" && loopback)) || !base.username().is_empty() || base.password().is_some() {
        return Err(AppError::Internal("jury bundle service URL must use HTTPS (or local loopback) and contain no credentials".into()));
    }
    let mut url = base.join("/case-bundle").map_err(|_| AppError::Internal("jury bundle service URL is invalid".into()))?;
    url.query_pairs_mut().append_pair("caseId", &case_id).append_pair("round", &round.to_string());
    let mut response = state.http_client.get(url).bearer_auth(token).timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_| AppError::Internal("jury bundle service unavailable".into()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND { return Err(AppError::BlobNotFound("jury case bundle unavailable".into())); }
    if !response.status().is_success() { return Err(AppError::Internal("jury bundle service rejected the request".into())); }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| AppError::Internal("jury bundle response could not be read".into()))? {
        if body.len().saturating_add(chunk.len()) > 8 * 1024 * 1024 { return Err(AppError::Internal("jury bundle exceeded its response limit".into())); }
        body.extend_from_slice(&chunk);
    }
    let payload: Value = serde_json::from_slice(&body).map_err(|_| AppError::Internal("jury bundle service returned invalid JSON".into()))?;
    if !same_id(payload.pointer("/bundle/caseId").and_then(Value::as_str).unwrap_or(""), &case_id)
        || payload.pointer("/bundle/round").and_then(Value::as_u64) != Some(round as u64)
        || payload.get("digestHex").and_then(Value::as_str).is_none_or(|digest| digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return Err(AppError::Internal("jury bundle service returned inconsistent case identity or digest".into()));
    }
    Ok(payload)
}
/// Read owner-private AI-credit state from Core using the service credential.
/// Callers derive owner from authenticated MCP context and resolve balance IDs
/// from that same owner's balance before requesting a balance-ID route.
async fn account_memory_usage(state: &AppState, auth: &AuthInfo) -> Result<Value, AppError> {
    let account_id = object_id(&auth.account_id)?;
    let stored = fetch_ai_credit(state, &format!("/memory-accounts/{account_id}/usage-stats"), &[]).await?;
    let rows = stored.get("agents").and_then(Value::as_array).ok_or_else(|| AppError::Internal("stored memory usage is invalid".into()))?;
    if rows.is_empty() {
        return Ok(json!({
            "accountId": account_id,
            "available": false,
            "updatedAt": Value::Null,
            "entries": Value::Null,
            "bytes": Value::Null,
            "orgSharedEntries": Value::Null,
            "agents": [],
        }));
    }
    let mut entries = 0i64;
    let mut bytes = 0i64;
    let mut shared = 0i64;
    let mut newest: Option<String> = None;
    let mut agents = Vec::new();
    for row in rows {
        let agent_id = object_id(row.get("agent_object_id").and_then(Value::as_str).unwrap_or(""))?;
        let stored_account = object_id(row.get("account_id").and_then(Value::as_str).unwrap_or(""))?;
        if stored_account != account_id {
            return Err(AppError::Conflict("stored memory usage is not limited to this account".into()));
        }
        let row_entries = row.get("entries").and_then(Value::as_i64).or_else(|| row.get("entries").and_then(Value::as_str).and_then(|value| value.parse().ok())).ok_or_else(|| AppError::Internal("stored memory entry count is invalid".into()))?;
        let row_bytes = row.get("bytes").and_then(Value::as_i64).or_else(|| row.get("bytes").and_then(Value::as_str).and_then(|value| value.parse().ok())).ok_or_else(|| AppError::Internal("stored memory byte count is invalid".into()))?;
        let row_shared = row.get("org_shared_entries").and_then(Value::as_i64).or_else(|| row.get("org_shared_entries").and_then(Value::as_str).and_then(|value| value.parse().ok())).ok_or_else(|| AppError::Internal("stored shared memory count is invalid".into()))?;
        if row_entries < 0 || row_bytes < 0 || row_shared < 0 {
            return Err(AppError::Internal("stored memory usage is negative".into()));
        }
        entries = entries.checked_add(row_entries).ok_or_else(|| AppError::Internal("stored memory entry total overflowed".into()))?;
        bytes = bytes.checked_add(row_bytes).ok_or_else(|| AppError::Internal("stored memory byte total overflowed".into()))?;
        shared = shared.checked_add(row_shared).ok_or_else(|| AppError::Internal("stored shared memory total overflowed".into()))?;
        let updated_at = row.get("updated_at").and_then(Value::as_str).ok_or_else(|| AppError::Internal("stored memory usage has no snapshot time".into()))?.to_string();
        if newest.as_deref().is_none_or(|current| updated_at.as_str() > current) {
            newest = Some(updated_at.clone());
        }
        agents.push(json!({
            "agentObjectId": agent_id,
            "organizationId": row.get("organization_id").and_then(Value::as_str),
            "entries": row_entries.to_string(),
            "bytes": row_bytes.to_string(),
            "orgSharedEntries": row_shared.to_string(),
            "updatedAt": updated_at,
        }));
    }
    Ok(json!({
        "accountId": account_id,
        "available": true,
        "updatedAt": newest,
        "entries": entries.to_string(),
        "bytes": bytes.to_string(),
        "orgSharedEntries": shared.to_string(),
        "agents": agents,
    }))
}

async fn fetch_ai_credit(
    state: &AppState,
    path: &str,
    query: &[(String, String)],
) -> Result<Value, AppError> {
    let secret = state
        .config
        .internal_sync_secret
        .as_deref()
        .filter(|secret| !secret.trim().is_empty())
        .ok_or_else(|| AppError::Internal("AI credit read authorization is not configured".into()))?;
    let url = format!(
        "{}{}",
        state.config.social_server_url.trim_end_matches('/'),
        path
    );
    let mut response = state
        .http_client
        .get(url)
        .header("x-internal-sync-secret", secret)
        .query(query)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| AppError::Internal("social read service unavailable".into()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::BlobNotFound("record unavailable".into()));
    }
    if !response.status().is_success() {
        return Err(AppError::Internal(
            "social AI-credit read service rejected the request".into(),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::Internal("social read failed".into()))?
    {
        if body.len().saturating_add(chunk.len()) > 512 * 1024 {
            return Err(AppError::Internal("social read exceeded response limit".into()));
        }
        body.extend_from_slice(&chunk);
    }
    let mut value: Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::Internal("invalid social response".into()))?;
    decimal_quantities(&mut value);
    Ok(value)
}

fn ensure_ai_credit_balance_scope(value: &Value, expected_balance_id: &str) -> Result<(), AppError> {
    let rows: Vec<&Value> = match value {
        Value::Array(rows) => rows.iter().collect(),
        Value::Object(_) => vec![value],
        _ => return Err(AppError::Conflict("AI-credit response has an invalid balance-scoped shape".into())),
    };
    if rows.iter().any(|row| {
        row.get("balance_id")
            .and_then(Value::as_str)
            .is_none_or(|balance_id| !same_id(balance_id, expected_balance_id))
    }) {
        return Err(AppError::Conflict("AI-credit response is outside the resolved owner balance".into()));
    }
    Ok(())
}

// Preserve monetary integers and any unsafe-width integer before JavaScript JSON parsing.
pub(crate) fn decimal_quantities(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(decimal_quantities),
        Value::Object(fields) => {
            for (key, item) in fields {
                let unsafe_integer = item.as_i64().is_some_and(|number| {
                    number > 9_007_199_254_740_991 || number < -9_007_199_254_740_991
                }) || item
                    .as_u64()
                    .is_some_and(|number| number > 9_007_199_254_740_991);
                if item.is_number()
                    && (key.ends_with("Mist")
                        || key.ends_with("_mist")
                        || key == "reservation_nonce"
                        || unsafe_integer)
                {
                    *item = Value::String(item.to_string());
                } else {
                    decimal_quantities(item);
                }
            }
        }
        _ => {}
    }
}
fn require_id(query: &ReadQuery) -> Result<String, AppError> {
    object_id(
        query
            .id
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
    )
}
fn promotion_path_segment(value: &str) -> Result<String, AppError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(AppError::BadRequest("invalid promotion identifier".into()));
    }
    Ok(value.to_owned())
}
fn promotion_list_params(input: &ReadQuery, paging: bool) -> Result<Vec<(String, String)>, AppError> {
    let mut query = Vec::new();
    if paging {
        let limit = input.limit.unwrap_or(20).clamp(1, 100);
        query.push(("limit".into(), limit.to_string()));
        if let Some(offset) = input.offset { query.push(("offset".into(), offset.min(100_000).to_string())); }
        else if input.page.is_none() { query.push(("offset".into(), "0".into())); }
        if let Some(page) = input.page { query.push(("page".into(), page.clamp(1, 100_000 / limit + 1).to_string())); }
    }
    for (key, value) in [
        ("owner", input.owner.as_deref()),
        ("profile_id", input.profile_id.as_deref()),
        ("platform_id", input.platform_id.as_deref()),
        ("post_id", input.post_id.as_deref()),
    ] {
        if let Some(value) = value {
            let normalized = if key == "profile_id" { profile_path_segment(value)? } else { object_id(value)? };
            query.push((key.into(), normalized));
        }
    }
    if let Some(status) = input.status.as_deref() {
        let status = status.to_ascii_lowercase();
        if !["active", "inactive", "all"].contains(&status.as_str()) {
            return Err(AppError::BadRequest("status must be active, inactive, or all".into()));
        }
        query.push(("status".into(), status));
    }
    Ok(query)
}
fn promotion_analytics_params(input: &ReadQuery, global: bool, limit_max: u32, include_limit: bool) -> Result<Vec<(String, String)>, AppError> {
    let mut query = Vec::new();
    if include_limit {
        if let Some(limit) = input.limit { query.push(("limit".into(), limit.clamp(1, limit_max).to_string())); }
    }
    if let Some(bucket) = input.bucket.as_deref() {
        if !["7d", "30d", "90d", "180d", "1y"].contains(&bucket) {
            return Err(AppError::BadRequest("bucket must be 7d, 30d, 90d, 180d, or 1y".into()));
        }
        query.push(("bucket".into(), bucket.into()));
    }
    if let Some(from) = input.from {
        if from < 0 { return Err(AppError::BadRequest("from must be a nonnegative epoch timestamp".into())); }
        query.push(("from".into(), from.to_string()));
    }
    if let Some(to) = input.to {
        if to < 0 || input.from.is_some_and(|from| from >= to) {
            return Err(AppError::BadRequest("to must be greater than from".into()));
        }
        query.push(("to".into(), to.to_string()));
    }
    if let Some(platform) = input.platform_id.as_deref() { query.push(("platform_id".into(), object_id(platform)?)); }
    if global {
        if let Some(owner) = input.owner.as_deref() { query.push(("owner".into(), object_id(owner)?)); }
    }
    Ok(query)
}
fn profile_path_segment(value: &str) -> Result<String, AppError> {
    if value.starts_with("0x") {
        return object_id(value);
    }
    if value.is_empty()
        || value.len() > 64
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return Err(AppError::BadRequest(
            "profile id must be an address, username or profile slug".into(),
        ));
    }
    Ok(value.to_owned())
}
fn username_path_segment(value: &str) -> Result<String, AppError> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.'))
    {
        return Err(AppError::BadRequest(
            "username must use lowercase ASCII letters, digits, underscore or dot".into(),
        ));
    }
    Ok(value.to_owned())
}
fn social_record_id(value: Option<&str>, field: &str) -> Result<String, AppError> {
    let value = value.ok_or_else(|| AppError::BadRequest(format!("{field} is required")))?;
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
    {
        return Err(AppError::BadRequest(format!("invalid {field}")));
    }
    Ok(value.to_owned())
}
fn social_page(input: &ReadQuery) -> Vec<(String, String)> {
    vec![
        (
            "limit".into(),
            input.limit.unwrap_or(20).clamp(1, 100).to_string(),
        ),
        (
            "offset".into(),
            input.offset.unwrap_or(0).min(100_000).to_string(),
        ),
    ]
}
async fn social_subscription_read(
    state: &AppState,
    resource: &str,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let mut page = social_page(input);
    let value = match resource {
        "social_subscription_list" => {
            let mut query = page;
            if let Some(address) = input.address.as_deref() {
                query.push(("subscriber".into(), object_id(address)?));
            }
            if let Some(service_id) = input.service_id.as_deref() {
                query.push((
                    "service_id".into(),
                    social_record_id(Some(service_id), "service_id")?,
                ));
            }
            fetch(state, "/subscriptions", &query).await?
        }
        "social_subscription_services" => fetch(state, "/subscription-services", &page).await?,
        "social_subscription_revenue" => {
            if let Some(service_id) = input.service_id.as_deref() {
                page.push((
                    "service_id".into(),
                    social_record_id(Some(service_id), "service_id")?,
                ));
            }
            fetch(state, "/subscription-revenue", &page).await?
        }
        "social_subscription_status" => {
            let id = social_record_id(input.id.as_deref(), "subscription id")?;
            fetch(state, &format!("/subscriptions/{id}/status"), &[]).await?
        }
        "social_subscription_subscriber_summary" => {
            let address = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            fetch(state, &format!("/subscribers/{address}/summary"), &[]).await?
        }
        "social_subscription_profile_services" => {
            let owner = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            fetch(
                state,
                &format!("/profiles/{owner}/subscription-services"),
                &page,
            )
            .await?
        }
        "social_subscription_service"
        | "social_subscription_plans"
        | "social_subscription_service_revenue" => {
            let service_id = social_record_id(input.service_id.as_deref(), "service_id")?;
            match resource {
                "social_subscription_service" => {
                    fetch(state, &format!("/subscription-services/{service_id}"), &[]).await?
                }
                "social_subscription_plans" => {
                    fetch(
                        state,
                        &format!("/subscription-services/{service_id}/plans"),
                        &page,
                    )
                    .await?
                }
                _ => {
                    fetch(
                        state,
                        &format!("/subscription-services/{service_id}/revenue"),
                        &page,
                    )
                    .await?
                }
            }
        }
        "social_subscription_by_subscriber" => {
            let address = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            fetch(
                state,
                &format!("/subscriptions/subscriber/{address}"),
                &page,
            )
            .await?
        }
        "social_subscription_get" => {
            let id = social_record_id(input.id.as_deref(), "subscription id")?;
            fetch(state, &format!("/subscriptions/{id}"), &[]).await?
        }
        "social_subscription_access" => {
            let address = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            let service_id = social_record_id(input.service_id.as_deref(), "service_id")?;
            let mut query = Vec::new();
            if let Some(level) = input.min_tier_level {
                if !(0..=100).contains(&level) {
                    return Err(AppError::BadRequest(
                        "min_tier_level must be between 0 and 100".into(),
                    ));
                }
                query.push(("min_tier_level".into(), level.to_string()));
            }
            fetch(
                state,
                &format!("/subscription-access/{address}/{service_id}"),
                &query,
            )
            .await?
        }
        "social_subscription_analytics" => {
            let mut query = Vec::new();
            if let Some(service_id) = input.service_id.as_deref() {
                query.push((
                    "service_id".into(),
                    social_record_id(Some(service_id), "service_id")?,
                ));
            }
            if let Some(owner) = input.address.as_deref() {
                query.push(("profile_owner".into(), object_id(owner)?));
            }
            let start = input
                .start_date
                .as_deref()
                .map(|date| {
                    chrono::DateTime::parse_from_rfc3339(date)
                        .map(|parsed| (date.to_owned(), parsed.timestamp_millis()))
                        .map_err(|_| AppError::BadRequest("start_date must be RFC3339".into()))
                })
                .transpose()?;
            let end = input
                .end_date
                .as_deref()
                .map(|date| {
                    chrono::DateTime::parse_from_rfc3339(date)
                        .map(|parsed| (date.to_owned(), parsed.timestamp_millis()))
                        .map_err(|_| AppError::BadRequest("end_date must be RFC3339".into()))
                })
                .transpose()?;
            if start
                .as_ref()
                .zip(end.as_ref())
                .is_some_and(|(start, end)| start.1 > end.1)
            {
                return Err(AppError::BadRequest(
                    "start_date must be before or equal to end_date".into(),
                ));
            }
            if let Some((start, _)) = start {
                query.push(("start_date".into(), start));
            }
            if let Some((end, _)) = end {
                query.push(("end_date".into(), end));
            }
            fetch(state, "/subscription-analytics", &query).await?
        }
        "social_subscription_service_performance" => {
            let mut query = Vec::new();
            if let Some(owner) = input.address.as_deref() {
                query.push(("profile_owner".into(), object_id(owner)?));
            }
            fetch(state, "/service-performance", &query).await?
        }
        "social_subscription_configuration" => {
            fetch(state, "/subscription/configuration", &[]).await?
        }
        _ => {
            return Err(AppError::BadRequest(
                "unknown social subscription read resource".into(),
            ))
        }
    };
    Ok(value)
}
fn social_optional_text(
    value: Option<&str>,
    field: &str,
    max: usize,
) -> Result<Option<String>, AppError> {
    value
        .map(|value| {
            if value.is_empty()
                || value.len() > max
                || value.bytes().any(|byte| byte.is_ascii_control())
            {
                Err(AppError::BadRequest(format!(
                    "{field} must be 1-{max} printable bytes"
                )))
            } else {
                Ok(value.to_owned())
            }
        })
        .transpose()
}
fn social_dates(input: &ReadQuery) -> Result<Vec<(String, String)>, AppError> {
    let start = input
        .start_date
        .as_deref()
        .map(|date| {
            chrono::DateTime::parse_from_rfc3339(date)
                .map(|parsed| (date.to_owned(), parsed.timestamp_millis()))
                .map_err(|_| AppError::BadRequest("start_date must be RFC3339".into()))
        })
        .transpose()?;
    let end = input
        .end_date
        .as_deref()
        .map(|date| {
            chrono::DateTime::parse_from_rfc3339(date)
                .map(|parsed| (date.to_owned(), parsed.timestamp_millis()))
                .map_err(|_| AppError::BadRequest("end_date must be RFC3339".into()))
        })
        .transpose()?;
    if start
        .as_ref()
        .zip(end.as_ref())
        .is_some_and(|(start, end)| start.1 > end.1)
    {
        return Err(AppError::BadRequest(
            "start_date must be before or equal to end_date".into(),
        ));
    }
    Ok(start
        .into_iter()
        .map(|(date, _)| ("start_date".into(), date))
        .chain(end.into_iter().map(|(date, _)| ("end_date".into(), date)))
        .collect())
}
async fn social_insurance_read(
    state: &AppState,
    resource: &str,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let page = social_page(input);
    let value = match resource {
        "social_insurance_configuration" => fetch(state, "/insurance/configuration", &[]).await?,
        "social_insurance_vaults" => fetch(state, "/insurance/vaults", &page).await?,
        "social_insurance_vault"
        | "social_insurance_vault_transactions"
        | "social_insurance_vault_exposures" => {
            let vault = social_record_id(input.id.as_deref(), "vault id")?;
            match resource {
                "social_insurance_vault" => {
                    fetch(state, &format!("/insurance/vaults/{vault}"), &[]).await?
                }
                "social_insurance_vault_transactions" => {
                    fetch(
                        state,
                        &format!("/insurance/vaults/{vault}/transactions"),
                        &page,
                    )
                    .await?
                }
                _ => fetch(state, &format!("/insurance/vaults/{vault}/exposures"), &[]).await?,
            }
        }
        "social_insurance_policies" => {
            let mut query = page;
            if let Some(insured) = input.insured.as_deref() {
                query.push(("insured".into(), object_id(insured)?));
            }
            if let Some(market) = input.market_id.as_deref() {
                query.push((
                    "market_id".into(),
                    social_record_id(Some(market), "market_id")?,
                ));
            }
            if let Some(vault) = input.vault_id.as_deref() {
                query.push((
                    "vault_id".into(),
                    social_record_id(Some(vault), "vault_id")?,
                ));
            }
            if let Some(status) = input.status.as_deref() {
                let parsed = status
                    .parse::<i16>()
                    .map_err(|_| AppError::BadRequest("status must be an integer".into()))?;
                query.push(("status".into(), parsed.to_string()));
            }
            fetch(state, "/insurance/policies", &query).await?
        }
        "social_insurance_policy" => {
            let policy = social_record_id(input.id.as_deref(), "policy id")?;
            fetch(state, &format!("/insurance/policies/{policy}"), &[]).await?
        }
        "social_insurance_market_policies" => {
            let market = social_record_id(input.id.as_deref(), "market id")?;
            fetch(
                state,
                &format!("/insurance/markets/{market}/policies"),
                &page,
            )
            .await?
        }
        _ => {
            return Err(AppError::BadRequest(
                "unknown social insurance read resource".into(),
            ))
        }
    };
    Ok(value)
}
async fn social_vesting_read(
    state: &AppState,
    resource: &str,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let page = social_page(input);
    let mut coin_type_query = Vec::new();
    if let Some(coin_type) = input.coin_type.as_deref() {
        coin_type_query.push((
            "coin_type".into(),
            social_optional_text(Some(coin_type), "coin_type", 512)?.unwrap(),
        ));
    }
    let value = match resource {
        "social_vesting_wallets" | "social_vesting_active_wallets" => {
            let mut query = page;
            if resource == "social_vesting_active_wallets" {
                query.push(("active".into(), "true".into()));
            } else if let Some(active) = input.active {
                query.push(("active".into(), active.to_string()));
            }
            if let Some(owner) = input.address.as_deref() {
                query.push(("owner_address".into(), object_id(owner)?));
            }
            query.extend(coin_type_query);
            fetch(state, "/vesting/wallets", &query).await?
        }
        "social_vesting_wallet" | "social_vesting_wallet_events" | "social_vesting_claimable" => {
            let wallet = social_record_id(input.id.as_deref(), "wallet id")?;
            match resource {
                "social_vesting_wallet" => {
                    fetch(state, &format!("/vesting/wallets/{wallet}"), &[]).await?
                }
                "social_vesting_wallet_events" => {
                    fetch(state, &format!("/vesting/wallets/{wallet}/events"), &page).await?
                }
                _ => fetch(state, &format!("/vesting/wallets/{wallet}/claimable"), &[]).await?,
            }
        }
        "social_vesting_user_wallets" => {
            let address = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            let mut query = page;
            query.extend(coin_type_query);
            fetch(state, &format!("/vesting/users/{address}/wallets"), &query).await?
        }
        "social_vesting_events" => {
            let mut query = page;
            if let Some(owner) = input.address.as_deref() {
                query.push(("owner_address".into(), object_id(owner)?));
            }
            fetch(state, "/vesting/events", &query).await?
        }
        "social_vesting_analytics" => fetch(state, "/vesting/analytics", &coin_type_query).await?,
        "social_vesting_leaderboard" => {
            let mut query = page;
            query.extend(coin_type_query);
            fetch(state, "/vesting/leaderboard", &query).await?
        }
        _ => {
            return Err(AppError::BadRequest(
                "unknown social vesting read resource".into(),
            ))
        }
    };
    Ok(value)
}
async fn social_revenue_read(
    state: &AppState,
    resource: &str,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let value = match resource {
        "social_revenue_dashboard" => fetch(state, "/revenue/dashboard", &[]).await?,
        "social_revenue_leaderboard" => {
            let mut query = vec![(
                "limit".into(),
                input.limit.unwrap_or(50).clamp(1, 100).to_string(),
            )];
            if let Some(min) = input.min_revenue.as_deref() {
                let parsed = min
                    .parse::<i64>()
                    .map_err(|_| AppError::BadRequest("min_revenue must be an integer".into()))?;
                if parsed < 0 {
                    return Err(AppError::BadRequest(
                        "min_revenue cannot be negative".into(),
                    ));
                }
                query.push(("min_revenue".into(), parsed.to_string()));
            }
            if let Some(days) = input.period_days {
                if !(1..=3650).contains(&days) {
                    return Err(AppError::BadRequest(
                        "period_days must be between 1 and 3650".into(),
                    ));
                }
                query.push(("period_days".into(), days.to_string()));
            }
            if let Some(source) =
                social_optional_text(input.revenue_source.as_deref(), "revenue_source", 64)?
            {
                query.push(("revenue_source".into(), source));
            }
            fetch(state, "/revenue/leaderboard", &query).await?
        }
        "social_revenue_chart" | "social_revenue_unified" => {
            let mut query = vec![];
            if let Some(address) = input.creator.as_deref() {
                query.push(("creator_address".into(), object_id(address)?));
            }
            if let Some(address) = input.platform_id.as_deref() {
                query.push(("platform_address".into(), object_id(address)?));
            }
            if let Some(source) =
                social_optional_text(input.revenue_source.as_deref(), "revenue_source", 64)?
            {
                query.push(("revenue_source".into(), source));
            }
            if let Some(kind) =
                social_optional_text(input.revenue_type.as_deref(), "revenue_type", 64)?
            {
                query.push(("revenue_type".into(), kind));
            }
            if let Some(content_id) = input.content_id.as_deref() {
                query.push((
                    "content_id".into(),
                    social_record_id(Some(content_id), "content_id")?,
                ));
            }
            if let Some(content_type) =
                social_optional_text(input.content_type.as_deref(), "content_type", 64)?
            {
                query.push(("content_type".into(), content_type));
            }
            if resource == "social_revenue_chart" {
                let period = input.period.as_deref().unwrap_or("day");
                if !["hour", "day", "week", "month"].contains(&period) {
                    return Err(AppError::BadRequest(
                        "period must be hour, day, week or month".into(),
                    ));
                }
                let points = input.points.unwrap_or(30).clamp(1, 1000);
                query.push(("period".into(), period.into()));
                query.push(("points".into(), points.to_string()));
                query.extend(social_dates(input)?);
            } else {
                query.extend(social_dates(input)?);
                query.push((
                    "limit".into(),
                    input.limit.unwrap_or(50).clamp(1, 100).to_string(),
                ));
                query.push((
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ));
            }
            let path = if resource == "social_revenue_chart" {
                "/revenue/chart-data"
            } else {
                "/revenue/unified"
            };
            fetch(state, path, &query).await?
        }
        "social_revenue_creator" | "social_revenue_platform" => {
            let address = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            let path = if resource == "social_revenue_creator" {
                format!("/revenue/creators/{address}/stats")
            } else {
                format!("/revenue/platforms/{address}/stats")
            };
            fetch(state, &path, &[]).await?
        }
        "social_treasury_current" => fetch(state, "/treasury/current", &[]).await?,
        "social_treasury_history" => {
            fetch(
                state,
                "/treasury/history",
                &[(
                    "limit".into(),
                    input.limit.unwrap_or(100).clamp(1, 100).to_string(),
                )],
            )
            .await?
        }
        _ => {
            return Err(AppError::BadRequest(
                "unknown social revenue read resource".into(),
            ))
        }
    };
    Ok(value)
}
async fn social_messaging_read(
    state: &AppState,
    auth: &AuthInfo,
    resource: &str,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let page = social_page(input);
    let value = match resource {
        "social_messaging_configuration" => fetch(state, "/messaging/configuration", &[]).await?,
        "social_messaging_group_creation_receipt" => messaging_group_creation_receipt(state, auth, input.id.as_deref().ok_or_else(||AppError::BadRequest("id is required".into()))?).await?,
        "social_messaging_membership_change_receipt" => messaging_membership_change_receipt(state, auth, input.id.as_deref().ok_or_else(||AppError::BadRequest("id is required".into()))?).await?,
        "social_messaging_room" => messaging_agent_room(state, auth, input).await?,
        "social_messaging_group_members" => messaging_group_members(state, auth, input).await?,
        "social_messaging_group_digests" => messaging_group_digests(state, auth, input).await?,
        "social_messaging_message_receipt" => messaging_message_receipt(state, auth, input).await?,
        "social_messaging_groups" => {
            let org = object_id(
                auth.organization_id
                    .as_deref()
                    .ok_or_else(|| AppError::Forbidden("agent has no organization".into()))?,
            )?;
            crate::organization_treasury::authorize_admin_read(state, auth, &org).await?;
            fetch(
                state,
                &format!("/organizations/{org}/messaging-groups"),
                &page,
            )
            .await?
        }
        "social_messaging_owner_history"
        | "social_messaging_owner_paid_history"
        | "social_messaging_owner_revenue" => {
            let owner = object_id(&auth.owner)?;
            match resource {
                "social_messaging_owner_history" => {
                    let mut rows = fetch(state, &format!("/wallets/{owner}/messages"), &page).await?;
                    normalize_messaging_rows(&mut rows, &[])?;
                    rows
                }
                "social_messaging_owner_paid_history" => {
                    let mut rows = fetch(state, &format!("/wallets/{owner}/paid-messages"), &page).await?;
                    normalize_messaging_rows(&mut rows, &["amount", "platformFee", "treasuryFee", "netAmount"])?;
                    rows
                }
                _ => {
                    let mut summary = fetch(state, &format!("/wallets/{owner}/messaging-revenue"), &[]).await?;
                    normalize_messaging_revenue(&mut summary)?;
                    summary
                },
            }
        }
        _ => {
            return Err(AppError::BadRequest(
                "unknown social messaging read resource".into(),
            ))
        }
    };
    Ok(value)
}

/// Convert i64 sequence and currency fields to decimal strings before they
/// cross the JSON/JavaScript boundary, where integers above 2^53 lose precision.
fn normalize_messaging_rows(value: &mut Value, decimal_fields: &[&str]) -> Result<(), AppError> {
    let rows = value.as_array_mut().ok_or_else(|| AppError::Internal("Messaging history response is not a list".into()))?;
    for row in rows {
        let object = row.as_object_mut().ok_or_else(|| AppError::Internal("Messaging history row is invalid".into()))?;
        let sequence = object.get("seq").and_then(Value::as_i64).filter(|value| *value >= 0)
            .ok_or_else(|| AppError::Conflict("Messaging sequence is outside the supported nonnegative i64 range".into()))?;
        object.insert("seq".into(), Value::String(sequence.to_string()));
        for field in decimal_fields {
            let Some(value) = object.get(*field) else { continue; };
            if value.is_null() { continue; }
            let amount = value.as_i64().filter(|value| *value >= 0)
                .ok_or_else(|| AppError::Conflict("Messaging amount is outside the supported nonnegative i64 range".into()))?;
            object.insert((*field).into(), Value::String(amount.to_string()));
        }
    }
    Ok(())
}

fn normalize_messaging_revenue(value: &mut Value) -> Result<(), AppError> {
    let row = value.as_object_mut().ok_or_else(|| AppError::Internal("Messaging revenue response is invalid".into()))?;
    let total = row.get("totalMessagingRevenue").and_then(Value::as_i64)
        .ok_or_else(|| AppError::Conflict("Messaging revenue total is outside the supported i64 range".into()))?;
    row.insert("totalMessagingRevenue".into(), Value::String(total.to_string()));
    Ok(())
}

/// Core serializes task MIST values as JSON integers. Convert every task-side
/// MIST field to a canonical decimal string before the response reaches MCP's
/// JavaScript JSON parser, which cannot exactly represent the full u64 range.
fn normalize_agent_spend_fields(value: &mut Value) -> Result<(), AppError> {
    match value {
        Value::Array(rows) => {
            for row in rows {
                normalize_agent_spend_fields(row)?;
            }
        }
        Value::Object(fields) => {
            for (key, field) in fields.iter_mut() {
                if key == "max_action_spend" {
                    if field.is_null() {
                        continue;
                    }
                    let amount = match field {
                        Value::Number(number) => number.as_i64().filter(|value| *value >= 0).map(|value| value.to_string()),
                        Value::String(text)
                            if text == "0"
                                || (!text.is_empty()
                                    && !text.starts_with('0')
                                    && text.bytes().all(|byte| byte.is_ascii_digit())) =>
                        {
                            Some(text.clone())
                        }
                        _ => None,
                    }
                    .ok_or_else(|| AppError::Conflict("agent max_action_spend is not an exact nonnegative integer".into()))?;
                    *field = Value::String(amount);
                } else {
                    normalize_agent_spend_fields(field)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn normalize_task_money_fields(value: &mut Value) -> Result<(), AppError> {
    match value {
        Value::Array(rows) => {
            for row in rows {
                normalize_task_money_fields(row)?;
            }
        }
        Value::Object(fields) => {
            for (key, field) in fields.iter_mut() {
                if key.ends_with("Mist") || key.ends_with("_mist") {
                    if field.is_null() {
                        continue;
                    }
                    let amount = match field {
                        Value::Number(number) => number.as_u64().map(|n| n.to_string()),
                        Value::String(text)
                            if text == "0"
                                || (!text.is_empty()
                                    && !text.starts_with('0')
                                    && text.bytes().all(|b| b.is_ascii_digit())) =>
                        {
                            Some(text.clone())
                        }
                        _ => None,
                    }
                    .ok_or_else(|| AppError::Conflict(format!("task MIST field {key} is not an exact nonnegative integer")))?;
                    *field = Value::String(amount);
                } else {
                    normalize_task_money_fields(field)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Return indexed room metadata only after a fresh fullnode reader-permission
/// check for the exact group. This does not expose message plaintext.
async fn messaging_agent_room(
    state: &AppState,
    auth: &AuthInfo,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let group_id = crate::chain_reads::id(
        input
            .id
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
    )?;
    require_messaging_reader(state, auth, &group_id).await?;
    let room = fetch(state, &format!("/groups/{group_id}/room"), &[]).await?;
    let indexed_group = room
        .get("groupId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Conflict("Room metadata response has no group ID".into()))?;
    if !crate::chain_reads::same(indexed_group, &group_id) {
        return Err(AppError::Conflict(
            "Room metadata response does not match the authorized group".into(),
        ));
    }
    Ok(serde_json::json!({
        "room": room,
        "membershipEvidence": "configured_fullnode_current_messaging_reader",
        "metadataSource": "social_indexer",
    }))
}

/// Indexed message anchors are visible only after a fresh fullnode check that
/// the acting agent still has the MessagingReader permission on this group.
pub(crate) async fn require_messaging_permission(
    state: &AppState,
    auth: &AuthInfo,
    group_id: &str,
    permission: &str,
) -> Result<String, AppError> {
    let required_capability = match permission {
        "MessagingReader" => crate::memory_contract::CAP_MESSAGE_READ,
        "MessagingSender" => crate::memory_contract::CAP_MESSAGE_SEND,
        _ => {
            return Err(AppError::BadRequest(
                "unsupported messaging permission".into(),
            ))
        }
    };
    if auth.capabilities & required_capability == 0 {
        return Err(AppError::Forbidden(
            "The required messaging capability is not granted".into(),
        ));
    }
    let package = crate::chain_reads::id(&state.config.social_chain.messaging_package_id)?;
    let group = crate::chain_reads::object(state, group_id).await?;
    let actual_type = group
        .pointer("/content/type")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Messaging group type is unavailable".into()))?;
    let expected_type =
        format!("0x2::permissioned_group::PermissionedGroup<{package}::messaging::Messaging>");
    if crate::chain_reads::coin_type(actual_type)? != crate::chain_reads::coin_type(&expected_type)?
    {
        return Err(AppError::Forbidden(
            "Object is not a group from the configured messaging package".into(),
        ));
    }
    let permissions_table = group
        .pointer("/content/fields/permissions/fields/id/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Internal("Messaging group permission table is unavailable".into())
        })?;
    let permission_field = crate::chain_reads::rpc(
        state,
        "mysox_getDynamicFieldObject",
        serde_json::json!([
            permissions_table,
            {"type":"address","value":auth.derived_address}
        ]),
    )
    .await?;
    let permission_value = permission_field
        .pointer("/data/content/fields/value")
        .ok_or_else(|| {
            AppError::Forbidden("The authenticated agent is not a current room member".into())
        })?;
    let actual_field_type = permission_field
        .pointer("/data/content/type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Internal("Messaging membership field type is unavailable".into())
        })?;
    let expected_field_type =
        "0x2::dynamic_field::Field<address,0x2::vec_set::VecSet<0x1::type_name::TypeName>>";
    if crate::chain_reads::coin_type(actual_field_type)?
        != crate::chain_reads::coin_type(expected_field_type)?
    {
        return Err(AppError::Internal(
            "Messaging membership field has an unexpected type".into(),
        ));
    }
    let contents = permission_value
        .pointer("/fields/contents")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::Internal("Messaging membership permissions are unavailable".into())
        })?;
    let permission_type = format!(
        "{}::messaging::{permission}",
        package.trim_start_matches("0x")
    );
    let has_permission = contents
        .iter()
        .filter_map(|entry| entry.pointer("/fields/name").and_then(Value::as_str))
        .any(|name| name == permission_type);
    if !has_permission {
        return Err(AppError::Forbidden(format!(
            "The authenticated agent lacks current {permission} permission"
        )));
    }
    Ok(package)
}

async fn require_messaging_reader(
    state: &AppState,
    auth: &AuthInfo,
    group_id: &str,
) -> Result<String, AppError> {
    require_messaging_permission(state, auth, group_id, "MessagingReader").await
}

async fn messaging_group_digests(
    state: &AppState,
    auth: &AuthInfo,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let group_id = crate::chain_reads::id(
        input
            .id
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
    )?;
    require_messaging_reader(state, auth, &group_id).await?;

    let limit = input.limit.unwrap_or(20).clamp(1, 100);
    let offset = input.offset.unwrap_or(0).min(100_000);
    let mut rows = fetch(
        state,
        &format!("/groups/{group_id}/digests"),
        &[
            ("limit".into(), limit.to_string()),
            ("offset".into(), offset.to_string()),
        ],
    )
    .await?;
    let items = rows
        .as_array()
        .ok_or_else(|| AppError::Internal("Messaging digest response is not a list".into()))?;
    if items.len() > limit as usize
        || items.iter().any(|item| {
            item.get("groupId")
                .and_then(Value::as_str)
                .is_none_or(|id| !crate::chain_reads::same(id, &group_id))
        })
    {
        return Err(AppError::Conflict(
            "Messaging digest response does not match the authorized group".into(),
        ));
    }
    normalize_messaging_rows(&mut rows, &[])?;
    Ok(serde_json::json!({
        "groupId": group_id,
        "items": rows,
        "limit": limit,
        "offset": offset,
        "membershipEvidence": "configured_fullnode_current_messaging_reader",
        "digestSource": "social_indexer",
    }))
}

/// Enumerates current permissioned-group members from the configured fullnode only after the
/// caller's own MessagingReader permission has been rechecked against that exact group.
async fn messaging_group_members(
    state: &AppState,
    auth: &AuthInfo,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let group_id = crate::chain_reads::id(
        input
            .id
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
    )?;
    require_messaging_reader(state, auth, &group_id).await?;
    let group = crate::chain_reads::object(state, &group_id).await?;
    let table_id = crate::chain_reads::id(
        group
            .pointer("/content/fields/permissions/fields/id/id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::Internal("Messaging group permission table is unavailable".into())
            })?,
    )?;
    let limit = input.limit.unwrap_or(50).clamp(1, 100);
    let cursor = input
        .cursor
        .as_deref()
        .map(crate::chain_reads::id)
        .transpose()?;
    let page = crate::chain_reads::rpc(
        state,
        "mysox_getDynamicFields",
        serde_json::json!([table_id, cursor, limit]),
    )
    .await?;
    let rows = page["data"]
        .as_array()
        .ok_or_else(|| AppError::Internal("Messaging member page is unavailable".into()))?;
    if rows.len() > limit as usize {
        return Err(AppError::Conflict(
            "Messaging member page exceeded its requested bound".into(),
        ));
    }
    let mut field_ids = HashSet::new();
    let mut members = HashSet::new();
    let mut targets = Vec::with_capacity(rows.len());
    let mut last = None;
    for row in rows {
        let field_id =
            crate::chain_reads::id(row.get("objectId").and_then(Value::as_str).ok_or_else(
                || AppError::Internal("Messaging member field ID is unavailable".into()),
            )?)?;
        if !field_ids.insert(field_id.clone()) {
            return Err(AppError::Conflict(
                "Messaging member page contains a duplicate field".into(),
            ));
        }
        last = Some(field_id.clone());
        if crate::chain_reads::coin_type(
            row.pointer("/name/type")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Internal("Messaging member key type is unavailable".into())
                })?,
        )? != crate::chain_reads::coin_type("address")?
        {
            return Err(AppError::Conflict(
                "Messaging member page contains an unexpected key type".into(),
            ));
        }
        let member = crate::chain_reads::address(row.pointer("/name/value"))?;
        if !members.insert(member.clone()) {
            return Err(AppError::Conflict(
                "Messaging member page contains a duplicate address".into(),
            ));
        }
        targets.push((field_id, member));
    }
    let has_next = page["hasNextPage"].as_bool().ok_or_else(|| {
        AppError::Internal("Messaging member pagination state is unavailable".into())
    })?;
    let next = match page.get("nextCursor") {
        None | Some(Value::Null) => None,
        Some(value) => Some(crate::chain_reads::id(value.as_str().ok_or_else(
            || AppError::Internal("Messaging member cursor is invalid".into()),
        )?)?),
    };
    if has_next && (targets.is_empty() || next.is_none() || next == cursor || next != last) {
        return Err(AppError::Conflict(
            "Messaging member cursor is inconsistent".into(),
        ));
    }
    let items = stream::iter(targets)
        .map(|(field_id, member_address)| async move {
            let field = crate::chain_reads::object(state, &field_id).await?;
            let actual_type = field
                .pointer("/content/type")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Internal("Messaging member permission type is unavailable".into())
                })?;
            let expected =
                "0x2::dynamic_field::Field<address,0x2::vec_set::VecSet<0x1::type_name::TypeName>>";
            if crate::chain_reads::coin_type(actual_type)?
                != crate::chain_reads::coin_type(expected)?
            {
                return Err(AppError::Conflict(
                    "Messaging member entry has an unexpected permission type".into(),
                ));
            }
            let contents = field
                .pointer("/content/fields/value/fields/contents")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    AppError::Internal("Messaging member permissions are unavailable".into())
                })?;
            let mut permissions = contents
                .iter()
                .map(|entry| {
                    entry
                        .pointer("/fields/name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty() && name.len() <= 512)
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            AppError::Conflict(
                                "Messaging member contains an invalid permission name".into(),
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            permissions.sort();
            permissions.dedup();
            Ok(serde_json::json!({"address":member_address,"permissions":permissions}))
        })
        .buffered(4)
        .try_collect::<Vec<_>>()
        .await?;
    Ok(serde_json::json!({
        "groupId": group_id,
        "members": items,
        "limit": limit,
        "hasNextPage": has_next,
        "nextCursor": if has_next { next } else { None },
        "membershipEvidence": "configured_fullnode_current_messaging_reader",
        "source": "configured_fullnode_permission_table",
    }))
}

async fn messaging_message_receipt(
    state: &AppState,
    auth: &AuthInfo,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let group_id = crate::chain_reads::id(
        input
            .id
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
    )?;
    let sequence = input
        .seq
        .as_deref()
        .filter(|value| {
            !value.is_empty()
                && (value == &"0" || !value.starts_with('0'))
                && value.bytes().all(|byte| byte.is_ascii_digit())
        })
        .ok_or_else(|| AppError::BadRequest("seq must be an unsigned decimal sequence".into()))?;
    let sequence_number = sequence
        .parse::<u64>()
        .map_err(|_| AppError::BadRequest("seq is outside the supported range".into()))?;
    if sequence_number > i64::MAX as u64 {
        return Err(AppError::BadRequest(
            "seq is outside the indexer's supported range".into(),
        ));
    }
    let package = require_messaging_reader(state, auth, &group_id).await?;
    let rows = fetch(
        state,
        &format!("/groups/{group_id}/digests"),
        &[
            ("limit".into(), "1".into()),
            ("offset".into(), sequence.to_owned()),
        ],
    )
    .await?;
    let row = rows
        .as_array()
        .and_then(|items| (items.len() == 1).then(|| &items[0]))
        .ok_or_else(|| {
            AppError::BlobNotFound("Message sequence is not indexed for this group".into())
        })?;
    if row
        .get("groupId")
        .and_then(Value::as_str)
        .is_none_or(|id| !crate::chain_reads::same(id, &group_id))
        || crate::chain_reads::u64_value(row.get("seq"))? != sequence_number
    {
        return Err(AppError::Conflict(
            "Indexed message sequence does not match the requested room anchor".into(),
        ));
    }
    let digest = row
        .get("transactionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Internal("Message anchor transaction digest is unavailable".into())
        })?;
    crate::chain_reads::digest_bytes(digest)
        .map_err(|_| AppError::Internal("Message anchor transaction digest is invalid".into()))?;
    let transaction = crate::chain_reads::rpc(
        state,
        "myso_getTransactionBlock",
        serde_json::json!([digest,{"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if transaction.get("digest").and_then(Value::as_str) != Some(digest) {
        return Err(AppError::Internal(
            "Message receipt transaction identity is invalid".into(),
        ));
    }
    match transaction
        .pointer("/effects/status/status")
        .and_then(Value::as_str)
    {
        Some("failure") => {
            return Err(AppError::Conflict(
                "Message anchor transaction failed on chain".into(),
            ))
        }
        Some("success") => {}
        _ => {
            return Err(AppError::Conflict(
                "Message anchor transaction status is unavailable".into(),
            ))
        }
    }
    let checkpoint = transaction
        .get("checkpoint")
        .filter(|value| !value.is_null());
    if checkpoint.is_none() {
        return Ok(
            serde_json::json!({"groupId":group_id,"seq":sequence,"digest":digest,"status":"checkpoint_pending","events":[],"membershipEvidence":"configured_fullnode_current_messaging_reader"}),
        );
    }
    let event_package =
        crate::chain_reads::coin_type(&format!("{}::message_log::MessageDigestSent", package))?;
    let events = transaction
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Internal("Message receipt events are unavailable".into()))?;
    let mut matched = Vec::new();
    for event in events {
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            continue;
        };
        if crate::chain_reads::coin_type(event_type).ok().as_deref() != Some(event_package.as_str())
        {
            continue;
        }
        let Some(data) = event.get("parsedJson") else {
            continue;
        };
        let content_digest = match data.get("content_digest") {
            Some(Value::Array(bytes)) => bytes
                .iter()
                .map(|byte| {
                    byte.as_u64()
                        .and_then(|value| u8::try_from(value).ok())
                        .map(|value| format!("{value:02x}"))
                })
                .collect::<Option<String>>(),
            Some(Value::String(value)) => Some(
                value
                    .strip_prefix("0x")
                    .unwrap_or(value)
                    .to_ascii_lowercase(),
            ),
            _ => None,
        };
        let indexed_digest = row
            .get("contentDigest")
            .and_then(Value::as_str)
            .map(|value| {
                value
                    .strip_prefix("0x")
                    .unwrap_or(value)
                    .to_ascii_lowercase()
            });
        let matched_anchor = data
            .get("group_id")
            .and_then(Value::as_str)
            .is_some_and(|id| crate::chain_reads::same(id, &group_id))
            && crate::chain_reads::u64_value(data.get("seq"))? == sequence_number
            && data.get("sender").and_then(Value::as_str)
                == row.get("sender").and_then(Value::as_str)
            && data.get("recipient").and_then(Value::as_str)
                == row.get("recipient").and_then(Value::as_str)
            && content_digest.as_deref() == indexed_digest.as_deref()
            && data.get("content_uri").and_then(Value::as_str)
                == row.get("contentUri").and_then(Value::as_str)
            && crate::chain_reads::u64_value(data.get("created_at_ms"))?
                == crate::chain_reads::u64_value(row.get("createdAtMs"))?;
        if matched_anchor {
            matched.push(data.clone());
        }
    }
    if matched.len() != 1 {
        return Err(AppError::Conflict("Finalized message transaction does not contain exactly one matching MessageDigestSent event".into()));
    }
    let mut event = matched.remove(0);
    let event_sequence = crate::chain_reads::u64_value(event.get("seq"))?;
    event["seq"] = Value::String(event_sequence.to_string());
    Ok(serde_json::json!({
        "groupId":group_id,"seq":sequence,"digest":digest,"status":"finalized",
        "checkpoint":checkpoint.map(Value::to_string),"event":event,
        "membershipEvidence":"configured_fullnode_current_messaging_reader",
        "evidenceSource":"configured_fullnode_and_group_scoped_indexer_anchor",
    }))
}
async fn social_mydata_read(
    state: &AppState,
    auth: &AuthInfo,
    resource: &str,
    input: &ReadQuery,
) -> Result<Value, AppError> {
    let id = || social_record_id(input.id.as_deref(), "id");
    let page = || {
        vec![
            (
                "limit".into(),
                input.limit.unwrap_or(20).clamp(1, 100).to_string(),
            ),
            (
                "offset".into(),
                input.offset.unwrap_or(0).min(100_000).to_string(),
            ),
        ]
    };
    let value = match resource {
        "social_mydata_buyer_purchases" => {
            let owner = object_id(&auth.owner)?;
            let agent = object_id(&auth.derived_address)?;
            // Report continuation explicitly so app clients can page both wallet
            // histories together without treating a full page as proof of more data.
            let requested_limit = input.limit.unwrap_or(20).clamp(1, 100);
            let offset = input.offset.unwrap_or(0).min(100_000);
            let limit = if offset < 100_000 {
                requested_limit.min(100_000 - offset)
            } else {
                requested_limit
            };
            let query = vec![
                ("limit".into(), limit.to_string()),
                ("offset".into(), offset.to_string()),
            ];
            let owner_purchases =
                fetch(state, &format!("/mydata/buyer/{owner}/purchases"), &query).await?;
            let agent_purchases = if owner == agent {
                Value::Array(vec![])
            } else {
                fetch(state, &format!("/mydata/buyer/{agent}/purchases"), &query).await?
            };
            let owner_has_more = owner_purchases
                .as_array()
                .is_some_and(|rows| rows.len() == limit as usize)
                && offset < 100_000;
            let agent_has_more = agent_purchases
                .as_array()
                .is_some_and(|rows| rows.len() == limit as usize)
                && offset < 100_000;
            let has_more = owner_has_more || agent_has_more;
            serde_json::json!({
                "ownerAddress": owner,
                "agentAddress": agent,
                "ownerPurchases": owner_purchases,
                "agentPurchases": agent_purchases,
                "limit": limit,
                "offset": offset,
                "hasMore": has_more,
                "nextOffset": if has_more { Some(offset + limit) } else { None },
                "notice": "Indexed buyer history only. Verify transaction finality and current access separately before relying on a purchase."
            })
        }
        "social_mydata_list" => {
            let mut query = page();
            if let Some(creator) = input.creator.as_deref() {
                query.push(("creator".into(), object_id(creator)?));
            }
            if let Some(media_type) = input.media_type.as_deref() {
                if media_type.is_empty()
                    || media_type.len() > 128
                    || media_type.bytes().any(|byte| byte.is_ascii_control())
                {
                    return Err(AppError::BadRequest(
                        "media_type must be 1-128 printable bytes".into(),
                    ));
                }
                query.push(("media_type".into(), media_type.to_owned()));
            }
            if let Some(platform) = input.platform_id.as_deref() {
                query.push(("platform_id".into(), object_id(platform)?));
            }
            if let Some(sort) = input.sort_by.as_deref() {
                if !["price", "updated", "created"].contains(&sort) {
                    return Err(AppError::BadRequest(
                        "sort_by must be price, updated or created".into(),
                    ));
                }
                query.push((
                    "sort_by".into(),
                    if sort == "created" {
                        "".into()
                    } else {
                        sort.into()
                    },
                ));
            }
            fetch(state, "/mydata", &query).await?
        }
        "social_mydata_popular"
        | "social_mydata_broad_pools"
        | "social_mydata_distribution_rounds" => {
            let path = match resource {
                "social_mydata_popular" => "/mydata/popular",
                "social_mydata_broad_pools" => "/mydata/broad-pools",
                _ => "/mydata/distribution-rounds",
            };
            fetch(state, path, &page()).await?
        }
        "social_mydata_configuration" => fetch(state, "/mydata/configuration", &[]).await?,
        "social_mydata_listing"
        | "social_mydata_has_access"
        | "social_mydata_purchases"
        | "social_mydata_subscriptions"
        | "social_mydata_revenue"
        | "social_mydata_access_logs"
        | "social_mydata_stats"
        | "social_mydata_revenue_timeline"
        | "social_mydata_access_analytics"
        | "social_mydata_listing_sub_pools" => {
            let listing_id = id()?;
            match resource {
                "social_mydata_listing" => {
                    fetch(state, &format!("/mydata/{listing_id}"), &[]).await?
                }
                "social_mydata_has_access" => {
                    let address = object_id(
                        input
                            .address
                            .as_deref()
                            .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
                    )?;
                    fetch(
                        state,
                        &format!("/mydata/{listing_id}/has-access/{address}"),
                        &[],
                    )
                    .await?
                }
                "social_mydata_purchases" => {
                    fetch(state, &format!("/mydata/{listing_id}/purchases"), &page()).await?
                }
                "social_mydata_subscriptions" => {
                    fetch(
                        state,
                        &format!("/mydata/{listing_id}/subscriptions"),
                        &page(),
                    )
                    .await?
                }
                "social_mydata_revenue" => {
                    fetch(state, &format!("/mydata/{listing_id}/revenue"), &page()).await?
                }
                "social_mydata_access_logs" => {
                    fetch(state, &format!("/mydata/{listing_id}/access-logs"), &page()).await?
                }
                "social_mydata_stats" => {
                    fetch(state, &format!("/mydata/{listing_id}/stats"), &[]).await?
                }
                "social_mydata_revenue_timeline" => {
                    fetch(
                        state,
                        &format!("/mydata/{listing_id}/revenue-timeline"),
                        &[],
                    )
                    .await?
                }
                "social_mydata_access_analytics" => {
                    fetch(
                        state,
                        &format!("/mydata/{listing_id}/access-analytics"),
                        &[],
                    )
                    .await?
                }
                _ => fetch(state, &format!("/mydata/{listing_id}/sub-pools"), &page()).await?,
            }
        }
        "social_mydata_creator_listings" => {
            let creator = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            fetch(state, &format!("/creators/{creator}/mydata"), &page()).await?
        }
        "social_mydata_broad_pool_sub_pools" | "social_mydata_sub_pool_listings" => {
            let pool_id = id()?;
            let path = if resource == "social_mydata_broad_pool_sub_pools" {
                format!("/mydata/broad-pools/{pool_id}/sub-pools")
            } else {
                format!("/mydata/sub-pools/{pool_id}/listings")
            };
            fetch(state, &path, &page()).await?
        }
        "social_mydata_snapshot_anchor"
        | "social_mydata_snapshot_distribution"
        | "social_mydata_snapshot_merkle_root"
        | "social_mydata_snapshot_escrow"
        | "social_mydata_snapshot_claims" => {
            let snapshot_id = id()?;
            let suffix = match resource {
                "social_mydata_snapshot_anchor" => "anchor",
                "social_mydata_snapshot_distribution" => "distribution",
                "social_mydata_snapshot_merkle_root" => "merkle-root",
                "social_mydata_snapshot_escrow" => "escrow",
                _ => "claims",
            };
            let query = if resource == "social_mydata_snapshot_claims" {
                page()
            } else {
                vec![]
            };
            fetch(
                state,
                &format!("/mydata/snapshots/{snapshot_id}/{suffix}"),
                &query,
            )
            .await?
        }
        _ => {
            return Err(AppError::BadRequest(
                "unknown social MyData read resource".into(),
            ))
        }
    };
    Ok(value)
}
pub(crate) async fn owned_task(
    state: &AppState,
    auth: &AuthInfo,
    id: &str,
) -> Result<Value, AppError> {
    let value = fetch(state, &format!("/tasks/{id}"), &[]).await?;
    let participant = ["buyerMemoryAccountId", "sellerMemoryAccountId"]
        .iter()
        .filter_map(|key| value.get(*key).and_then(Value::as_str))
        .any(|account| same_id(account, &auth.account_id));
    if !participant {
        return Err(AppError::BlobNotFound("record unavailable".into()));
    }
    Ok(value)
}
async fn task_deliverable(state: &AppState, auth: &AuthInfo, id: &str) -> Result<Value, AppError> {
    const MAX_ARTIFACT_BYTES: usize = 512 * 1024;
    let task = owned_task(state, auth, id).await?;
    let status = task
        .get("status")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Internal("task status is unavailable".into()))?;
    if !matches!(status, 2 | 3 | 6) {
        return Err(AppError::Conflict(
            "The task has no delivered artifact".into(),
        ));
    }
    let uri = task
        .get("deliverableUri")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BlobNotFound("Task artifact is unavailable".into()))?;
    let storage_ref = uri.strip_prefix("r2://").ok_or_else(|| {
        AppError::BadRequest("Only Cloudflare R2 task artifacts can be retrieved".into())
    })?;
    let (owner, object_key) = storage_ref
        .split_once('/')
        .ok_or_else(|| AppError::Internal("task artifact storage reference is invalid".into()))?;
    if owner.len() != 66
        || !owner.starts_with("0x")
        || !owner[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
        || object_key.len() != 64
        || !object_key.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::Internal(
            "task artifact storage reference is invalid".into(),
        ));
    }
    let seller = task
        .get("sellerPrincipal")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("task seller identity is unavailable".into()))?;
    if !same_id(owner, seller) {
        return Err(AppError::Forbidden(
            "task artifact storage owner does not match the task seller".into(),
        ));
    }
    let expected_digest = task
        .get("deliverableDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("task artifact digest is unavailable".into()))?;
    if expected_digest.len() != 64 || !expected_digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::Internal("task artifact digest is invalid".into()));
    }
    // The social indexer's delivered status is a discovery hint, not authority
    // to disclose private artifact bytes. Require the indexed transition to be
    // independently finalized and bind the fullnode event to this exact R2
    // reference and digest before reading the object.
    let history = task_history(state, auth, id, 100, 0).await?;
    let deliveries = history
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|event| {
            event.get("eventType").and_then(Value::as_str).is_some_and(|kind| {
                kind.rsplit("::").next() == Some("TaskDelivered")
            })
        })
        .collect::<Vec<_>>();
    if deliveries.len() != 1 {
        return Err(AppError::Conflict(
            "A unique indexed task-delivery transition is required before artifact access".into(),
        ));
    }
    let delivery = deliveries[0];
    let source = delivery
        .get("sourceEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Conflict("Task delivery event anchor is unavailable".into()))?;
    let (delivery_digest, sequence) = source
        .rsplit_once(':')
        .and_then(|(digest, sequence)| Some((digest, sequence.parse::<u64>().ok()?)))
        .ok_or_else(|| AppError::Conflict("Task delivery event anchor is invalid".into()))?;
    crate::chain_reads::digest_bytes(delivery_digest)
        .map_err(|_| AppError::Conflict("Task delivery transaction digest is invalid".into()))?;
    let transaction = crate::chain_reads::rpc(
        state,
        "myso_getTransactionBlock",
        serde_json::json!([delivery_digest,{"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if transaction.get("digest").and_then(Value::as_str) != Some(delivery_digest)
        || transaction.pointer("/effects/status/status").and_then(Value::as_str) != Some("success")
        || transaction.get("checkpoint").is_none_or(Value::is_null)
    {
        return Err(AppError::Conflict(
            "Task delivery transaction is not finalized successfully".into(),
        ));
    }
    let package = object_id(&state.config.package_id)?;
    let chain_events = transaction
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Conflict("Task delivery events are unavailable".into()))?;
    let mut matching_delivery = Vec::new();
    for event in chain_events {
        let sequence_matches = event
            .pointer("/id/eventSeq")
            .and_then(|value| crate::chain_reads::u64_value(Some(value)).ok())
            == Some(sequence);
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        if !sequence_matches
            || !event_type.ends_with("::agent_task::TaskDelivered")
            || !event_type
                .split("::")
                .next()
                .is_some_and(|actual| same_id(actual, &package))
        {
            continue;
        }
        let parsed = event.get("parsedJson").ok_or_else(|| {
            AppError::Conflict("Finalized task-delivery event data is unavailable".into())
        })?;
        let event_task = parsed.get("task_id").and_then(Value::as_str);
        let event_uri = parsed.get("deliverable_uri").and_then(Value::as_str);
        let event_digest = parsed.get("deliverable_digest").and_then(|value| match value {
            Value::String(text) => {
                let normalized = text.strip_prefix("0x").unwrap_or(text).to_ascii_lowercase();
                (normalized.len() == 64
                    && normalized.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .then_some(normalized)
            }
            Value::Array(bytes) => {
                let mut normalized = String::with_capacity(bytes.len() * 2);
                for byte in bytes {
                    normalized.push_str(&format!("{:02x}", byte.as_u64().filter(|value| *value <= 255)?));
                }
                (normalized.len() == 64).then_some(normalized)
            }
            _ => None,
        });
        if event_task.is_some_and(|actual| same_id(actual, id))
            && event_uri == Some(uri)
            && event_digest.as_deref().is_some_and(|actual| actual.eq_ignore_ascii_case(expected_digest))
        {
            matching_delivery.push(parsed);
        }
    }
    if matching_delivery.len() != 1 {
        return Err(AppError::Conflict(
            "Finalized TaskDelivered evidence does not match the indexed artifact reference and digest".into(),
        ));
    }
    let store = state.r2.as_ref().ok_or_else(|| {
        AppError::Internal("Cloudflare R2 is not configured for task artifact retrieval".into())
    })?;
    let bytes = store.get_task_artifact(owner, object_key).await?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err(AppError::BadRequest(
            "task artifact exceeds the 512 KiB retrieval limit".into(),
        ));
    }
    let actual_digest = hex::encode(Sha256::digest(&bytes));
    if !actual_digest.eq_ignore_ascii_case(expected_digest) {
        return Err(AppError::Conflict(
            "Downloaded task artifact did not match its recorded digest".into(),
        ));
    }
    Ok(serde_json::json!({
        "taskId": id,
        "uri": uri,
        "digestHex": actual_digest,
        "contentBase64": BASE64.encode(&bytes),
        "contentLength": bytes.len(),
        "encoding": "base64",
        "digestVerified": true,
        "verification": "finalized_task_delivery_event_and_r2_sha256",
        "disclosure": "The private R2 task artifact is disclosed to the authenticated participant and connected MCP client.",
    }))
}
async fn mydata_listing_page(
    state: &AppState,
    limit: u32,
    offset: u32,
    creator: Option<&str>,
) -> Result<Value, AppError> {
    let mut query = vec![
        ("limit".into(), limit.to_string()),
        ("offset".into(), offset.to_string()),
        ("sort_by".into(), "created_at".into()),
    ];
    if let Some(creator) = creator {
        query.push(("creator".into(), creator.to_owned()));
    } else {
        query.push(("is_free".into(), "false".into()));
    }
    let rows = fetch(state, "/mydata", &query).await?;
    let rows = rows
        .as_array()
        .ok_or_else(|| AppError::Internal("invalid MyData listing response".into()))?;
    let scanned_count = rows.len().min(u32::MAX as usize) as u32;
    let listings = rows.iter().filter(|row| {
        let is_paid = ["one_time_price", "subscription_price"].iter().any(|key| row.get(key).and_then(Value::as_i64).is_some_and(|price| price > 0));
        let media_type = row.get("media_type").and_then(Value::as_str).unwrap_or("");
        let is_graph = media_type.starts_with("application/vnd.mysocial.knowledge-graph+json")
            || media_type.starts_with("application/vnd.mysocial.graph-manifest+json");
        is_paid && (creator.is_some() || !is_graph)
    }).filter_map(|row| {
        let id = row.get("mydata_id")?.as_str()?;
        let owner = row.get("owner")?.as_str()?;
        let mydata_id = object_id(id).ok()?;
        let owner = object_id(owner).ok()?;
        let price = |key: &str| -> Option<String> {
            let value = row.get(key)?;
            if value.is_null() { return None; }
            Some(value.as_i64()?.to_string())
        };
        let tags = row.get("tags").and_then(Value::as_array).map(|items| items.iter()
            .filter_map(Value::as_str).take(20).map(|tag| tag.chars().take(80).collect::<String>()).collect::<Vec<_>>()).unwrap_or_default();
        Some(serde_json::json!({
            "mydataId": mydata_id,
            "owner": owner,
            "mediaType": row.get("media_type").and_then(Value::as_str).unwrap_or("unknown").chars().take(80).collect::<String>(),
            "tags": tags,
            "oneTimePriceMist": price("one_time_price"),
            "subscriptionPriceMist": price("subscription_price"),
            "subscriptionDurationDays": row.get("subscription_duration_days").and_then(Value::as_i64).unwrap_or(0).max(0).to_string(),
            "createdAt": row.get("created_at").and_then(Value::as_i64).unwrap_or(0).max(0).to_string(),
        }))
    }).collect::<Vec<_>>();
    let next_offset =
        if scanned_count == limit && offset < 100_000 && offset + scanned_count <= 100_000 {
            Some(offset + scanned_count)
        } else {
            None
        };
    Ok(
        serde_json::json!({"listings": listings, "offset": offset, "scannedCount": scanned_count, "nextOffset": next_offset}),
    )
}

const MYSO_GRAPH_V1_MEDIA_TYPE: &str = "application/vnd.mysocial.knowledge-graph+json;version=1";
const MYSO_GRAPH_MANIFEST_V1_MEDIA_TYPE: &str =
    "application/vnd.mysocial.graph-manifest+json;version=1";

/// Public discovery preview only. This filters declared indexer metadata; it does not
/// authenticate a seller-signed manifest, validate source rights, or inspect ciphertext.
async fn mydata_graph_offer_page(
    state: &AppState,
    limit: u32,
    offset: u32,
) -> Result<Value, AppError> {
    let query = vec![
        ("limit".into(), limit.to_string()),
        ("offset".into(), offset.to_string()),
        ("sort_by".into(), "created_at".into()),
        ("is_free".into(), "false".into()),
    ];
    let rows = fetch(state, "/mydata", &query).await?;
    let rows = rows
        .as_array()
        .ok_or_else(|| AppError::Internal("invalid MyData graph offer response".into()))?;
    let scanned_count = rows.len().min(u32::MAX as usize) as u32;
    let offers = rows.iter().filter_map(|row| {
        let media_type = row.get("media_type").and_then(Value::as_str)?;
        let schema_version = match media_type {
            MYSO_GRAPH_V1_MEDIA_TYPE => "myso.knowledge-graph.v1",
            MYSO_GRAPH_MANIFEST_V1_MEDIA_TYPE => "myso.graph-manifest.v1",
            _ => return None,
        };
        if !["one_time_price", "subscription_price"].iter().any(|key| row.get(key).and_then(Value::as_i64).is_some_and(|price| price > 0)) { return None; }
        let id = object_id(row.get("mydata_id")?.as_str()?).ok()?;
        let owner = object_id(row.get("owner")?.as_str()?).ok()?;
        let price = |key: &str| -> Option<String> {
            let value = row.get(key)?;
            if value.is_null() { return None; }
            Some(value.as_i64()?.to_string())
        };
        let tags = row.get("tags").and_then(Value::as_array).map(|items| items.iter()
            .filter_map(Value::as_str).take(20).map(|tag| tag.chars().take(80).collect::<String>()).collect::<Vec<_>>()).unwrap_or_default();
        Some(serde_json::json!({
            "mydataId": id,
            "owner": owner,
            "mediaType": media_type,
            "schemaVersion": schema_version,
            "tags": tags,
            "oneTimePriceMist": price("one_time_price"),
            "subscriptionPriceMist": price("subscription_price"),
            "subscriptionDurationDays": row.get("subscription_duration_days").and_then(Value::as_i64).unwrap_or(0).max(0).to_string(),
            "createdAt": row.get("created_at").and_then(Value::as_i64).unwrap_or(0).max(0).to_string(),
        }))
    }).collect::<Vec<_>>();
    let next_offset =
        if scanned_count == limit && offset < 100_000 && offset + scanned_count <= 100_000 {
            Some(offset + scanned_count)
        } else {
            None
        };
    Ok(
        serde_json::json!({"offers": offers, "offset": offset, "scannedCount": scanned_count, "nextOffset": next_offset, "mediaType": "application/vnd.mysocial.graph-offer-preview.v1"}),
    )
}

/// Bounded, fixed-path facade for the public indexed SPT API. These reads are
/// discovery/analytics only and must never be used as current chain authority.
async fn spt_read(state: &AppState, resource: &str, input: &ReadQuery) -> Result<Value, AppError> {
    let limit = input.limit.unwrap_or(20).clamp(1, 100).to_string();
    let offset = input.offset.unwrap_or(0).min(100_000).to_string();
    let page = vec![("limit".to_string(), limit), ("offset".to_string(), offset)];
    let id = || require_id(input);
    let address = |value: Option<&str>| -> Result<String, AppError> {
        object_id(value.ok_or_else(|| AppError::BadRequest("address is required".into()))?)
    };
    let result = match resource {
        "spt_pools" => {
            let mut query = page;
            if let Some(owner) = input.address.as_deref() {
                query.push(("owner".into(), object_id(owner)?));
            }
            if let Some(token_type) = input.token_type {
                query.push(("token_type".into(), token_type.to_string()));
            }
            fetch(state, "/spt/pools", &query).await?
        }
        "spt_pool_by_associated_id" => {
            fetch(
                state,
                &format!("/spt/pools/by-associated-id/{}", id()?),
                &[],
            )
            .await?
        }
        "spt_popular" => {
            fetch(
                state,
                "/spt/popular",
                &[(
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 100).to_string(),
                )],
            )
            .await?
        }
        "spt_user_holdings"
        | "spt_user_reservations"
        | "spt_portfolio_performance"
        | "spt_position_metrics"
        | "spt_position_timeseries"
        | "spt_creator_revenue_streams" => {
            let owner = address(
                input
                    .address
                    .as_deref()
                    .or(input.member.as_deref())
                    .or(input.id.as_deref()),
            )?;
            match resource {
                "spt_user_holdings" => {
                    let mut query = page;
                    if let Some(include) = input.include_reservations {
                        query.push(("include_reservations".into(), include.to_string()));
                    }
                    fetch(state, &format!("/spt/users/{owner}/holdings"), &query).await?
                }
                "spt_user_reservations" => {
                    fetch(state, &format!("/spt/users/{owner}/reservations"), &page).await?
                }
                "spt_portfolio_performance" => {
                    fetch(state, &format!("/spt/portfolios/{owner}/performance"), &[]).await?
                }
                "spt_position_metrics" => {
                    fetch(
                        state,
                        &format!("/spt/users/{owner}/positions/metrics"),
                        &page,
                    )
                    .await?
                }
                "spt_position_timeseries" => {
                    let pool = id()?;
                    let window = input.window.as_deref().unwrap_or("7d");
                    if !["24h", "7d", "30d", "180d", "365d", "all"].contains(&window) {
                        return Err(AppError::BadRequest(
                            "unsupported SPT timeseries window".into(),
                        ));
                    }
                    fetch(
                        state,
                        &format!("/spt/users/{owner}/positions/{pool}/timeseries"),
                        &[("window".into(), window.into())],
                    )
                    .await?
                }
                _ => {
                    let mut query = Vec::new();
                    if let Some(from) = input.from {
                        query.push(("from".into(), from.to_string()));
                    }
                    if let Some(to) = input.to {
                        query.push(("to".into(), to.to_string()));
                    }
                    if input.from.zip(input.to).is_some_and(|(from, to)| from > to) {
                        return Err(AppError::BadRequest(
                            "from must be before or equal to to".into(),
                        ));
                    }
                    fetch(
                        state,
                        &format!("/spt/creators/{owner}/revenue-streams"),
                        &query,
                    )
                    .await?
                }
            }
        }
        "spt_pool"
        | "spt_pool_transactions"
        | "spt_pool_swaps"
        | "spt_pool_transfers"
        | "spt_pool_holdings"
        | "spt_pool_price_history"
        | "spt_pool_revenue"
        | "spt_pool_liquidity_profile" => {
            let pool = id()?;
            let suffix = match resource {
                "spt_pool" => "",
                "spt_pool_transactions" => "/transactions",
                "spt_pool_swaps" => "/swaps",
                "spt_pool_transfers" => "/transfers",
                "spt_pool_holdings" => "/holdings",
                "spt_pool_price_history" => "/price-history",
                "spt_pool_revenue" => "/revenue",
                _ => "/liquidity-profile",
            };
            let query = if suffix.is_empty() || resource == "spt_pool_liquidity_profile" {
                vec![]
            } else {
                page
            };
            fetch(state, &format!("/spt/pools/{pool}{suffix}"), &query).await?
        }
        "spt_configuration" => fetch(state, "/spt/configuration", &[]).await?,
        "spt_top_performers" => fetch(state, "/spt/analytics/top-performers", &[]).await?,
        "spt_market_sentiment" => fetch(state, "/spt/market-sentiment", &[]).await?,
        "spt_trader_leaderboard" => {
            let window = input.window.as_deref().unwrap_or("7d");
            if !["24h", "7d", "30d", "180d", "365d", "all"].contains(&window) {
                return Err(AppError::BadRequest(
                    "unsupported SPT leaderboard window".into(),
                ));
            }
            let sort = input.sort.as_deref().unwrap_or("highest_window_return_pct");
            if ![
                "highest_lifetime_roi",
                "highest_lifetime_net_pl",
                "highest_window_net_pl",
                "highest_window_return_pct",
                "highest_realized_pl_in_window",
                "largest_portfolio_value",
            ]
            .contains(&sort)
            {
                return Err(AppError::BadRequest(
                    "unsupported SPT leaderboard sort".into(),
                ));
            }
            let mut query = page;
            query.push(("window".into(), window.into()));
            query.push(("sort".into(), sort.into()));
            fetch(state, "/spt/leaderboards/traders", &query).await?
        }
        "spt_reservation_pools" => fetch(state, "/spt/reservation-pools", &page).await?,
        "spt_reservation_pool"
        | "spt_reservation_pool_reservations"
        | "spt_reservation_volume_history" => {
            let pool = id()?;
            match resource {
                "spt_reservation_pool" => {
                    fetch(state, &format!("/spt/reservation-pools/{pool}"), &[]).await?
                }
                "spt_reservation_pool_reservations" => {
                    fetch(
                        state,
                        &format!("/spt/reservation-pools/{pool}/reservations"),
                        &page,
                    )
                    .await?
                }
                _ => {
                    let interval = input.interval.as_deref().unwrap_or("hour");
                    if !["event", "five_min", "hour", "day"].contains(&interval) {
                        return Err(AppError::BadRequest(
                            "interval must be event, five_min, hour, or day".into(),
                        ));
                    }
                    let mut query = vec![
                        ("interval".into(), interval.into()),
                        (
                            "limit".into(),
                            input.limit.unwrap_or(168).clamp(1, 500).to_string(),
                        ),
                    ];
                    if let Some(from) = input.from {
                        query.push(("from".into(), from.to_string()));
                    }
                    if let Some(to) = input.to {
                        query.push(("to".into(), to.to_string()));
                    }
                    if input.from.zip(input.to).is_some_and(|(from, to)| from > to) {
                        return Err(AppError::BadRequest(
                            "from must be before or equal to to".into(),
                        ));
                    }
                    fetch(
                        state,
                        &format!("/spt/reservation-pools/{pool}/volume-history"),
                        &query,
                    )
                    .await?
                }
            }
        }
        _ => return Err(AppError::BadRequest("unknown SPT read resource".into())),
    };
    Ok(result)
}

pub async fn read(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(resource): Path<String>,
    Query(input): Query<ReadQuery>,
) -> Result<Json<Value>, AppError> {
    if resource == "jury_case_bundle" {
        return Ok(Json(jury_case_bundle(&state, &auth, &input).await?));
    }
    if resource == "dex_markets" {
        return Ok(Json(orderbook_markets(&state).await?));
    }
    if resource == "dex_market" {
        return Ok(Json(
            orderbook_market_details(&state, input.pool_name.as_deref().unwrap_or("")).await?,
        ));
    }
    if resource == "dex_orderbook" {
        return Ok(Json(
            orderbook_snapshot(
                &state,
                input.pool_name.as_deref().unwrap_or(""),
                input.levels_per_side.unwrap_or(10).clamp(1, 20),
            )
            .await?,
        ));
    }
    if resource == "dex_summary" {
        return Ok(Json(
            orderbook_summary(&state, input.pool_name.as_deref().unwrap_or("")).await?,
        ));
    }
    if resource == "dex_ticker" {
        return Ok(Json(
            orderbook_ticker(&state, input.pool_name.as_deref().unwrap_or("")).await?,
        ));
    }
    if resource == "dex_trades" {
        return Ok(Json(
            orderbook_trades(
                &state,
                input.pool_name.as_deref().unwrap_or(""),
                input.limit.unwrap_or(20).clamp(1, 100),
            )
            .await?,
        ));
    }
    if resource == "dex_status" {
        return Ok(Json(orderbook_status(&state).await?));
    }
    if resource == "mydata_agent_funding_coins" {
        return Ok(Json(
            crate::payments::read_agent_mydata_funding_coins(&state, &auth, &input).await?,
        ));
    }
    if resource == "task_agent_funding_coins" {
        return Ok(Json(
            crate::payments::read_agent_task_funding_coins(&state, &auth, &input).await?,
        ));
    }
    if resource == "task_room" {
        return Ok(Json(
            task_room(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )
            .await?,
        ));
    }
    if resource == "task_room_binding_receipt" {
        return Ok(Json(
            task_room_binding_receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )
            .await?,
        ));
    }
    if resource == "mydata_owner_access_history" {
        return Ok(Json(
            crate::mydata_access::list_owner_access_history(
                &state,
                &auth,
                input.limit.unwrap_or(20),
                input.offset.unwrap_or(0),
            )
            .await?,
        ));
    }
    if resource == "spt_trade_receipt" {
        return Ok(Json(
            crate::spt::receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id digest is required".into()))?,
            )
            .await?,
        ));
    }
    if resource == "spt_quote" {
        return Ok(Json(crate::spt::quote(&state, &input).await?));
    }
    if resource.starts_with("spt_") {
        return Ok(Json(spt_read(&state, &resource, &input).await?));
    }
    if resource.starts_with("social_subscription_") {
        return Ok(Json(
            social_subscription_read(&state, &resource, &input).await?,
        ));
    }
    if resource.starts_with("social_insurance_") {
        return Ok(Json(
            social_insurance_read(&state, &resource, &input).await?,
        ));
    }
    if resource.starts_with("social_vesting_") {
        return Ok(Json(social_vesting_read(&state, &resource, &input).await?));
    }
    if resource.starts_with("social_revenue_") || resource.starts_with("social_treasury_") {
        return Ok(Json(social_revenue_read(&state, &resource, &input).await?));
    }
    if resource.starts_with("social_messaging_") {
        return Ok(Json(
            social_messaging_read(&state, &auth, &resource, &input).await?,
        ));
    }
    if resource.starts_with("social_mydata_") {
        return Ok(Json(
            social_mydata_read(&state, &auth, &resource, &input).await?,
        ));
    }
    if resource == "dex_receipt" {
        return Ok(Json(
            crate::dex::receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id digest is required".into()))?,
            )
            .await?,
        ));
    }
    if resource == "chain_action_receipt" {
        return Ok(Json(
            verify_prepared_action_receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id digest is required".into()))?,
            )
            .await?,
        ));
    }
    if resource == "chain_action_by_idempotency_key" {
        let key = input.idempotency_key.as_deref().ok_or_else(|| {
            AppError::BadRequest("idempotency_key is required".into())
        })?;
        if key.is_empty() || key.len() > 128 || !key.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err(AppError::BadRequest("idempotency_key is invalid".into()));
        }
        let row = crate::chain_actions::get_by_idempotency_key(
            &state.db,
            &auth.account_id,
            &auth.agent_object_id,
            key,
        )
        .await?
        .ok_or_else(|| AppError::BlobNotFound("registered action is unavailable".into()))?;
        return Ok(Json(json!({
            "idempotencyKey": row.idempotency_key,
            "registryAction": row.registry_action,
            "registryVersion": row.registry_version,
            "accountId": row.account_id,
            "agentId": row.agent_object_id,
            "status": row.status,
            "digest": row.digest,
            "parameterHash": row.parameter_hash,
            "expiresAtMs": row.expires_at_ms,
            "evidenceSource": "authenticated_chain_action_journal"
        })));
    }
    if resource == "chain_action_approvals" {
        let rows = crate::action_approvals::list_for_agent(
            &state.db, &auth.account_id, &auth.agent_object_id, input.limit.unwrap_or(50).clamp(1, 100),
        ).await?;
        return Ok(Json(serde_json::json!({"items": rows.iter().map(|row| serde_json::json!({
            "approvalId": row.approval_id,
            "registryAction": row.registry_action,
            "registryVersion": row.registry_version,
            "idempotencyKey": row.idempotency_key,
            "parameterHash": row.parameter_hash,
            "parameters": row.parameters,
            "requiredCapability": row.required_capability,
            "riskTier": row.risk_tier,
            "ownerAddress": row.owner_address,
            "approvalIntent": row.approval_intent,
            "status": row.status,
            "expiresAtMs": row.expires_at_ms,
        })).collect::<Vec<_>>() })));
    }
    if resource.starts_with("social_poc_") {
        let id = || require_id(&input);
        let page = vec![
            (
                "limit".into(),
                input.limit.unwrap_or(20).clamp(1, 100).to_string(),
            ),
            (
                "offset".into(),
                input.offset.unwrap_or(0).min(100_000).to_string(),
            ),
        ];
        let value = match resource.as_str() {
            "social_poc_analytics" => fetch(&state, "/poc/analytics", &[]).await?,
            "social_poc_configuration" => fetch(&state, "/poc/configuration", &[]).await?,
            "social_poc_badges" | "social_poc_revenue_redirections" | "social_poc_analysis_results" | "social_poc_disputes" => {
                let path = match resource.as_str() {
                    "social_poc_badges" => "/poc/badges",
                    "social_poc_revenue_redirections" => "/poc/revenue-redirections",
                    "social_poc_analysis_results" => "/poc/analysis-results",
                    _ => "/poc/disputes",
                };
                fetch(&state, path, &page).await?
            }
            "social_poc_badge" => fetch(&state, &format!("/poc/badges/{}", id()?), &[]).await?,
            "social_poc_dispute" => fetch(&state, &format!("/poc/disputes/{}", id()?), &[]).await?,
            "social_poc_dispute_votes" => fetch(&state, &format!("/poc/disputes/{}/votes", id()?), &page).await?,
            "social_poc_username_beneficiaries" => {
                if input.page.is_some() && input.offset.is_some() {
                    return Err(AppError::BadRequest(
                        "page and offset cannot be used together".into(),
                    ));
                }
                let mut query = page.clone();
                if let Some(status) = input.status.as_deref() {
                    let code = status.parse::<i16>().map_err(|_| AppError::BadRequest("status must be a signed 16-bit integer".into()))?;
                    query.push(("status".into(), code.to_string()));
                }
                if input.page.is_some() {
                    query.retain(|(key, _)| key != "offset");
                    query.push(("page".into(), input.page.unwrap().clamp(1, 100_001).to_string()));
                }
                fetch(&state, "/poc/username-beneficiaries", &query).await?
            }
            "social_poc_username_beneficiary" => fetch(&state, &format!("/poc/username-beneficiaries/{}", id()?), &[]).await?,
            "social_poc_username_beneficiary_by_username" => {
                let username = username_path_segment(input.username.as_deref().ok_or_else(|| AppError::BadRequest("username is required".into()))?)?;
                fetch(&state, &format!("/poc/username-beneficiaries/by-username/{username}"), &[]).await?
            }
            "social_poc_vault_by_beneficiary" => {
                let address = object_id(
                    input
                        .address
                        .as_deref()
                        .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
                )?;
                fetch(
                    &state,
                    &format!("/poc/beneficiary-vaults/by-beneficiary/{address}"),
                    &[],
                )
                .await?
            }
            "social_poc_vault" => {
                fetch(&state, &format!("/poc/beneficiary-vaults/{}", id()?), &[]).await?
            }
            "social_poc_vault_balances" => {
                fetch(
                    &state,
                    &format!("/poc/beneficiary-vaults/{}/coin-balances", id()?),
                    &[],
                )
                .await?
            }
            "social_poc_vault_deposits" => {
                fetch(
                    &state,
                    &format!("/poc/beneficiary-vaults/{}/deposits", id()?),
                    &page,
                )
                .await?
            }
            "social_poc_vault_claims" => {
                fetch(
                    &state,
                    &format!("/poc/beneficiary-vaults/{}/claims", id()?),
                    &page,
                )
                .await?
            }
            _ => {
                return Err(AppError::BadRequest(
                    "unknown public PoC read resource".into(),
                ))
            }
        };
        return Ok(Json(value));
    }
    if resource.starts_with("agent_admin_") {
        return Ok(Json(
            crate::owner_agents::read(&state, &auth, &resource, &input).await?,
        ));
    }
    if resource == "organization_treasury_balance" {
        return Ok(Json(
            crate::organization_treasury::read_balance(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("organizationId is required".into()))?,
                input
                    .coin_type
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("coinType is required".into()))?,
            )
            .await?,
        ));
    }
    if resource == "organization_treasury_access" {
        return Ok(Json(
            crate::organization_treasury::read_access(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("organizationId is required".into()))?,
                input
                    .recipient
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("recipient is required".into()))?,
            )
            .await?,
        ));
    }
    if resource.starts_with("payments_") {
        return Ok(Json(
            crate::payments::read(&state, &auth, &resource, &input).await?,
        ));
    }
    if resource.starts_with("poc_") {
        return Ok(Json(
            crate::poc_vault::read(&state, &auth, &resource, input.id.as_deref()).await?,
        ));
    }
    if resource.starts_with("spot_") {
        return Ok(Json(
            crate::spot_payout::read(&state, &auth, &resource, input.id.as_deref()).await?,
        ));
    }
    if resource.starts_with("assets_") {
        return Ok(Json(
            crate::assets::read(&state, &auth, &resource, &input).await?,
        ));
    }
    if resource.starts_with("subscription_") {
        return Ok(Json(
            crate::subscription_access::read(&state, &auth, &resource, &input).await?,
        ));
    }
    let owner = object_id(&auth.owner)?;
    let agent = object_id(&auth.agent_object_id)?;
    let mut page = vec![
        (
            "limit".into(),
            input.limit.unwrap_or(20).clamp(1, 200).to_string(),
        ),
        (
            "offset".into(),
            input.offset.unwrap_or(0).min(100_000).to_string(),
        ),
    ];
    let value = match resource.as_str() {
        "agent_profile_agents" => {
            let address = require_id(&input)?;
            let query = vec![
                (
                    "active_only".into(),
                    input.active_only.unwrap_or(true).to_string(),
                ),
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let mut agents = fetch(&state, &format!("/profiles/{address}/sub-agents"), &query).await?;
            normalize_agent_spend_fields(&mut agents)?;
            agents
        }
        "agent_children" => {
            let query = vec![
                (
                    "active_only".into(),
                    input.active_only.unwrap_or(true).to_string(),
                ),
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let mut agents = fetch(&state, &format!("/sub-agents/{agent}/children"), &query).await?;
            normalize_agent_spend_fields(&mut agents)?;
            agents
        }
        "agent_owned_pnl" => {
            let mut query = vec![
                (
                    "active_only".into(),
                    input.active_only.unwrap_or(false).to_string(),
                ),
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            if let Some(window) = input.window.as_deref() {
                if !["7d", "30d", "180d", "365d", "all"].contains(&window) {
                    return Err(AppError::BadRequest(
                        "window must be 7d, 30d, 180d, 365d, or all".into(),
                    ));
                }
                let windows = match window {
                    "7d" => "days_7",
                    "30d" => "days_30",
                    "180d" => "days_180",
                    "365d" => "days_365",
                    _ => "all",
                };
                query.push(("windows".into(), windows.into()));
            }
            let mut pnl = fetch(&state, &format!("/profiles/{owner}/sub-agents/pnl"), &query).await?;
            normalize_agent_spend_fields(&mut pnl)?;
            pnl
        }
        "agent_own_pnl" => {
            let mut query = Vec::new();
            if let Some(window) = input.window.as_deref() {
                if !["7d", "30d", "180d", "365d", "all"].contains(&window) {
                    return Err(AppError::BadRequest(
                        "window must be 7d, 30d, 180d, 365d, or all".into(),
                    ));
                }
                let windows = match window {
                    "7d" => "days_7",
                    "30d" => "days_30",
                    "180d" => "days_180",
                    "365d" => "days_365",
                    _ => "all",
                };
                query.push(("windows".into(), windows.into()));
            }
            fetch(
                &state,
                &format!("/sub-agents/by-object/{agent}/pnl"),
                &query,
            )
            .await?
        }
        "account_audit_logs" => {
            let mut query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 100).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            for (key, value) in [
                ("action", input.action.as_deref()),
                ("target_type", input.target_type.as_deref()),
                ("source", input.source.as_deref()),
            ] {
                if let Some(value) = value {
                    if value.is_empty()
                        || value.len() > 80
                        || !value.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                        })
                    {
                        return Err(AppError::BadRequest("invalid audit filter".into()));
                    }
                    query.push((key.into(), value.into()));
                }
            }
            fetch(&state, &format!("/profiles/{owner}/audit-logs"), &query).await?
        }
        "governance_vote_quote" => {
            governance_vote_quote(
                &state,
                input
                    .registry_id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("registryId is required".into()))?,
                input
                    .proposal_id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("proposalId is required".into()))?,
                input
                    .vote_count
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("voteCount is required".into()))?,
            )
            .await?
        }
        "governance_vote_receipt" => {
            governance_vote_receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )
            .await?
        }
        "governance_delegate_vote_receipt" => {
            governance_delegate_vote_receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )
            .await?
        }
        "task_receipt" => {
            task_receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )
            .await?
        }
        "jury_receipt" => {
            jury_receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )
            .await?
        }
        "task_settlement_receipt" => {
            task_settlement_receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )
            .await?
        }
        "task_history" => {
            task_history(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
                input.limit.unwrap_or(50),
                input.offset.unwrap_or(0),
            )
            .await?
        }
        "task_lifecycle_history" => {
            task_lifecycle_history(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
                input.limit.unwrap_or(50),
                input.offset.unwrap_or(0),
            )
            .await?
        }
        "mydata_owner_receipt" => {
            crate::mydata_access::get_owner_receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )
            .await?
        }
        "mydata_receipt" => {
            crate::mydata_access::get_receipt(
                &state,
                &auth,
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )
            .await?
        }
        "mydata_quote" => {
            crate::mydata_access::get_quote(&state, &auth, &require_id(&input)?).await?
        }
        "mydata_listings" => {
            let limit = input.limit.unwrap_or(20).clamp(1, 50);
            let offset = input.offset.unwrap_or(0).min(100_000);
            mydata_listing_page(&state, limit, offset, None).await?
        }
        "mydata_graph_offers" => {
            let limit = input.limit.unwrap_or(20).clamp(1, 50);
            let offset = input.offset.unwrap_or(0).min(100_000);
            mydata_graph_offer_page(&state, limit, offset).await?
        }
        "mydata_owned_listings" => {
            let limit = input.limit.unwrap_or(20).clamp(1, 50);
            let offset = input.offset.unwrap_or(0).min(100_000);
            mydata_listing_page(&state, limit, offset, Some(&owner)).await?
        }
        "social_profiles" => {
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(50).clamp(1, 100).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            fetch(&state, "/profiles", &query).await?
        }
        "social_daily_stats" => {
            let bucket = input.bucket.as_deref().unwrap_or("30d");
            if !["7d", "30d", "90d", "180d", "1y"].contains(&bucket) {
                return Err(AppError::BadRequest(
                    "bucket must be 7d, 30d, 90d, 180d, or 1y".into(),
                ));
            }
            fetch(
                &state,
                "/profiles/daily-stats",
                &[("bucket".into(), bucket.into())],
            )
            .await?
        }
        "social_follow_check" => {
            let follower = object_id(
                input
                    .follower
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("follower is required".into()))?,
            )?;
            let following = object_id(
                input
                    .following
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("following is required".into()))?,
            )?;
            fetch(
                &state,
                &format!("/social-graph/check/{follower}/{following}"),
                &[],
            )
            .await?
        }
        "social_graph_chart" => {
            let bucket = input.bucket.as_deref().unwrap_or("30d");
            if !["7d", "30d", "90d", "180d", "1y"].contains(&bucket) {
                return Err(AppError::BadRequest(
                    "bucket must be 7d, 30d, 90d, 180d, or 1y".into(),
                ));
            }
            fetch(
                &state,
                "/social-graph/chart-data",
                &[("bucket".into(), bucket.into())],
            )
            .await?
        }
        "social_posts" | "social_trending_posts" => {
            let limit = input.limit.unwrap_or(20).clamp(1, 50);
            page.clear();
            page.push(("limit".into(), limit.to_string()));
            page.push((
                "offset".into(),
                input.offset.unwrap_or(0).min(100_000).to_string(),
            ));
            let endpoint = if resource == "social_trending_posts" {
                "/posts/trending"
            } else {
                "/posts"
            };
            fetch(&state, endpoint, &page).await?
        }
        "promotion_campaigns"
        | "promotion_rollup"
        | "promotion_top_performing"
        | "promotion_spending_trends"
        | "promotion_campaign"
        | "promotion_stats"
        | "promotion_budget_events"
        | "promotion_status_events"
        | "promotion_views"
        | "promotion_time_series"
        | "promotion_hourly"
        | "promotion_platform_breakdown" => {
            let path_id = || -> Result<String, AppError> {
                promotion_path_segment(input.id.as_deref().ok_or_else(|| AppError::BadRequest("id is required".into()))?)
            };
            let (path, query) = match resource.as_str() {
                "promotion_campaigns" => ("/promotions".to_string(), promotion_list_params(&input, true)?),
                "promotion_rollup" => ("/promotions/analytics/summary".to_string(), promotion_list_params(&input, false)?),
                "promotion_top_performing" => {
                    let mut query = Vec::new();
                    if let Some(limit) = input.limit { query.push(("limit".into(), limit.clamp(1, 100).to_string())); }
                    ("/promotions/analytics/top-performing".into(), query)
                }
                "promotion_spending_trends" => ("/promotions/analytics/spending-trends".into(), promotion_analytics_params(&input, true, 1000, true)?),
                "promotion_campaign" => (format!("/promotions/{}", path_id()?), Vec::new()),
                "promotion_stats" => (format!("/promotions/{}/stats", path_id()?), Vec::new()),
                "promotion_budget_events" | "promotion_status_events" => {
                    let mut query = Vec::new();
                    let limit = input.limit.unwrap_or(20).clamp(1, 100);
                    query.push(("limit".into(), limit.to_string()));
                    if let Some(offset) = input.offset { query.push(("offset".into(), offset.min(100_000).to_string())); }
                    if let Some(page) = input.page { query.push(("page".into(), page.clamp(1, 100_000 / limit + 1).to_string())); }
                    let suffix = if resource == "promotion_budget_events" { "budget-events" } else { "status-events" };
                    (format!("/promotions/{}/{suffix}", path_id()?), query)
                }
                "promotion_views" | "promotion_platform_breakdown" => {
                    let mut query = promotion_analytics_params(&input, false, 100, false)?;
                    query.push(("limit".into(), input.limit.unwrap_or(20).clamp(1, 100).to_string()));
                    query.push(("offset".into(), input.offset.unwrap_or(0).min(100_000).to_string()));
                    let suffix = if resource == "promotion_views" { "views" } else { "analytics/platforms" };
                    (format!("/promotions/{}/{suffix}", path_id()?), query)
                }
                "promotion_time_series" | "promotion_hourly" => {
                    let query = promotion_analytics_params(&input, false, 1000, true)?;
                    let suffix = if resource == "promotion_time_series" { "analytics/time-series" } else { "analytics/hourly" };
                    (format!("/promotions/{}/{suffix}", path_id()?), query)
                }
                _ => return Err(AppError::BadRequest("unknown promotion read resource".into())),
            };
            fetch(&state, &path, &query).await?
        }
        "config_profile" => fetch(&state, "/profile/configuration", &[]).await?,
        "config_platform" => fetch(&state, "/platform/configuration", &[]).await?,
        "config_memory" => fetch(&state, "/memory/configuration", &[]).await?,
        "config_ai_credit" => fetch(&state, "/ai-credit/config", &[]).await?,
        "badge_list" | "badge_get" => {
            if resource == "badge_list" {
                let query = vec![
                    ("limit".into(), input.limit.unwrap_or(20).clamp(1, 100).to_string()),
                    ("offset".into(), input.offset.unwrap_or(0).min(100_000).to_string()),
                ];
                fetch(&state, "/badges", &query).await?
            } else {
                let id = promotion_path_segment(input.id.as_deref().ok_or_else(|| AppError::BadRequest("id is required".into()))?)?;
                fetch(&state, &format!("/badges/{id}"), &[]).await?
            }
        }
        "social_governance_proposals" => {
            let mut query = vec![
                ("limit".into(), input.limit.unwrap_or(20).clamp(1, 100).to_string()),
                ("offset".into(), input.offset.unwrap_or(0).min(100_000).to_string()),
            ];
            if let Some(status) = input.status.as_deref() {
                let status = status.parse::<i16>().map_err(|_| AppError::BadRequest("status must be an integer from 0 to 6".into()))?;
                if !(0..=6).contains(&status) {
                    return Err(AppError::BadRequest("status must be an integer from 0 to 6".into()));
                }
                query.push(("status".into(), status.to_string()));
            }
            if let Some(proposal_type) = input.proposal_type {
                if !(0..=3).contains(&proposal_type) {
                    return Err(AppError::BadRequest("proposal_type must be an integer from 0 to 3".into()));
                }
                query.push(("proposal_type".into(), proposal_type.to_string()));
            }
            if let Some(platform_id) = input.platform_id.as_deref() {
                query.push(("platform_id".into(), object_id(platform_id)?));
            }
            if let Some(submitter) = input.submitter.as_deref() {
                query.push(("submitter".into(), object_id(submitter)?));
            }
            let mut rows = fetch(&state, "/governance/proposals", &query).await?;
            let proposals = rows.as_array_mut().ok_or_else(|| AppError::Internal("governance proposal list response was not an array".into()))?;
            for proposal in proposals {
                for key in ["delegate_approval_count", "delegate_rejection_count", "community_votes_for", "community_votes_against", "reward_pool", "anonymous_voters_count"] {
                    let Some(value) = proposal.get(key) else {
                        return Err(AppError::Internal(format!("governance proposal {key} was missing")));
                    };
                    if value.is_null() && key == "anonymous_voters_count" {
                        continue;
                    }
                    let amount = value.as_i64()
                        .filter(|amount| *amount >= 0)
                        .ok_or_else(|| AppError::Internal(format!("governance proposal {key} was invalid")))?;
                    proposal[key] = json!(amount.to_string());
                }
            }
            rows
        }
        "social_search" => {
            let query = input
                .query
                .as_deref()
                .map(str::trim)
                .filter(|query| !query.is_empty() && query.len() <= 200)
                .ok_or_else(|| {
                    AppError::BadRequest("query must contain 1 to 200 UTF-8 bytes".into())
                })?;
            let page_number = input.page.unwrap_or(1).clamp(1, 10_000);
            let limit = input.limit.unwrap_or(20).clamp(1, 50);
            let mut search = vec![
                ("query".into(), query.to_owned()),
                ("page".into(), page_number.to_string()),
                ("limit".into(), limit.to_string()),
            ];
            if let Some(types) = input.filter_types.as_deref() {
                let allowed = [
                    "profile",
                    "post",
                    "spt-token",
                    "spt-reservation-pool",
                    "governance-registry",
                    "platform",
                    "proposal",
                ];
                let values = types.split(',').map(str::trim).collect::<Vec<_>>();
                if values.is_empty()
                    || values.len() > allowed.len()
                    || values.iter().any(|value| !allowed.contains(value))
                {
                    return Err(AppError::BadRequest(
                        "filter_types contains an unsupported entity type".into(),
                    ));
                }
                search.push(("filter_types".into(), values.join(",")));
            }
            fetch(&state, "/search", &search).await?
        }
        "social_post"
        | "social_post_comments"
        | "social_post_reactions"
        | "social_post_reposts"
        | "social_post_poc_badges"
        | "social_post_revenue_redirections"
        | "social_post_transfers"
        | "social_post_reports"
        | "social_post_moderation_events"
        | "social_post_deletion_events"
        | "social_post_promotion" => {
            let id = require_id(&input)?;
            if resource == "social_post" {
                fetch(&state, &format!("/posts/{id}"), &[]).await?
            } else if resource == "social_post_promotion" {
                fetch(&state, &format!("/posts/{id}/promotion"), &[]).await?
            } else {
                let query = vec![
                    (
                        "limit".into(),
                        input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                    ),
                    (
                        "offset".into(),
                        input.offset.unwrap_or(0).min(100_000).to_string(),
                    ),
                ];
                let endpoint = match resource.as_str() {
                    "social_post_comments" => "comments",
                    "social_post_reactions" => "reactions",
                    "social_post_reposts" => "reposts",
                    "social_post_poc_badges" => "poc-badges",
                    "social_post_revenue_redirections" => "revenue-redirections",
                    "social_post_transfers" => "transfers",
                    "social_post_reports" => "reports",
                    "social_post_moderation_events" => "moderation-events",
                    _ => "deletion-events",
                };
                fetch(&state, &format!("/posts/{id}/{endpoint}"), &query).await?
            }
        }
        "social_profile_posts" => {
            let id = profile_path_segment(
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            fetch(&state, &format!("/profiles/{id}/posts"), &query).await?
        }
        "social_profile" => {
            let address = require_id(&input)?;
            fetch(&state, &format!("/profiles/address/{address}"), &[]).await?
        }
        "social_profile_username" => {
            let username = username_path_segment(
                input
                    .username
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("username is required".into()))?,
            )?;
            fetch(&state, &format!("/profiles/username/{username}"), &[]).await?
        }
        "social_profile_followers" | "social_profile_following" => {
            let address = require_id(&input)?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let relationship = if resource == "social_profile_followers" {
                "followers"
            } else {
                "following"
            };
            fetch(
                &state,
                &format!("/profiles/{address}/{relationship}"),
                &query,
            )
            .await?
        }
        "social_profile_blocked" | "social_profile_blocked_platforms" => {
            let address = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let suffix = if resource == "social_profile_blocked" {
                "blocked"
            } else {
                "blocked-platforms"
            };
            fetch(&state, &format!("/profiles/{address}/{suffix}"), &query).await?
        }
        "social_profile_blocking_history" => {
            let address = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            fetch(
                &state,
                &format!("/profiles/{address}/blocking-history"),
                &query,
            )
            .await?
        }
        "social_username_offers"
        | "social_profile_username_offers"
        | "social_profile_username_sale_fees" => {
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let path =
                match resource.as_str() {
                    "social_username_offers" => {
                        let username =
                            username_path_segment(input.username.as_deref().ok_or_else(|| {
                                AppError::BadRequest("username is required".into())
                            })?)?;
                        format!("/usernames/{username}/offers")
                    }
                    "social_profile_username_offers" => {
                        let address =
                            object_id(input.address.as_deref().ok_or_else(|| {
                                AppError::BadRequest("address is required".into())
                            })?)?;
                        format!("/profiles/{address}/username-offers")
                    }
                    _ => {
                        let address =
                            object_id(input.address.as_deref().ok_or_else(|| {
                                AppError::BadRequest("address is required".into())
                            })?)?;
                        format!("/profiles/{address}/username-sale-fees")
                    }
                };
            fetch(&state, &path, &query).await?
        }
        "social_check_following"
        | "social_check_profile_blocked"
        | "social_check_either_profile_blocked"
        | "social_check_platform_blocked" => {
            let first = object_id(
                input
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("id is required".into()))?,
            )?;
            let path = match resource.as_str() {
                "social_check_following"
                | "social_check_profile_blocked"
                | "social_check_either_profile_blocked" => {
                    let second = object_id(
                        input
                            .address
                            .as_deref()
                            .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
                    )?;
                    match resource.as_str() {
                        "social_check_following" => format!("/social-graph/check/{first}/{second}"),
                        "social_check_profile_blocked" => {
                            format!("/blocklist/check/profile/{first}/{second}")
                        }
                        _ => format!("/blocklist/check/either/{first}/{second}"),
                    }
                }
                _ => {
                    let platform =
                        object_id(input.platform_id.as_deref().ok_or_else(|| {
                            AppError::BadRequest("platform_id is required".into())
                        })?)?;
                    format!("/blocklist/check/platform/{first}/{platform}")
                }
            };
            fetch(&state, &path, &[]).await?
        }
        "social_profile_badges" => {
            let address = require_id(&input)?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            fetch(&state, &format!("/profiles/{address}/badges"), &query).await?
        }
        "social_profile_stats" => {
            let address = require_id(&input)?;
            fetch(&state, &format!("/profiles/{address}/stats"), &[]).await?
        }
        "social_profile_pnl" => {
            let address = require_id(&input)?;
            let mut query = Vec::new();
            if let Some(window) = input.window.as_deref() {
                let indexed_window = match window {
                    "7d" => "days_7",
                    "30d" => "days_30",
                    "180d" => "days_180",
                    "365d" => "days_365",
                    "all" => "all",
                    _ => {
                        return Err(AppError::BadRequest(
                            "window must be 7d, 30d, 180d, 365d or all".into(),
                        ))
                    }
                };
                query.push(("windows".into(), indexed_window.into()));
            }
            fetch(&state, &format!("/profiles/{address}/pnl"), &query).await?
        }
        "social_profile_recommendations" => {
            let address = require_id(&input)?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            fetch(
                &state,
                &format!("/profiles/{address}/recommendations"),
                &query,
            )
            .await?
        }
        "social_profile_events"
        | "social_profile_platform_memberships"
        | "social_profile_platform_events" => {
            let address = require_id(&input)?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let suffix = match resource.as_str() {
                "social_profile_events" => "events",
                "social_profile_platform_memberships" => "platform-memberships",
                _ => "platforms",
            };
            fetch(&state, &format!("/profiles/{address}/{suffix}"), &query).await?
        }
        "organization_categories" => fetch(&state, "/organizations/categories", &[]).await?,
        "organization_leaderboard" => {
            let mut query = vec![
                (
                    "sort".into(),
                    input
                        .sort
                        .as_deref()
                        .ok_or_else(|| AppError::BadRequest("sort is required".into()))?
                        .into(),
                ),
                (
                    "category".into(),
                    input
                        .category
                        .as_deref()
                        .ok_or_else(|| AppError::BadRequest("category is required".into()))?
                        .into(),
                ),
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 100).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            if let Some(window) = input.window {
                query.push(("window".into(), window));
            }
            fetch(&state, "/organizations/leaderboard", &query).await?
        }
        "social_approved_platforms" => {
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            fetch(&state, "/platforms/approved", &query).await?
        }
        "social_platforms" => {
            let mut query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 100).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            if let Some(approved) = input.approved {
                query.push(("approved".into(), approved.to_string()));
            }
            if let Some(governance) = input.governance {
                query.push(("governance".into(), governance.to_string()));
            }
            fetch(&state, "/platforms", &query).await?
        }
        "social_platform" => {
            let id = require_id(&input)?;
            fetch(&state, &format!("/platforms/{id}"), &[]).await?
        }
        "social_platform_members" => {
            let id = require_id(&input)?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            fetch(&state, &format!("/platforms/{id}/members"), &query).await?
        }
        "social_platform_user_access" | "social_platform_membership" => {
            let platform = require_id(&input)?;
            let address = object_id(
                input
                    .address
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("address is required".into()))?,
            )?;
            let path = if resource == "social_platform_user_access" {
                format!("/platforms/{platform}/user-access/{address}")
            } else {
                format!("/platforms/{platform}/membership/{address}")
            };
            fetch(&state, &path, &[]).await?
        }
        "social_platform_blocked" => {
            let id = require_id(&input)?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            fetch(&state, &format!("/platforms/{id}/blocked"), &query).await?
        }
        "social_platform_treasury" | "social_platform_treasury_withdrawals" => {
            let id = require_id(&input)?;
            let path = if resource == "social_platform_treasury" {
                format!("/platforms/{id}/treasury")
            } else {
                format!("/platforms/{id}/treasury/withdrawals")
            };
            let query = if resource == "social_platform_treasury" {
                vec![]
            } else {
                vec![
                    (
                        "limit".into(),
                        input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                    ),
                    (
                        "offset".into(),
                        input.offset.unwrap_or(0).min(100_000).to_string(),
                    ),
                ]
            };
            fetch(&state, &path, &query).await?
        }
        "social_platform_moderators" | "social_platform_events" => {
            let id = require_id(&input)?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let suffix = if resource == "social_platform_moderators" {
                "moderators"
            } else {
                "events"
            };
            fetch(&state, &format!("/platforms/{id}/{suffix}"), &query).await?
        }
        "social_platform_approval" => {
            let id = require_id(&input)?;
            fetch(&state, &format!("/platforms/{id}/approval"), &[]).await?
        }
        "tasks" => {
            let key = match input.role.as_deref().unwrap_or("seller") {
                "buyer" => "buyer_principal",
                "seller" => "seller_principal",
                _ => return Err(AppError::BadRequest("role must be buyer or seller".into())),
            };
            page.push((key.into(), owner.clone()));
            if let Some(status) = input.status.as_deref() {
                if status.len() > 13
                    || !status
                        .split(',')
                        .all(|s| s.parse::<u8>().is_ok_and(|v| v <= 6))
                {
                    return Err(AppError::BadRequest(
                        "status must contain task status codes 0 through 6".into(),
                    ));
                }
                page.push(("status".into(), status.into()));
            }
            let mut rows = fetch(&state, "/tasks", &page).await?;
            normalize_task_money_fields(&mut rows)?;
            rows
        }
        "agent_tasks" => {
            let key = match input.role.as_deref().unwrap_or("seller") {
                "buyer" => "buyer_agent_id",
                "seller" => "seller_agent_id",
                _ => return Err(AppError::BadRequest("role must be buyer or seller".into())),
            };
            page.push((key.into(), agent.clone()));
            if let Some(status) = input.status.as_deref() {
                if status.len() > 13
                    || !status
                        .split(',')
                        .all(|s| s.parse::<u8>().is_ok_and(|v| v <= 6))
                {
                    return Err(AppError::BadRequest(
                        "status must contain task status codes 0 through 6".into(),
                    ));
                }
                page.push(("status".into(), status.into()));
            }
            let mut rows = fetch(&state, "/tasks", &page).await?;
            normalize_task_money_fields(&mut rows)?;
            rows
        }
        "organization_tasks" => {
            let org = object_id(
                auth.organization_id
                    .as_deref()
                    .ok_or_else(|| AppError::Forbidden("agent has no organization".into()))?,
            )?;
            page.push(("organization_id".into(), org));
            if let Some(status) = input.status.as_deref() {
                if status.len() > 13
                    || !status
                        .split(',')
                        .all(|s| s.parse::<u8>().is_ok_and(|v| v <= 6))
                {
                    return Err(AppError::BadRequest(
                        "status must contain task status codes 0 through 6".into(),
                    ));
                }
                page.push(("status".into(), status.into()));
            }
            let mut rows = fetch(&state, "/tasks", &page).await?;
            normalize_task_money_fields(&mut rows)?;
            rows
        }
        "task_market" => {
            let market = vec![
                ("status".into(), "0".into()),
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let mut rows = fetch(&state, "/tasks", &market).await?;
            normalize_task_money_fields(&mut rows)?;
            rows
        }
        "task_market_sellers" => {
            let sort = input.sort.as_deref().unwrap_or("score");
            if !["score", "reviews", "volume"].contains(&sort) {
                return Err(AppError::BadRequest(
                    "sort must be score, reviews, or volume".into(),
                ));
            }
            let query = vec![
                ("sort".into(), sort.into()),
                (
                    "min_reviews".into(),
                    input.min_reviews.unwrap_or(0).min(1_000_000).to_string(),
                ),
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let mut rows = fetch(&state, "/agents/top", &query).await?;
            normalize_task_money_fields(&mut rows)?;
            rows
        }
        "task_market_seller_reputation" => {
            let agent_id = object_id(&require_id(&input)?)?;
            fetch(&state, &format!("/agents/{agent_id}/reputation"), &[]).await?
        }
        "task_market_stats" => {
            let mut stats = fetch(&state, "/task/stats", &[]).await?;
            normalize_task_money_fields(&mut stats)?;
            stats
        }
        "task" => {
            let mut task = owned_task(&state, &auth, &require_id(&input)?).await?;
            normalize_task_money_fields(&mut task)?;
            task
        }
        "task_deliverable" => task_deliverable(&state, &auth, &require_id(&input)?).await?,
        "task_dispute" => {
            let id = require_id(&input)?;
            owned_task(&state, &auth, &id).await?;
            let mut dispute = fetch(&state, &format!("/tasks/{id}/dispute"), &[]).await?;
            normalize_task_money_fields(&mut dispute)?;
            dispute
        }
        "task_config" => {
            let mut config = fetch(&state, "/task/config", &[]).await?;
            normalize_task_money_fields(&mut config)?;
            config
        }
        "agent_receipts" => {
            let mut receipts = fetch(&state, &format!("/agents/{agent}/receipts"), &page).await?;
            normalize_task_money_fields(&mut receipts)?;
            receipts
        }
        "agent_reputation" => fetch(&state, &format!("/agents/{agent}/reputation"), &[]).await?,
        "rooms" => {
            page.push(("principal".into(), owner.clone()));
            fetch(&state, "/agents/rooms", &page).await?
        }
        "organization_rooms" => {
            let org = object_id(
                auth.organization_id
                    .as_deref()
                    .ok_or_else(|| AppError::Forbidden("agent has no organization".into()))?,
            )?;
            crate::organization_treasury::authorize_admin_read(&state, &auth, &org).await?;
            fetch(&state, &format!("/organizations/{org}/rooms"), &page).await?
        }
        "organization_owned" => {
            let mut query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 50).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
                (
                    "active_only".into(),
                    input.active_only.unwrap_or(true).to_string(),
                ),
            ];
            if let Some(org_type) = input.org_type {
                query.push(("org_type".into(), org_type.to_string()));
            }
            fetch(&state, &format!("/profiles/{owner}/organizations"), &query).await?
        }
        "organization_my_invitations" => {
            let invitee = object_id(&auth.derived_address)?;
            let query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 100).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            let rows = fetch(
                &state,
                &format!("/profiles/{invitee}/organization-invitations"),
                &query,
            )
            .await?;
            let items = rows.as_array().ok_or_else(|| {
                AppError::Internal(
                    "organization invitation inbox returned an unexpected shape".into(),
                )
            })?;
            if items.iter().any(|row| {
                row.get("invitee_address")
                    .and_then(Value::as_str)
                    .is_none_or(|address| !same_id(address, &invitee))
            }) {
                return Err(AppError::Internal(
                    "organization invitation inbox returned a row for another wallet".into(),
                ));
            }
            serde_json::json!({"invitations": rows, "evidence": "bounded_pending_invitee_indexer_preview"})
        }
        "organization" => {
            let id = require_id(&input)?;
            fetch(&state, &format!("/organizations/{id}"), &[]).await?
        }
        "organization_statistics" => {
            let org = object_id(&require_id(&input)?)?;
            crate::organization_treasury::authorize_read_permission(
                &state, &auth, &org, "dashboard_viewer",
            )
            .await?;
            let window = input.window.as_deref().unwrap_or("all");
            if !["7d", "30d", "180d", "365d", "all"].contains(&window) {
                return Err(AppError::BadRequest(
                    "window must be 7d, 30d, 180d, 365d, or all".into(),
                ));
            }
            let query = vec![("window".into(), window.into())];
            fetch(&state, &format!("/organizations/{org}/statistics"), &query).await?
        }
        "organization_roles"
        | "organization_role_assignments"
        | "organization_invitations"
        | "organization_memory_permissions"
        | "organization_spend_approvals"
        | "organization_spend_breakdown"
        | "organization_audit_logs" => {
            let org = object_id(
                auth.organization_id
                    .as_deref()
                    .ok_or_else(|| AppError::Forbidden("agent has no organization".into()))?,
            )?;
            let permission = if resource == "organization_audit_logs" {
                "auditor"
            } else {
                "dashboard_viewer"
            };
            crate::organization_treasury::authorize_read_permission(
                &state, &auth, &org, permission,
            )
            .await?;
            let mut query = vec![
                (
                    "limit".into(),
                    input.limit.unwrap_or(20).clamp(1, 100).to_string(),
                ),
                (
                    "offset".into(),
                    input.offset.unwrap_or(0).min(100_000).to_string(),
                ),
            ];
            if resource == "organization_invitations" {
                if input.active_only.unwrap_or(true) {
                    query.push(("status".into(), "pending".into()));
                }
                if let Some(invitee) = input.member.as_deref() {
                    query.push(("invitee".into(), object_id(invitee)?));
                }
            } else if ["organization_role_assignments", "organization_memory_permissions"]
                .contains(&resource.as_str())
            {
                query.push((
                    "active_only".into(),
                    input.active_only.unwrap_or(true).to_string(),
                ));
                if let Some(member) = input.member.as_deref() {
                    query.push(("member".into(), object_id(member)?));
                }
            }
            if resource == "organization_spend_approvals" {
                if let Some(status) = input.status.as_deref() {
                    if status.is_empty()
                        || status.len() > 24
                        || !status
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                    {
                        return Err(AppError::BadRequest("invalid spend approval status".into()));
                    }
                    query.push(("status".into(), status.to_owned()));
                }
                if let Some(agent_id) = input.agent.as_deref() {
                    query.push(("agent".into(), object_id(agent_id)?));
                }
            }
            if resource == "organization_spend_breakdown" {
                let window = input.window.as_deref().unwrap_or("all");
                if !["7d", "30d", "180d", "365d", "all"].contains(&window) {
                    return Err(AppError::BadRequest(
                        "window must be 7d, 30d, 180d, 365d, or all".into(),
                    ));
                }
                query.push(("window".into(), window.into()));
            }
            if resource == "organization_audit_logs" {
                for (key, value) in [
                    ("action", input.action.as_deref()),
                    ("target_type", input.target_type.as_deref()),
                    ("source", input.source.as_deref()),
                ] {
                    if let Some(value) = value {
                        if value.is_empty()
                            || value.len() > 80
                            || !value.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                            })
                        {
                            return Err(AppError::BadRequest("invalid audit filter".into()));
                        }
                        query.push((key.into(), value.into()));
                    }
                }
                if let Some(actor) = input.actor.as_deref() {
                    query.push(("actor".into(), object_id(actor)?));
                }
            }
            let endpoint = match resource.as_str() {
                "organization_roles" => "roles",
                "organization_role_assignments" => "role-assignments",
                "organization_invitations" => "invitations",
                "organization_memory_permissions" => "memory-permissions",
                "organization_spend_approvals" => "approvals",
                "organization_spend_breakdown" => "spend-breakdown",
                _ => "audit-logs",
            };
            fetch(&state, &format!("/organizations/{org}/{endpoint}"), &query).await?
        }
        "jury_assignments" => {
            if let Some(status) = input.status.as_deref() {
                if status.len() > 11
                    || !status
                        .split(',')
                        .all(|s| s.parse::<u8>().is_ok_and(|v| (1..=6).contains(&v)))
                {
                    return Err(AppError::BadRequest(
                        "status must contain jury assignment codes 1 through 6".into(),
                    ));
                }
                page.push(("status".into(), status.into()));
            }
            fetch(&state, &format!("/jury/jurors/{agent}/assignments"), &page).await?
        }
        "jury_roster" => {
            page.push(("owner".into(), owner.clone()));
            if let Some(status) = input.status.as_deref() {
                if status.len() > 5 || !status.split(',').all(|s| matches!(s, "0" | "1" | "3")) {
                    return Err(AppError::BadRequest(
                        "status must contain jury roster codes 0, 1, or 3".into(),
                    ));
                }
                page.push(("status".into(), status.into()));
            }
            fetch(&state, "/jury/roster", &page).await?
        }
        "jury_cases" => {
            let subject_id = input.subject_id.as_deref().map(object_id).transpose()?;
            if input
                .subject_kind
                .is_some_and(|kind| !matches!(kind, 1 | 2))
            {
                return Err(AppError::BadRequest(
                    "subject_kind must be 1 (task) or 2 (governance proposal)".into(),
                ));
            }
            let state_filter = input.state.as_deref();
            if subject_id.is_none() && state_filter.is_none() {
                return Err(AppError::BadRequest(
                    "filter jury cases by subject_id or state".into(),
                ));
            }
            if let Some(state_filter) = state_filter {
                if state_filter.len() > 15
                    || !state_filter
                        .split(',')
                        .all(|s| s.parse::<u8>().is_ok_and(|v| (1..=8).contains(&v)))
                {
                    return Err(AppError::BadRequest(
                        "state must contain jury case codes 1 through 8".into(),
                    ));
                }
                page.push(("state".into(), state_filter.into()));
            }
            if let Some(kind) = input.subject_kind {
                page.push(("subject_kind".into(), kind.to_string()));
            }
            if let Some(subject_id) = subject_id {
                page.push(("subject_id".into(), subject_id));
            }
            fetch(&state, "/jury/cases", &page).await?
        }
        "jury_case" => fetch(&state, &format!("/jury/cases/{}", require_id(&input)?), &[]).await?,
        "jury_case_rationales" => {
            fetch(
                &state,
                &format!("/jury/cases/{}/rationales", require_id(&input)?),
                &[],
            )
            .await?
        }
        "jury_task_dispute" => {
            let id = require_id(&input)?;
            owned_task(&state, &auth, &id).await?;
            fetch(&state, &format!("/tasks/{id}/dispute"), &[]).await?
        }
        "jury_own_profile" => fetch(&state, &format!("/jury/jurors/{agent}"), &[]).await?,
        "jury_cranks" => fetch(&state, "/jury/cranks", &page).await?,
        "jury_proposal_case" => {
            fetch(
                &state,
                &format!("/governance/proposals/{}/jury", require_id(&input)?),
                &[],
            )
            .await?
        }
        "jury_proposal_vote_refunds" => {
            fetch(
                &state,
                &format!("/governance/proposals/{}/vote-refunds", require_id(&input)?),
                &[],
            )
            .await?
        }
        "jury_health" => {
            let query = input
                .min_roster
                .map(|value| vec![("minRoster".into(), value.min(10_000).to_string())])
                .unwrap_or_default();
            fetch(&state, "/jury/health", &query).await?
        }
        "ai_balance" => fetch_ai_credit(&state, &format!("/profiles/{owner}/ai-credit"), &[]).await?,
        "ai_approvals" => {
            let mut query = page.clone();
            if let Some(status) = input.status.as_deref() {
                if status.is_empty()
                    || status.len() > 24
                    || !status
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                {
                    return Err(AppError::BadRequest(
                        "invalid AI spend approval status".into(),
                    ));
                }
                query.push(("status".into(), status.into()));
            }
            if let Some(agent_id) = input.agent.as_deref() {
                query.push(("agent".into(), object_id(agent_id)?));
            }
            fetch_ai_credit(
                &state,
                &format!("/profiles/{owner}/ai-credit/approvals"),
                &query,
            )
            .await?
        }
        "ai_usage" | "ai_reservations" | "ai_reservation" => {
            let balance = fetch_ai_credit(&state, &format!("/profiles/{owner}/ai-credit"), &[]).await?;
            let id = object_id(
                balance
                    .pointer("/balance/balance_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::BlobNotFound("AI credit balance unavailable".into())
                    })?,
            )?;
            if resource == "ai_reservation" {
                let nonce = input
                    .reservation_nonce
                    .filter(|nonce| *nonce >= 0)
                    .ok_or_else(|| {
                        AppError::BadRequest(
                            "reservation_nonce must be a non-negative integer".into(),
                        )
                    })?;
                let reservation = fetch_ai_credit(
                    &state,
                    &format!("/ai-credit/{id}/reservations/{nonce}"),
                    &[],
                )
                .await?;
                ensure_ai_credit_balance_scope(&reservation, &id)?;
                reservation
            } else {
                if resource == "ai_reservations" {
                    if let Some(status) = input.status.as_deref() {
                        if !["reserved", "captured", "cancelled", "expired"].contains(&status) {
                            return Err(AppError::BadRequest("invalid reservation status".into()));
                        }
                        page.push(("status".into(), status.into()));
                    }
                }
                let endpoint = if resource == "ai_usage" {
                    "usage-history"
                } else {
                    "reservations"
                };
                let records = fetch_ai_credit(&state, &format!("/ai-credit/{id}/{endpoint}"), &page).await?;
                ensure_ai_credit_balance_scope(&records, &id)?;
                records
            }
        }
        "account_memory_usage" => account_memory_usage(&state, &auth).await?,
        _ => return Err(AppError::BadRequest("unknown read resource".into())),
    };
    Ok(Json(value))
}
