//! Org memory permission policy (OrgMemoryReader / OrgMemoryWriter).
//!
//! Grants are verified against current chain state on every call (see `org_chain`); the
//! social indexer is never consulted. Org writes fail closed when chain state cannot be
//! verified; org reads degrade to private + account tiers.

use std::sync::Arc;

pub use crate::org_chain::OrgMemoryPerms;
use crate::org_chain::{ChainUnavailable, OrgMember};
use crate::types::{AppError, AppState, AuthInfo};

/// Mirror of memory.move `ORG_PERM_*` bits.
pub const ORG_PERM_MEMORY_WRITE: i64 = 2;

/// Resolve the authenticated agent's org memory permissions for its own organization.
/// Returns `Ok(None)` when the agent has no organization.
pub async fn resolve_org_memory_perms(
    state: &Arc<AppState>,
    auth: &AuthInfo,
) -> Result<Option<OrgMemoryPerms>, ChainUnavailable> {
    let Some(org_id) = auth.organization_id.as_deref() else {
        return Ok(None);
    };
    crate::org_chain::resolve_org_memory_perms(
        &state.http_client,
        &state.config.myso_rpc_url,
        &state.config.package_id,
        OrgMember {
            organization_id: org_id,
            account_id: &auth.account_id,
            owner: &auth.owner,
            member: &auth.derived_address,
        },
    )
    .await
    .map(Some)
}

/// Write gate: only a verified `OrgMemoryWriter` grant passes. Unverifiable chain state is
/// an error, never an implicit grant.
fn require_writer(lookup: Result<Option<OrgMemoryPerms>, ChainUnavailable>) -> Result<bool, AppError> {
    match lookup {
        Ok(perms) => Ok(perms.is_some_and(|p| p.writer)),
        Err(err) => Err(AppError::Internal(format!(
            "org memory permission could not be verified on chain: {err}"
        ))),
    }
}

/// Read gate: returns the org id to include when a verified `OrgMemoryReader` grant exists,
/// plus whether the lookup degraded.
fn reader_scope(
    organization_id: &str,
    lookup: Result<Option<OrgMemoryPerms>, ChainUnavailable>,
) -> (Option<String>, bool) {
    match lookup {
        Ok(perms) => (
            perms.filter(|p| p.reader).map(|_| organization_id.to_string()),
            false,
        ),
        Err(err) => {
            tracing::warn!(error = %err, "org perms lookup failed; degrading recall scope");
            (None, true)
        }
    }
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
            if !require_writer(resolve_org_memory_perms(state, auth).await)? {
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

    let (org_grant, degraded) = match (requested, auth.organization_id.as_deref()) {
        (RequestedScope::Org | RequestedScope::All, Some(org_id)) => {
            reader_scope(org_id, resolve_org_memory_perms(state, auth).await)
        }
        _ => (None, false),
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

#[cfg(test)]
mod tests {
    use super::{reader_scope, require_writer, ChainUnavailable, OrgMemoryPerms};

    const BOTH: OrgMemoryPerms = OrgMemoryPerms { reader: true, writer: true };
    const READER: OrgMemoryPerms = OrgMemoryPerms { reader: true, writer: false };

    fn unavailable() -> ChainUnavailable {
        ChainUnavailable("fullnode unreachable".into())
    }

    #[test]
    fn write_needs_a_verified_writer_grant() {
        assert!(require_writer(Ok(Some(BOTH))).unwrap());
        assert!(!require_writer(Ok(Some(READER))).unwrap());
        assert!(!require_writer(Ok(Some(OrgMemoryPerms::default()))).unwrap());
        assert!(!require_writer(Ok(None)).unwrap());
    }

    #[test]
    fn write_fails_closed_when_chain_state_is_unverifiable() {
        assert!(require_writer(Err(unavailable())).is_err());
    }

    #[test]
    fn read_includes_org_only_for_verified_readers() {
        assert_eq!(reader_scope("0xorg", Ok(Some(READER))), (Some("0xorg".into()), false));
        assert_eq!(reader_scope("0xorg", Ok(Some(OrgMemoryPerms::default()))), (None, false));
        assert_eq!(reader_scope("0xorg", Ok(None)), (None, false));
    }

    #[test]
    fn read_degrades_without_org_when_chain_state_is_unverifiable() {
        assert_eq!(reader_scope("0xorg", Err(unavailable())), (None, true));
    }
}
