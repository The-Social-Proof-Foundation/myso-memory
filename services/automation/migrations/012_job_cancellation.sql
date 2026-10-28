ALTER TABLE automation_event_deliveries
    ADD COLUMN IF NOT EXISTS dispatch_started BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS cancel_actor TEXT,
    ADD COLUMN IF NOT EXISTS cancel_note TEXT;
