//! Org memory permission resolution (OrgMemoryReader / OrgMemoryWriter).
//!
//! Grants live on-chain in the org's `PermissionedGroup<MemorySharePackage>` and are
//! indexed by the social server. The relayer resolves them lazily (only handlers that
//! need org scope call this) with a short Redis TTL cache — revocation latency is
//! bounded by the TTL. Failure policy is decided by callers: org writes fail closed,
//! org reads degrade to private + account tiers.

use std::sync::Arc;

use redis::AsyncCommands;
use serde::Deserialize;

use crate::types::{AppError, AppState, AuthInfo};

/// Cache TTL — also the maximum revocation latency for org-shared recall.
const ORG_PERMS_CACHE_TTL_SECS: u64 = 30;

/// Mirror of memory.move `ORG_PERM_*` bits.
pub const ORG_PERM_MEMORY_READ: i64 = 1;
pub const ORG_PERM_MEMORY_WRITE: i64 = 2;

#[derive(Debug, Clone, Copy, Default, serde::Serialize, Deserialize)]
pub struct OrgMemoryPerms {
    pub reader: bool,
    pub writer: bool,
}

#[derive(Debug, Deserialize)]
struct OrgMemoryPermissionRow {
    permission_kind: i64,
    active: bool,
}

/// Resolve the authenticated agent's org memory permissions for its own organization.
/// Returns `Ok(None)` when the agent has no organization.
pub async fn resolve_org_memory_perms(
    state: &Arc<AppState>,
    auth: &AuthInfo,
) -> Result<Option<OrgMemoryPerms>, AppError> {
    let Some(org_id) = auth.organization_id.as_deref() else {
        return Ok(None);
    };

    let cache_key = format!("orgperm:{}:{}", org_id, auth.derived_address);
    {
        let mut redis = state.redis.clone();
        let cached: Option<String> = redis.get(&cache_key).await.unwrap_or(None);
        if let Some(raw) = cached {
            if let Ok(perms) = serde_json::from_str::<OrgMemoryPerms>(&raw) {
                return Ok(Some(perms));
            }
        }
    }

    let url = format!(
        "{}/organizations/{}/memory-permissions?member={}&active_only=true",
        state.config.social_server_url.trim_end_matches('/'),
        org_id,
        auth.derived_address,
    );
    let resp = state
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("org perms fetch failed: {}", e)))?;
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "org perms fetch status {}",
            resp.status()
        )));
    }
    let rows: Vec<OrgMemoryPermissionRow> = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("org perms parse failed: {}", e)))?;

    let mut perms = OrgMemoryPerms::default();
    for row in rows.iter().filter(|r| r.active) {
        if row.permission_kind == ORG_PERM_MEMORY_READ {
            perms.reader = true;
        }
        if row.permission_kind == ORG_PERM_MEMORY_WRITE {
            perms.writer = true;
        }
    }

    {
        let mut redis = state.redis.clone();
        if let Ok(raw) = serde_json::to_string(&perms) {
            let _: Result<(), redis::RedisError> = redis
                .set_ex(&cache_key, raw, ORG_PERMS_CACHE_TTL_SECS)
                .await;
        }
    }

    Ok(Some(perms))
}

/// Authorize a write-path visibility request. Returns the visibility tier plus the
/// organization id to stamp on org-visible rows.
///
/// Policy: `org` requires membership in an org **and** an active `OrgMemoryWriter`
/// grant (fail closed on lookup errors); `account` requires owner co-sign so no lone
/// agent can pollute account-wide context.
pub async fn authorize_write_visibility(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    raw_visibility: &Option<String>,
) -> Result<(i16, Option<String>), AppError> {
    use crate::types::{VISIBILITY_ACCOUNT, VISIBILITY_ORG, VISIBILITY_PRIVATE};

    let visibility = crate::types::parse_visibility(raw_visibility)?;
    match visibility {
        VISIBILITY_ORG => {
            let Some(org_id) = auth.organization_id.clone() else {
                return Err(AppError::Forbidden(
                    "org visibility requires an organization-bound sub-agent".into(),
                ));
            };
            // Fail closed: an unresolved grant must never allow an org-visible write.
            let perms = resolve_org_memory_perms(state, auth).await?.unwrap_or_default();
            if !perms.writer {
                // Best-effort: notify the org admin via workflow inbox so they can
                // grant `OrgMemoryWriter`. Producer failures never block the 403.
                let requested_mask = ORG_PERM_MEMORY_WRITE;
                if let Err(err) = crate::access_request_client::spawn_memory_access_request(
                    state,
                    auth,
                    requested_mask,
                )
                .await
                {
                    tracing::warn!(error = %err, "memory access request producer failed");
                }
                return Err(AppError::Forbidden(
                    "org visibility requires OrgMemoryWriter on the org's memory share group"
                        .into(),
                ));
            }
            Ok((VISIBILITY_ORG, Some(org_id)))
        }
        VISIBILITY_ACCOUNT => {
            if !auth.owner_co_signed {
                return Err(AppError::Forbidden(
                    "account visibility requires owner co-sign".into(),
                ));
            }
            Ok((VISIBILITY_ACCOUNT, None))
        }
        _ => Ok((VISIBILITY_PRIVATE, None)),
    }
}

/// Resolve read-scope flags for a recall request. Org tier requires an active
/// `OrgMemoryReader` grant; lookup failures degrade the read to private + account
/// tiers (second return value = degraded flag) instead of failing the request.
pub async fn resolve_search_scope(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    requested: crate::types::RequestedScope,
) -> (crate::types::SearchScope, bool) {
    use crate::types::{RequestedScope, SearchScope};

    let mut degraded = false;
    let org_grant = match requested {
        RequestedScope::Private | RequestedScope::Account => None,
        RequestedScope::Org | RequestedScope::All => {
            if auth.organization_id.is_none() {
                None
            } else {
                match resolve_org_memory_perms(state, auth).await {
                    Ok(perms) => perms.filter(|p| p.reader).map(|_| {
                        auth.organization_id.clone().expect("org id checked above")
                    }),
                    Err(err) => {
                        tracing::warn!(error = %err, "org perms lookup failed; degrading recall scope");
                        degraded = true;
                        None
                    }
                }
            }
        }
    };

    let scope = match requested {
        RequestedScope::Private => SearchScope::private_only(),
        RequestedScope::Org => SearchScope {
            include_own: false,
            include_org: org_grant.is_some(),
            include_account: false,
            organization_id: org_grant,
        },
        RequestedScope::Account => SearchScope {
            include_own: false,
            include_org: false,
            include_account: true,
            organization_id: None,
        },
        RequestedScope::All => SearchScope {
            include_own: true,
            include_org: org_grant.is_some(),
            // Account tier is readable by any authenticated CAP_MEMORY_READ agent —
            // matches the on-chain decrypt policy.
            include_account: true,
            organization_id: org_grant,
        },
    };
    (scope, degraded)
}
