use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use myso_automation::config::Config;
use myso_automation::event_bus::EventBus;
use myso_automation::handlers::{self, AppState};
use myso_automation::store::{memory_store, postgres_store};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "myso_automation=info,tower_http=info".into()),
        )
        .init();

    let config = Config::from_env();
    if let Some(problem) = config.insecure_secret_problem() {
        // Every route on this engine, including job creation, is gated on this
        // one secret. A value that is public in the repo's own .env.example is
        // not a secret, so a persistent deployment must not start with it.
        panic!("refusing to start: {problem}");
    }
    let store: Arc<dyn myso_automation::AutomationStore> =
        if let Some(ref url) = config.database_url {
            // Retry rather than panic. A hosted platform starts this container
            // alongside its database, and "the database is not accepting
            // connections yet" is a normal cold-start condition, not a
            // misconfiguration — panicking turns it into a crash loop and makes
            // deployment order matter.
            connect_postgres_with_retry(url).await
        } else {
            tracing::warn!(
                "DATABASE_URL unset — using in-memory store; jobs and runs are lost on restart"
            );
            memory_store()
        };

    let bus = EventBus::new();
    let run_ctx = Arc::new(handlers::build_run_context(store.clone(), &config));

    // AUTOMATION_ENABLED was previously parsed and never read, so the tick loop
    // and the event consumer always ran. A disabled engine still serves its HTTP
    // API — that is what makes it safe to keep a replica up for inspection while
    // draining work, or to dark-launch the service before enabling execution.
    if config.enabled {
        spawn_event_consumer(bus.subscribe(), run_ctx.clone(), store.clone());
        spawn_tick_loop(config.tick_interval_secs, run_ctx.clone(), store.clone());
        tracing::info!(
            tick_interval_secs = config.tick_interval_secs,
            "automation execution enabled"
        );
    } else {
        tracing::warn!(
            "AUTOMATION_ENABLED is false — serving the API but running no jobs \
             (no tick loop, no event consumer)"
        );
    }

    let state = AppState {
        store,
        bus,
        run_ctx,
        internal_sync_secret: config.internal_sync_secret.clone(),
    };

    // Secret-gated surface. The middleware rejects unauthenticated callers
    // before any body is parsed, so a credential-less request always gets a 401
    // rather than a 422 describing the body it failed to deserialize.
    let guarded = Router::new()
        .route(
            "/v1/automation/jobs",
            post(handlers::create_job).get(handlers::list_jobs),
        )
        .route("/v1/automation/jobs/{id}", get(handlers::get_job))
        .route("/v1/automation/jobs/{id}/runs", get(handlers::list_runs))
        .route("/internal/automation/events", post(handlers::ingest_event))
        .route(
            "/v1/automation/delegates",
            axum::routing::put(handlers::put_delegate)
                .get(handlers::list_delegates)
                .delete(handlers::delete_delegate),
        )
        .route(
            "/v1/automation/delegates/key",
            get(handlers::get_delegate_key),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            handlers::require_internal_secret,
        ));

    let app = Router::new()
        .route("/health", get(handlers::health))
        .merge(guarded)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    tracing::info!(
        memory_bridge = %config.memory_bridge_url,
        oracle = %config.oracle_url,
        "myso-automation listening on {addr}"
    );
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn spawn_event_consumer(
    mut rx: tokio::sync::broadcast::Receiver<myso_automation::PlatformEvent>,
    run_ctx: Arc<myso_automation::executor::RunContext>,
    store: Arc<dyn myso_automation::AutomationStore>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => match store.list_enabled_jobs().await {
                    Ok(jobs) => {
                        if let Err(e) = run_ctx.evaluate_event_for_jobs(&event, &jobs).await {
                            tracing::warn!(
                                source_event_id = %event.source_event_id,
                                "event evaluation error: {e}"
                            );
                        }
                    }
                    Err(e) => tracing::warn!("cannot list jobs for event evaluation: {e}"),
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("event bus lagged by {n} events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn spawn_tick_loop(
    interval_secs: u64,
    run_ctx: Arc<myso_automation::executor::RunContext>,
    store: Arc<dyn myso_automation::AutomationStore>,
) {
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(interval_secs.max(1)));
        loop {
            interval.tick().await;
            let tick = myso_automation::PlatformEvent {
                event_version: 1,
                event_family: "automation".into(),
                event_type: "tick".into(),
                organization_id: None,
                account_id: None,
                agent_object_id: None,
                payload: serde_json::json!({}),
                occurred_at_ms: chrono::Utc::now().timestamp_millis(),
                source_event_id: Uuid::new_v4().to_string(),
                deduplication_key: format!("tick:{}", chrono::Utc::now().timestamp()),
                source_service: "automation_engine".into(),
            };
            if let Ok(jobs) = store.list_enabled_jobs().await {
                let now = chrono::Utc::now();
                for job in jobs {
                    // Due-ness is measured from the last *attempt*, not the last
                    // success: a skipped or failing job otherwise re-ran, alerted
                    // and called the oracle on every tick until it succeeded.
                    let last_attempt = store.latest_run_started_at(job.id).await.ok().flatten();
                    if myso_automation::trigger_eval::due_window(&job.trigger_set, last_attempt, now)
                        .is_some()
                    {
                        if let Err(e) = run_ctx.run_job(&job, Some(&tick)).await {
                            tracing::warn!(job_id = %job.id, "scheduled run error: {e}");
                        }
                    }
                }
            }
        }
    });
}

/// Longest a connection attempt is retried before the process gives up.
///
/// Sized to outlast a database container starting beside this one, and to stay
/// well inside a platform healthcheck window (Railway's default is 300s).
const POSTGRES_CONNECT_TIMEOUT_SECS: u64 = 120;
/// Ceiling on a single backoff sleep.
const POSTGRES_CONNECT_MAX_BACKOFF_MS: u64 = 5_000;

/// How long to keep retrying.
///
/// Overridable so the budget can be tuned per environment, and so the retry path
/// is testable without a two-minute wait.
fn postgres_connect_timeout_secs() -> u64 {
    std::env::var("AUTOMATION_DB_CONNECT_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .unwrap_or(POSTGRES_CONNECT_TIMEOUT_SECS)
}

/// Connect to Postgres, retrying with backoff.
///
/// A cold start on a hosted platform brings this container up alongside its
/// database, so a refused connection is expected rather than exceptional. The
/// alternative — panicking on the first failure — produces a crash loop and
/// makes the deployment order load-bearing.
async fn connect_postgres_with_retry(url: &str) -> Arc<dyn myso_automation::AutomationStore> {
    let budget_secs = postgres_connect_timeout_secs();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(budget_secs);
    let mut attempt: u32 = 0;

    loop {
        attempt += 1;
        match postgres_store(url).await {
            Ok(store) => {
                if attempt > 1 {
                    tracing::info!(attempt, "connected to postgres after retrying");
                }
                return store;
            }
            Err(err) => {
                if std::time::Instant::now() >= deadline {
                    // Out of budget: this is now a genuine failure, so exit loudly
                    // rather than limping on with a store that cannot persist.
                    panic!(
                        "could not connect to postgres after {attempt} attempts over \
                         {budget_secs}s: {err}"
                    );
                }
                let backoff_ms = (250u64.saturating_mul(1u64 << attempt.min(5)))
                    .min(POSTGRES_CONNECT_MAX_BACKOFF_MS);
                tracing::warn!(
                    attempt,
                    backoff_ms,
                    "postgres not ready yet, retrying: {err}"
                );
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            }
        }
    }
}
