ALTER TABLE work_run_worker_credentials
    ADD COLUMN IF NOT EXISTS allow_private_task_artifacts BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS linked_task_id TEXT;

ALTER TABLE work_run_worker_credentials
    DROP CONSTRAINT IF EXISTS work_run_worker_private_sharing_requires_source;

ALTER TABLE work_run_worker_credentials
    ADD CONSTRAINT work_run_worker_private_sharing_requires_source
    CHECK (NOT allow_private_content_sharing OR allow_private_graph OR allow_room_history OR allow_private_task_artifacts),
    ADD CONSTRAINT work_run_worker_task_artifact_requires_linked_task
    CHECK (NOT allow_private_task_artifacts OR linked_task_id IS NOT NULL);
