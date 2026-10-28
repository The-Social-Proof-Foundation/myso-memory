-- Run snapshots and tool results are MYDATA ciphertext, never plaintext JSON.
CREATE TABLE IF NOT EXISTS work_runs (
 id UUID PRIMARY KEY, scope_key TEXT NOT NULL, scope JSONB NOT NULL,
 revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
 status TEXT NOT NULL CHECK (status IN ('planned','running','waiting_for_input','waiting_for_approval','reconciling','delivered','settled','disputed','refunded','cancelled','failed')),
 plan_version BIGINT NOT NULL CHECK (plan_version > 0), snapshot BYTEA NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_runs_scope_created ON work_runs(scope_key, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS work_operations (
 id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES work_runs(id),
 tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_hash TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','reconciling')),
 result BYTEA, result_hash TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(run_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS work_operations_run ON work_operations(run_id, created_at, id);
