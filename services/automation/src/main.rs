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
    let store: Arc<dyn myso_automation::AutomationStore> =
        if let Some(ref url) = config.database_url {
            postgres_store(url).await.expect("postgres store")
        } else {
            tracing::warn!("DATABASE_URL unset — using in-memory store");
            memory_store()
        };

    let bus = EventBus::new();
    let run_ctx = Arc::new(handlers::build_run_context(store.clone(), &config));

    spawn_event_consumer(bus.subscribe(), run_ctx.clone(), store.clone());
    spawn_tick_loop(config.tick_interval_secs, run_ctx.clone(), store.clone());

    let state = AppState {
        store,
        bus,
        run_ctx,
        internal_sync_secret: config.internal_sync_secret.clone(),
    };

    let app = Router::new()
        .route("/health", get(handlers::health))
        .route("/v1/automation/jobs", post(handlers::create_job))
        .route("/v1/automation/jobs/:id", get(handlers::get_job))
        .route("/internal/automation/events", post(handlers::ingest_event))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    tracing::info!("myso-automation listening on {addr}");
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
                Ok(event) => {
                    if let Ok(jobs) = store.list_enabled_jobs().await {
                        let _ = run_ctx.evaluate_event_for_jobs(&event, &jobs).await;
                    }
                }
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
                for job in jobs {
                    let has_time_trigger = job.trigger_set.triggers.iter().any(|t| {
                        t.kind == myso_automation::TriggerKind::Cron
                            || t.kind == myso_automation::TriggerKind::Interval
                    });
                    if has_time_trigger {
                        let _ = run_ctx.run_job(&job, Some(&tick)).await;
                    }
                }
            }
        }
    });
}
