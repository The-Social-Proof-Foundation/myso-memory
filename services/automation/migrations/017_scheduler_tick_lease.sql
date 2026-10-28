-- One renewable leader lease prevents every replica from scanning cron jobs on every tick.
-- Slot-level event deduplication remains the correctness barrier if a lease expires mid-scan.
CREATE TABLE IF NOT EXISTS automation_scheduler_leases (
    lease_name TEXT PRIMARY KEY,
    lease_token UUID NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT automation_scheduler_single_cron_lease CHECK (lease_name = 'cron')
);
