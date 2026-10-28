-- The owner explicitly approved private-graph source consent for both
-- interactive and unattended hosted runs. Restore the source-consent rule;
-- this migration changes no existing credential rows.
ALTER TABLE work_run_worker_credentials
    DROP CONSTRAINT IF EXISTS work_run_worker_private_sharing_requires_source;

ALTER TABLE work_run_worker_credentials
    ADD CONSTRAINT work_run_worker_private_sharing_requires_source
    CHECK (
        NOT allow_private_content_sharing
        OR allow_private_graph
        OR allow_room_history
        OR allow_private_task_artifacts
    );
