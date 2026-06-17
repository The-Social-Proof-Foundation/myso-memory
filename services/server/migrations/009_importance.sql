-- Per-fact importance for composite recall ranking.

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS importance REAL NOT NULL DEFAULT 0.5;
