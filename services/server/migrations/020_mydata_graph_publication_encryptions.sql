CREATE TABLE IF NOT EXISTS mydata_graph_publication_encryptions (
    account_id TEXT NOT NULL,
    agent_object_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash_hex CHAR(64) NOT NULL,
    encrypted_data_base64 TEXT NOT NULL,
    encrypted_data_digest_hex CHAR(64) NOT NULL,
    encryption_id_hex TEXT NOT NULL,
    manifest_hash_hex CHAR(64) NOT NULL,
    publication_tags_hash_hex CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, agent_object_id, idempotency_key)
);
