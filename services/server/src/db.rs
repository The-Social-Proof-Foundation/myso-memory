use pgvector::Vector;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

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

        // Run migrations
        let migration_001 = include_str!("../migrations/001_init.sql");
        sqlx::raw_sql(migration_001)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 001: {}", e)))?;

        let migration_002 = include_str!("../migrations/002_add_namespace.sql");
        sqlx::raw_sql(migration_002)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 002: {}", e)))?;

        let migration_003 = include_str!("../migrations/003_rate_limiter.sql");
        sqlx::raw_sql(migration_003)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 003: {}", e)))?;

        let migration_004 = include_str!("../migrations/004_delegate_key_cache_expires.sql");
        sqlx::raw_sql(migration_004)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 004: {}", e)))?;

        let migration_005 = include_str!("../migrations/005_sub_agent_cache.sql");
        sqlx::raw_sql(migration_005)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 005: {}", e)))?;


        tracing::info!("database connected and migrations applied");

        Ok(Self { pool })
    }

    /// Insert a vector entry (with blob size tracking for storage quota)
    pub async fn insert_vector(
        &self,
        id: &str,
        owner: &str,
        namespace: &str,
        blob_id: &str,
        vector: &[f32],
        blob_size_bytes: i64,
    ) -> Result<(), AppError> {
        let embedding = Vector::from(vector.to_vec());

        sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert vector: {}", e)))?;

        tracing::debug!("inserted vector: id={}, blob_id={}, owner={}, ns={}, size={}B", id, blob_id, owner, namespace, blob_size_bytes);
        Ok(())
    }

    /// Search for similar vectors using pgvector cosine distance (<=>)
    /// Returns blob_id and distance for each match
    pub async fn search_similar(
        &self,
        query_vector: &[f32],
        owner: &str,
        namespace: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, AppError> {
        let embedding = Vector::from(query_vector.to_vec());

        let rows: Vec<(String, f64)> = sqlx::query_as(
            "SELECT blob_id, (embedding <=> $1)::float8 AS distance
             FROM vector_entries
             WHERE owner = $2 AND namespace = $3
             ORDER BY embedding <=> $1
             LIMIT $4",
        )
        .bind(embedding)
        .bind(owner)
        .bind(namespace)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to search vectors: {}", e)))?;

        let results = rows
            .into_iter()
            .map(|(blob_id, distance)| SearchHit { blob_id, distance })
            .collect();

        Ok(results)
    }

    /// Get all blob_ids for a given owner + namespace (used by restore flow)
    pub async fn get_blobs_by_namespace(
        &self,
        owner: &str,
        namespace: &str,
    ) -> Result<Vec<String>, AppError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT blob_id FROM vector_entries
             WHERE owner = $1 AND namespace = $2",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get blobs by namespace: {}", e)))?;

        Ok(rows.into_iter().map(|(blob_id,)| blob_id).collect())
    }

    /// Delete all vector entries for a given owner + namespace
    #[allow(dead_code)]
    pub async fn delete_by_namespace(
        &self,
        owner: &str,
        namespace: &str,
    ) -> Result<u64, AppError> {
        let result = sqlx::query(
            "DELETE FROM vector_entries WHERE owner = $1 AND namespace = $2",
        )
        .bind(owner)
        .bind(namespace)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to delete by namespace: {}", e)))?;

        let rows = result.rows_affected();
        tracing::info!("deleted {} entries for owner={}, ns={}", rows, owner, namespace);
        Ok(rows)
    }

    /// Delete a vector entry by blob_id (used for expired blob cleanup).
    /// Called reactively when File Storage returns 404 during blob download.
    /// LOW-10: Requires owner to prevent cross-user blob deletion.
    pub async fn delete_by_blob_id(&self, blob_id: &str, owner: &str) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM vector_entries WHERE blob_id = $1 AND owner = $2")
            .bind(blob_id)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to delete vector by blob_id: {}", e)))?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!("deleted expired blob from DB: blob_id={}, owner={}, rows={}", blob_id, owner, rows);
        }
        Ok(rows)
    }

    // ============================================================
    // Sub-Agent Cache
    // ============================================================

    /// Look up cached sub-agent info for a public key.
    pub async fn get_cached_sub_agent(
        &self,
        public_key_hex: &str,
    ) -> Result<Option<CachedSubAgent>, AppError> {
        let result: Option<(String, String)> = sqlx::query_as(
            "SELECT account_id, agent_object_id
             FROM sub_agent_cache
             WHERE public_key = $1 AND expires_at > NOW()",
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

    /// Cache a verified sub-agent mapping.
    pub async fn cache_sub_agent(
        &self,
        public_key_hex: &str,
        derived_address: &str,
        account_id: &str,
        agent_object_id: &str,
        owner: &str,
        capabilities: i64,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO sub_agent_cache (
                public_key, derived_address, account_id, agent_object_id, owner, capabilities, expires_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '24 hours')
             ON CONFLICT (public_key)
             DO UPDATE SET
                derived_address = $2,
                account_id = $3,
                agent_object_id = $4,
                owner = $5,
                capabilities = $6,
                cached_at = NOW(),
                expires_at = NOW() + INTERVAL '24 hours'",
        )
        .bind(public_key_hex)
        .bind(derived_address)
        .bind(account_id)
        .bind(agent_object_id)
        .bind(owner)
        .bind(capabilities)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to cache sub-agent: {}", e)))?;

        tracing::debug!(
            "cached sub-agent: {} -> account {} agent {}",
            public_key_hex,
            account_id,
            agent_object_id
        );
        Ok(())
    }

    /// Periodically evict expired cache rows.
    pub async fn evict_expired_sub_agents(&self) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM sub_agent_cache WHERE expires_at <= NOW()")
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to evict expired sub-agents: {}", e)))?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!("Evicted {} expired sub-agent cache rows", rows);
        }
        Ok(rows)
    }

    /// Remove a stale/revoked sub-agent from the cache.
    pub async fn delete_cached_sub_agent(&self, public_key_hex: &str) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM sub_agent_cache WHERE public_key = $1")
            .bind(public_key_hex)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to delete cached sub-agent: {}", e)))?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!("evicted stale sub-agent from cache: {}", public_key_hex);
        }
        Ok(rows)
    }

    // ============================================================
    // Storage Quota (still PostgreSQL — tracks per-row blob sizes)
    // ============================================================

    /// Acquire an advisory lock and get storage used within a single transaction.
    ///
    /// MED-21 bugfix: using `pg_advisory_lock` with a connection pool causes deadlocks
    /// because it's session-level. We use `pg_advisory_xact_lock` inside an explicit
    /// transaction so the lock is automatically released on commit/rollback.
    pub async fn get_storage_used_with_lock(&self, owner: &str, lock_key: i64) -> Result<i64, AppError> {
        let mut tx = self.pool.begin().await
            .map_err(|e| AppError::Internal(format!("Failed to begin tx: {}", e)))?;

        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(lock_key)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to acquire advisory lock: {}", e)))?;

        let row: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries WHERE owner = $1",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get storage used: {}", e)))?;

        tx.commit().await.map_err(|e| AppError::Internal(format!("Failed to commit tx: {}", e)))?;

        Ok(row.0)
    }
}
