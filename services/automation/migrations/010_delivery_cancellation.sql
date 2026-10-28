-- Record an explicit owner cancellation in the same append-only delivery audit.
ALTER TABLE automation_event_delivery_resolutions
    DROP CONSTRAINT IF EXISTS automation_event_delivery_resolutions_resolution_check;
ALTER TABLE automation_event_delivery_resolutions
    ADD CONSTRAINT automation_event_delivery_resolutions_resolution_check
    CHECK (resolution IN ('confirmed_succeeded','confirmed_not_executed_retry','cancelled_before_dispatch'));
