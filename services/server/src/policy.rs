use axum::http::HeaderMap;

use crate::memory_contract::{
    check_direct_execution_allowed, check_platform_scope, check_spend_limit, has_cap,
    E_SUB_AGENT_EXPIRED, E_SUB_AGENT_INACTIVE_ANCESTOR, E_SUB_AGENT_MISSING_CAP,
    E_SUB_AGENT_NOT_ACTIVE, MAX_AGENT_DEPTH,
};
use crate::social::SocialSubAgent;

/// Request-scoped policy inputs extracted from headers.
pub struct RequestPolicyInput {
    pub platform_id: Option<String>,
    pub owner_co_signed: bool,
    pub estimated_spend_mist: u64,
}

impl RequestPolicyInput {
    pub fn from_headers(headers: &HeaderMap, owner_co_signed: bool, estimated_spend_mist: u64) -> Self {
        let platform_id = headers
            .get("x-platform-id")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        Self {
            platform_id,
            owner_co_signed,
            estimated_spend_mist,
        }
    }
}

#[derive(Debug, Clone)]
pub enum PolicyError {
    InactiveAgent,
    ExpiredAgent,
    InactiveAncestor,
    MissingCapability { required: u64 },
    WrongPlatformScope,
    ApprovalRequired,
    SpendExceeded,
}

impl PolicyError {
    pub fn error_code(&self) -> u64 {
        match self {
            PolicyError::InactiveAgent => E_SUB_AGENT_NOT_ACTIVE,
            PolicyError::ExpiredAgent => E_SUB_AGENT_EXPIRED,
            PolicyError::InactiveAncestor => E_SUB_AGENT_INACTIVE_ANCESTOR,
            PolicyError::MissingCapability { .. } => E_SUB_AGENT_MISSING_CAP,
            PolicyError::WrongPlatformScope => crate::memory_contract::E_SUB_AGENT_WRONG_PLATFORM_SCOPE,
            PolicyError::ApprovalRequired => crate::memory_contract::E_SUB_AGENT_APPROVAL_REQUIRED,
            PolicyError::SpendExceeded => crate::memory_contract::E_SUB_AGENT_SPEND_EXCEEDED,
        }
    }
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolicyError::InactiveAgent => write!(f, "sub-agent is not active"),
            PolicyError::ExpiredAgent => write!(f, "sub-agent has expired"),
            PolicyError::InactiveAncestor => write!(f, "sub-agent has inactive ancestor"),
            PolicyError::MissingCapability { required } => {
                write!(f, "sub-agent missing capability bit {}", required)
            }
            PolicyError::WrongPlatformScope => write!(f, "platform scope mismatch"),
            PolicyError::ApprovalRequired => write!(f, "owner approval required for this action"),
            PolicyError::SpendExceeded => write!(f, "action spend exceeds max_action_spend"),
        }
    }
}

/// Validate agent row + ancestor chain from social index (mirrors `resolve_actor_with_cap`).
pub fn validate_agent_policy(
    agent: &SocialSubAgent,
    ancestors: &[SocialSubAgent],
    required_cap: u64,
    input: &RequestPolicyInput,
    is_write: bool,
) -> Result<(), PolicyError> {
    if !agent.active || agent.revoked_at_ms.is_some() {
        return Err(PolicyError::InactiveAgent);
    }

    if let Some(expires_at) = agent.expires_at_ms {
        let now_ms = chrono::Utc::now().timestamp_millis();
        if now_ms > expires_at {
            return Err(PolicyError::ExpiredAgent);
        }
    }

    for ancestor in ancestors {
        if !ancestor.active || ancestor.revoked_at_ms.is_some() {
            return Err(PolicyError::InactiveAncestor);
        }
        if let Some(expires_at) = ancestor.expires_at_ms {
            let now_ms = chrono::Utc::now().timestamp_millis();
            if now_ms > expires_at {
                return Err(PolicyError::InactiveAncestor);
            }
        }
    }

    if ancestors.len() > MAX_AGENT_DEPTH as usize {
        return Err(PolicyError::InactiveAncestor);
    }

    if !has_cap(agent.capabilities as u64, required_cap) {
        return Err(PolicyError::MissingCapability {
            required: required_cap,
        });
    }

    check_platform_scope(
        agent.platform_scope.as_deref(),
        input.platform_id.as_deref(),
    )
    .map_err(|_| PolicyError::WrongPlatformScope)?;

    if is_write {
        check_direct_execution_allowed(
            agent.approval_required_caps as u64,
            required_cap,
            input.owner_co_signed,
        )
        .map_err(|_| PolicyError::ApprovalRequired)?;
    }

    check_spend_limit(
        agent.max_action_spend.map(|v| v as u64),
        input.estimated_spend_mist,
    )
    .map_err(|_| PolicyError::SpendExceeded)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_agent(caps: i64, approval: i64) -> SocialSubAgent {
        SocialSubAgent {
            agent_object_id: "0xagent".into(),
            derived_address: "0xderived".into(),
            account_id: "0xaccount".into(),
            label: "test".into(),
            identity_class: 1,
            role_tags: 0,
            capabilities: caps,
            delegatable_caps: 0,
            register_scope: 3,
            approval_required_caps: approval,
            max_action_spend: None,
            platform_scope: None,
            parent_object_id: None,
            depth: 1,
            registered_by: "0xowner".into(),
            expires_at_ms: None,
            active: true,
            created_at_ms: 0,
            deactivated_at_ms: None,
            revoked_at_ms: None,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn write_blocked_when_approval_required_without_owner() {
        let agent = sample_agent(3, crate::memory_contract::CAP_MEMORY_WRITE as i64);
        let input = RequestPolicyInput {
            platform_id: None,
            owner_co_signed: false,
            estimated_spend_mist: 0,
        };
        let err = validate_agent_policy(
            &agent,
            &[],
            crate::memory_contract::CAP_MEMORY_WRITE,
            &input,
            true,
        )
        .unwrap_err();
        assert!(matches!(err, PolicyError::ApprovalRequired));
    }

    #[test]
    fn write_allowed_with_owner_co_sign() {
        let agent = sample_agent(3, crate::memory_contract::CAP_MEMORY_WRITE as i64);
        let input = RequestPolicyInput {
            platform_id: None,
            owner_co_signed: true,
            estimated_spend_mist: 0,
        };
        assert!(validate_agent_policy(
            &agent,
            &[],
            crate::memory_contract::CAP_MEMORY_WRITE,
            &input,
            true,
        )
        .is_ok());
    }
}
