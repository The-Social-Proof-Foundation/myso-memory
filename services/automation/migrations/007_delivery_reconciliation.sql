-- Preserve the operator decision needed to safely unblock a delivery whose
-- external side effect may have happened before its worker lease expired.
ALTER TABLE automation_event_deliveries ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE automation_event_deliveries ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE automation_event_deliveries ADD COLUMN IF NOT EXISTS resolution_note TEXT;
