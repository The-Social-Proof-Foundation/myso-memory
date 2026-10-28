-- Fenced foreground turns; the automation engine remains the only background scheduler.
ALTER TABLE work_runs ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE work_runs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS work_turns (
 id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES work_runs(id), request_id UUID NOT NULL,
 input_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running','finished','failed','reconciling')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 UNIQUE(run_id,request_id)
);
CREATE INDEX IF NOT EXISTS work_turns_run_created ON work_turns(run_id,created_at DESC,id DESC);
