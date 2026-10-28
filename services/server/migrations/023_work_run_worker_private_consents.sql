ALTER TABLE work_run_worker_credentials
    ADD COLUMN IF NOT EXISTS allow_private_graph BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS allow_room_history BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS allow_private_content_sharing BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE work_run_worker_credentials
    ADD CONSTRAINT work_run_worker_private_sharing_requires_source
    CHECK (NOT allow_private_content_sharing OR allow_private_graph OR allow_room_history);
