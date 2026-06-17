use pgvector::Vector;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::social::SocialSubAgent;
use crate::types::{AppError, SearchHit};

/// Cached sub-agent row from PostgreSQL (lookup keys only; full state re-verified on-chain).
pub struct CachedSubAgent {
    pub account_id: String,
    pub agent_object_id: String,
}

pub struct VectorDb {
    pool: PgPool,
}

impl VectorDb {
    /// Initialize database connection pool and run migrations
    pub async fn new(database_url: &str) -> Result<Self, AppError> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to connect to database: {}", e)))?;

        for (name, sql) in [
            ("001", include_str!("../migrations/001_init.sql")),
            ("002", include_str!("../migrations/002_add_namespace.sql")),
            ("003", include_str!("../migrations/003_rate_limiter.sql")),
            ("004", include_str!("../migrations/004_delegate_key_cache_expires.sql")),
            ("005", include_str!("../migrations/005_sub_agent_cache.sql")),
            ("006", include_str!("../migrations/006_agent_scope.sql")),
            ("007", include_str!("../migrations/007_sub_agent_policy_cache.sql")),
            ("008", include_str!("../migrations/008_remember_jobs.sql")),
            ("009", include_str!("../migrations/009_importance.sql")),
        ] {
            sqlx::raw_sql(sql)
                .execute(&pool)
                .await
                .map_err(|e| AppError::Internal(format!("Failed to run migration {}: {}", name, e)))?;
        }

        tracing::info!("database connected and migrations applied");

        Ok(Self { pool })
    }

    /// Insert a vector entry scoped to agent_object_id (primary) with optional sub_label.
    pub async fn insert_vector(
        &self,
        id: &str,
        owner: &str,
        agent_object_id: &str,
        sub_label: Option<&str>,
        blob_id: &str,
        vector: &[f32],
        blob_size_bytes: i64,
        importance: f32,
    ) -> Result<(), AppError> {
        let embedding = Vector::from(vector.to_vec());
        let namespace = agent_object_id;
        let label = sub_label.unwrap_or("");

        sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, agent_object_id, sub_label, blob_id, embedding, blob_size_bytes, importance)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(agent_object_id)
        .bind(label)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .bind(importance)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert vector: {}", e)))?;

        tracing::debug!(
            "inserted vector: id={}, blob_id={}, owner={}, agent={}, size={}B",
            id,
            blob_id,
            owner,
            agent_object_id,
            blob_size_bytes
        );
        Ok(())
    }

    /// Search for similar vectors scoped by owner + agent_object_id.
    /// Fetches up to `candidate_limit` rows for optional re-ranking downstream.
    pub async fn search_similar(
        &self,
        query_vector: &[f32],
        owner: &str,
        agent_object_id: &str,
        sub_label: Option<&str>,
        limit: usize,
        candidate_multiplier: usize,
    ) -> Result<Vec<SearchHit>, AppError> {
        let embedding = Vector::from(query_vector.to_vec());
        let fetch_limit = (limit * candidate_multiplier.max(1)).min(300) as i64;

        let rows: Vec<(String, f64, chrono::DateTime<chrono::Utc>, f32)> =
            if let Some(label) = sub_label.filter(|s| !s.is_empty()) {
                sqlx::query_as(
                    "SELECT blob_id, (embedding <=> $1)::float8 AS distance, created_at, importance
                 FROM vector_entries
                 WHERE owner = $2 AND agent_object_id = $3 AND sub_label = $4 AND tombstoned = FALSE
                 ORDER BY embedding <=> $1
                 LIMIT $5",
                )
                .bind(&embedding)
                .bind(owner)
                .bind(agent_object_id)
                .bind(label)
                .bind(fetch_limit)
                .fetch_all(&self.pool)
                .await
            } else {
                sqlx::query_as(
                    "SELECT blob_id, (embedding <=> $1)::float8 AS distance, created_at, importance
                 FROM vector_entries
                 WHERE owner = $2 AND agent_object_id = $3 AND tombstoned = FALSE
                 ORDER BY embedding <=> $1
                 LIMIT $4",
                )
                .bind(&embedding)
                .bind(owner)
                .bind(agent_object_id)
                .bind(fetch_limit)
                .fetch_all(&self.pool)
                .await
            }
            .map_err(|e| AppError::Internal(format!("Failed to search vectors: {}", e)))?;

        Ok(rows
            .into_iter()
            .map(|(blob_id, distance, created_at, importance)| SearchHit {
                blob_id,
                distance,
                created_at: Some(created_at),
                importance,
            })
            .collect())
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn get_blobs_by_agent(
        &self,
        owner: &str,
        agent_object_id: &str,
    ) -> Result<Vec<String>, AppError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT blob_id FROM vector_entries
             WHERE owner = $1 AND agent_object_id = $2 AND tombstoned = FALSE",
        )
        .bind(owner)
        .bind(agent_object_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get blobs by agent: {}", e)))?;

        Ok(rows.into_iter().map(|(blob_id,)| blob_id).collect())
    }

    pub async fn tombstone_agent(&self, agent_object_id: &str) -> Result<u64, AppError> {
        let result = sqlx::query(
            "UPDATE vector_entries SET tombstoned = TRUE WHERE agent_object_id = $1 AND tombstoned = FALSE",
        )
        .bind(agent_object_id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to tombstone agent vectors: {}", e)))?;
        Ok(result.rows_affected())
    }

    pub async fn tombstone_owner(&self, owner: &str) -> Result<u64, AppError> {
        let result = sqlx::query(
            "UPDATE vector_entries SET tombstoned = TRUE WHERE owner = $1 AND tombstoned = FALSE",
        )
        .bind(owner)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to tombstone owner vectors: {}", e)))?;
        Ok(result.rows_affected())
    }

    pub async fn delete_by_blob_id(&self, blob_id: &str, owner: &str) -> Result<u64, AppError> {
        let result = sqlx::query(
            "DELETE FROM vector_entries WHERE blob_id = $1 AND owner = $2",
        )
        .bind(blob_id)
        .bind(owner)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to delete vector by blob_id: {}", e)))?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!(
                "deleted expired blob from DB: blob_id={}, owner={}, rows={}",
                blob_id,
                owner,
                rows
            );
        }
        Ok(rows)
    }

    pub async fn get_cached_sub_agent(
        &self,
        public_key_hex: &str,
    ) -> Result<Option<CachedSubAgent>, AppError> {
        let result: Option<(String, String)> = sqlx::query_as(
            "SELECT account_id, agent_object_id
             FROM sub_agent_cache
             WHERE public_key = $1 AND expires_at > NOW() AND active = TRUE",
        )
        .bind(public_key_hex)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to query sub-agent cache: {}", e)))?;

        Ok(result.map(|(account_id, agent_object_id)| CachedSubAgent {
            account_id,
            agent_object_id,
        }))
    }

    pub async fn cache_sub_agent(
        &self,
        public_key_hex: &str,
        agent: &SocialSubAgent,
        owner: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO sub_agent_cache (
                public_key, derived_address, account_id, agent_object_id, owner,
                capabilities, approval_required_caps, max_action_spend, platform_scope,
                parent_object_id, expires_at_ms, label, active, expires_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + INTERVAL '24 hours')
             ON CONFLICT (public_key)
             DO UPDATE SET
                derived_address = $2,
                account_id = $3,
                agent_object_id = $4,
                owner = $5,
                capabilities = $6,
                approval_required_caps = $7,
                max_action_spend = $8,
                platform_scope = $9,
                parent_object_id = $10,
                expires_at_ms = $11,
                label = $12,
                active = $13,
                cached_at = NOW(),
                expires_at = NOW() + INTERVAL '24 hours'",
        )
        .bind(public_key_hex)
        .bind(&agent.derived_address)
        .bind(&agent.account_id)
        .bind(&agent.agent_object_id)
        .bind(owner)
        .bind(agent.capabilities)
        .bind(agent.approval_required_caps)
        .bind(agent.max_action_spend)
        .bind(&agent.platform_scope)
        .bind(&agent.parent_object_id)
        .bind(agent.expires_at_ms)
        .bind(&agent.label)
        .bind(agent.active)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to cache sub-agent: {}", e)))?;

        Ok(())
    }

    pub async fn evict_expired_sub_agents(&self) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM sub_agent_cache WHERE expires_at <= NOW()")
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to evict expired sub-agents: {}", e)))?;
        Ok(result.rows_affected())
    }

    pub async fn delete_cached_sub_agent(&self, public_key_hex: &str) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM sub_agent_cache WHERE public_key = $1")
            .bind(public_key_hex)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to delete cached sub-agent: {}", e)))?;
        Ok(result.rows_affected())
    }

    pub async fn delete_cached_sub_agent_by_derived(&self, derived_address: &str) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM sub_agent_cache WHERE derived_address = $1")
            .bind(derived_address)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to delete cached sub-agent: {}", e)))?;
        Ok(result.rows_affected())
    }

    pub async fn get_vault_for_agent(&self, agent_object_id: &str) -> Result<Option<String>, AppError> {
        let row: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT vault_id FROM agent_vaults WHERE agent_object_id = $1",
        )
        .bind(agent_object_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to query agent vault: {}", e)))?;

        Ok(row.and_then(|(vault_id,)| vault_id))
    }

    pub async fn record_agent_vault(
        &self,
        agent_object_id: &str,
        account_id: &str,
        vault_id: Option<&str>,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO agent_vaults (agent_object_id, account_id, vault_id, ensured_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (agent_object_id)
             DO UPDATE SET vault_id = COALESCE($3, agent_vaults.vault_id), ensured_at = NOW()",
        )
        .bind(agent_object_id)
        .bind(account_id)
        .bind(vault_id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to record agent vault: {}", e)))?;
        Ok(())
    }

    pub async fn list_cached_derived_agents(&self) -> Result<Vec<(String, String)>, AppError> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT derived_address, agent_object_id FROM sub_agent_cache",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to list cached sub-agents: {}", e)))?;
        Ok(rows)
    }

    pub async fn get_storage_used_with_lock(&self, owner: &str, lock_key: i64) -> Result<i64, AppError> {
        let mut tx = self.pool.begin().await
            .map_err(|e| AppError::Internal(format!("Failed to begin tx: {}", e)))?;

        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(lock_key)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to acquire advisory lock: {}", e)))?;

        let row: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries WHERE owner = $1 AND tombstoned = FALSE",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get storage used: {}", e)))?;

        tx.commit().await.map_err(|e| AppError::Internal(format!("Failed to commit tx: {}", e)))?;

        Ok(row.0)
    }
}
