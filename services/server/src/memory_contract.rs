//! Mirrors `social_contracts::memory` constants and pure policy helpers.
//! Keep in sync with memory.move — do not change semantics here without a contract change.

pub const CAP_MEMORY_READ: u64 = 1;
pub const CAP_MEMORY_WRITE: u64 = 2;
pub const CAP_MYDATA_READ: u64 = 4;
pub const CAP_POST_PUBLISH: u64 = 16;
pub const CAP_MESSAGE_READ: u64 = 32;
pub const CAP_MESSAGE_SEND: u64 = 64;
pub const CAP_COMMENT: u64 = 512;
pub const CAP_REACT: u64 = 1024;

pub const CLASS_HUMAN: u8 = 0;
pub const CLASS_DELEGATED_AI: u8 = 1;
pub const CLASS_ORGANIZATION: u8 = 2;

pub const MAX_AGENT_DEPTH: u8 = 8;

pub const E_ACCOUNT_DEACTIVATED: u64 = 6;
pub const E_SUB_AGENT_NOT_ACTIVE: u64 = 15;
pub const E_SUB_AGENT_EXPIRED: u64 = 16;
pub const E_SUB_AGENT_WRONG_PLATFORM_SCOPE: u64 = 17;
pub const E_SUB_AGENT_MISSING_CAP: u64 = 18;
pub const E_SUB_AGENT_APPROVAL_REQUIRED: u64 = 19;
pub const E_SUB_AGENT_INACTIVE_ANCESTOR: u64 = 29;
pub const E_SUB_AGENT_SPEND_EXCEEDED: u64 = 30;

pub fn has_cap(capabilities: u64, required: u64) -> bool {
    capabilities & required == required
}

pub fn cap_requires_approval(approval_required_caps: u64, cap: u64) -> bool {
    approval_required_caps & cap == cap
}

/// Off-chain mirror of `assert_platform_scope_entry`.
pub fn check_platform_scope(
    platform_scope: Option<&str>,
    action_platform_id: Option<&str>,
) -> Result<(), u64> {
    let Some(scope) = platform_scope else {
        return Ok(());
    };
    let Some(action) = action_platform_id else {
        return Err(E_SUB_AGENT_WRONG_PLATFORM_SCOPE);
    };
    if addresses_equal(scope, action) {
        Ok(())
    } else {
        Err(E_SUB_AGENT_WRONG_PLATFORM_SCOPE)
    }
}

/// Off-chain mirror of `assert_direct_execution_allowed` for a single cap bit.
pub fn check_direct_execution_allowed(
    approval_required_caps: u64,
    required_cap: u64,
    owner_co_signed: bool,
) -> Result<(), u64> {
    if owner_co_signed {
        return Ok(());
    }
    if cap_requires_approval(approval_required_caps, required_cap) {
        Err(E_SUB_AGENT_APPROVAL_REQUIRED)
    } else {
        Ok(())
    }
}

pub fn check_spend_limit(max_action_spend: Option<u64>, spend_amount: u64) -> Result<(), u64> {
    let Some(max) = max_action_spend else {
        return Ok(());
    };
    if spend_amount <= max {
        Ok(())
    } else {
        Err(E_SUB_AGENT_SPEND_EXCEEDED)
    }
}

pub fn addresses_equal(a: &str, b: &str) -> bool {
    a.trim_start_matches("0x")
        .eq_ignore_ascii_case(b.trim_start_matches("0x"))
}

/// Pad a short `0x` object id to 32 bytes (64 hex chars) for MYDATA / SDK consumers.
pub fn normalize_object_id(id: &str) -> String {
    let hex = id.trim_start_matches("0x");
    if hex.len() >= 64 {
        return format!("0x{}", hex);
    }
    format!("0x{:0>64}", hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_cap_requires_all_bits() {
        assert!(has_cap(3, CAP_MEMORY_READ));
        assert!(has_cap(3, CAP_MEMORY_WRITE));
        assert!(!has_cap(CAP_MEMORY_READ, CAP_MEMORY_WRITE));
    }

    #[test]
    fn approval_required_when_bit_set() {
        assert!(cap_requires_approval(CAP_MEMORY_WRITE, CAP_MEMORY_WRITE));
        assert!(!cap_requires_approval(CAP_MEMORY_READ, CAP_MEMORY_WRITE));
    }

    #[test]
    fn platform_scope_mismatch() {
        assert!(check_platform_scope(Some("0xabc"), Some("0xabc")).is_ok());
        assert_eq!(
            check_platform_scope(Some("0xabc"), None),
            Err(E_SUB_AGENT_WRONG_PLATFORM_SCOPE)
        );
    }
}
