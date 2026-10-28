use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use myso_automation::config::Config;
use myso_automation::event_bus::EventBus;
use myso_automation::handlers::{self, AppState};
use myso_automation::store::{memory_store, postgres_store};
use uuid::Uuid;

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

    let bus = EventBus::with_capacity(config.event_bus_capacity);
    let run_ctx = Arc::new(handlers::build_run_context(store.clone(), &config));

    // AUTOMATION_ENABLED was previously parsed and never read, so the tick loop
    // and the event consumer always ran. A disabled engine still serves its HTTP
    // API — that is what makes it safe to keep a replica up for inspection while
    // draining work, or to dark-launch the service before enabling execution.
    if config.enabled {
        spawn_event_consumer(
            bus.subscribe(),
            bus.clone(),
            run_ctx.clone(),
            store.clone(),
            config.event_concurrency,
        );
        spawn_tick_loop(config.tick_interval_secs, bus.clone(), store.clone());
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
        .route("/v1/automation/jobs/validate", post(handlers::validate_job))
        .route(
            "/v1/automation/jobs/{id}/simulate-event",
            axum::routing::post(handlers::simulate_job_event),
        )
        .route(
            "/v1/automation/jobs/{id}",
            get(handlers::get_job)
                .post(handlers::set_job_enabled)
                .patch(handlers::rename_job)
                .delete(handlers::delete_job),
        )
        .route(
            "/v1/automation/jobs/{id}/configuration",
            axum::routing::patch(handlers::update_job_configuration),
        )
        .route(
            "/v1/automation/jobs/{id}/archive",
            post(handlers::archive_job),
        )
        .route(
            "/v1/automation/jobs/{id}/restore",
            post(handlers::restore_job),
        )
        .route("/v1/automation/jobs/{id}/runs", get(handlers::list_runs))
        .route(
            "/v1/automation/jobs/{job_id}/runs/{run_id}/reconcile",
            axum::routing::post(handlers::resolve_orphan_run),
        )
        .route(
            "/v1/automation/jobs/{id}/run-now",
            axum::routing::post(handlers::run_job_now),
        )
        .route(
            "/v1/automation/jobs/{id}/cancel",
            axum::routing::post(handlers::cancel_job),
        )
        .route(
            "/v1/automation/jobs/{id}/deliveries",
            get(handlers::list_event_deliveries),
        )
        .route(
            "/v1/automation/deliveries/{id}/reconcile",
            axum::routing::post(handlers::resolve_event_delivery),
        )
        .route(
            "/v1/automation/deliveries/{id}/cancel",
            axum::routing::post(handlers::cancel_event_delivery),
        )
        .route("/internal/automation/events", post(handlers::ingest_event))
        .route(
            "/v1/automation/delegates",
            axum::routing::put(handlers::put_delegate)
                .get(handlers::list_delegates)
                .delete(handlers::delete_delegate),
        )
        .route(
            "/v1/automation/delegates/events",
            get(handlers::list_delegate_key_events),
        )
        .route(
            "/v1/automation/delegates/key",
            get(handlers::get_delegate_key),
        )
        .route(
            "/v1/automation/delegates/summary",
            get(handlers::get_delegate_summary),
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

/// Claim persisted job/event deliveries with bounded concurrency. Broadcast messages only wake
/// this poller; acknowledgement, lease expiry and uncertain outcomes live in the store.
fn spawn_event_consumer(
    mut rx: tokio::sync::broadcast::Receiver<myso_automation::PlatformEvent>,
    bus: EventBus,
    run_ctx: Arc<myso_automation::executor::RunContext>,
    store: Arc<dyn myso_automation::AutomationStore>,
    concurrency: usize,
) {
    enum DeliveryFailure {
        SafeToRetry(String),
        Reconcile(String),
    }
    tokio::spawn(async move {
        let slots = Arc::new(tokio::sync::Semaphore::new(concurrency.max(1)));
        loop {
            let Ok(permit) = slots.clone().acquire_owned().await else {
                break;
            };
            match store.claim_event_delivery().await {
                Ok(Some(claim)) => {
                    let run_ctx = run_ctx.clone();
                    let store = store.clone();
                    tokio::spawn(async move {
                        let execute = async {
                            let job = store
                                .get_job(claim.job_id)
                                .await
                                .map_err(|e| DeliveryFailure::SafeToRetry(e.to_string()))?
                                .ok_or_else(|| {
                                    DeliveryFailure::Reconcile(
                                        "Delivery job no longer exists; reconcile this delivery"
                                            .to_string(),
                                    )
                                })?;
                            if !job.enabled {
                                return if store
                                    .defer_event_delivery(claim.id, claim.token)
                                    .await
                                    .map_err(|e| DeliveryFailure::Reconcile(e.to_string()))?
                                {
                                    Ok(false)
                                } else {
                                    Err(DeliveryFailure::Reconcile(
                                        "Delivery lease lost while deferring paused work".into(),
                                    ))
                                };
                            }
                            if !store
                                .begin_event_delivery_dispatch(claim.id, claim.token)
                                .await
                                .map_err(|e| DeliveryFailure::SafeToRetry(e.to_string()))?
                            {
                                return if store
                                    .defer_event_delivery(claim.id, claim.token)
                                    .await
                                    .map_err(|e| DeliveryFailure::Reconcile(e.to_string()))?
                                {
                                    Ok(false)
                                } else {
                                    Err(DeliveryFailure::Reconcile(
                                        "Delivery lease lost before dispatch could be fenced"
                                            .into(),
                                    ))
                                };
                            }
                            run_ctx.evaluate_event_for_jobs(&claim.event, &[job]).await.map_err(|error| match error {
                                    myso_automation::executor::EventEvaluationError::SafeToRetry(message) => DeliveryFailure::SafeToRetry(message),
                                    myso_automation::executor::EventEvaluationError::Reconcile(message) => DeliveryFailure::Reconcile(message),
                                })?;
                            Ok::<bool, DeliveryFailure>(true)
                        };
                        tokio::pin!(execute);
                        let mut heartbeat =
                            tokio::time::interval(std::time::Duration::from_secs(30));
                        let outcome = loop {
                            tokio::select! {
                                result = &mut execute => break result,
                                _ = heartbeat.tick() => {
                                    match store.renew_event_delivery(claim.id, claim.token).await {
                                        Ok(true) => {},
                                        _ => break Err(DeliveryFailure::Reconcile("Delivery lease lost; external outcome needs reconciliation".into())),
                                    }
                                }
                            }
                        };
                        match outcome {
                            Ok(false) => {
                                tracing::debug!(delivery_id=%claim.id, "paused job delivery returned to the pending queue")
                            }
                            Ok(true) => {
                                let result = store
                                    .finish_event_delivery(claim.id, claim.token, None)
                                    .await;
                                if !matches!(result, Ok(true)) {
                                    tracing::warn!(delivery_id=%claim.id, "delivery settlement uncertain; persisted lease recovery will reconcile it");
                                }
                            }
                            Err(DeliveryFailure::SafeToRetry(error)) => {
                                match store
                                    .retry_event_delivery(claim.id, claim.token, &error)
                                    .await
                                {
                                    Ok(true) => {
                                        tracing::warn!(delivery_id=%claim.id, "safe pre-dispatch failure scheduled for bounded retry: {error}")
                                    }
                                    _ => {
                                        tracing::warn!(delivery_id=%claim.id, "could not safely requeue pre-dispatch failure; lease recovery will reconcile it")
                                    }
                                }
                            }
                            Err(DeliveryFailure::Reconcile(error)) => {
                                let result = store
                                    .finish_event_delivery(claim.id, claim.token, Some(error))
                                    .await;
                                if !matches!(result, Ok(true)) {
                                    tracing::warn!(delivery_id=%claim.id, "delivery settlement uncertain; persisted lease recovery will reconcile it");
                                }
                            }
                        }
                        drop(permit);
                    });
                }
                result => {
                    drop(permit);
                    if let Err(error) = result {
                        tracing::warn!(%error, "cannot claim durable event delivery");
                    }
                    // The broadcast is only a wake hint. A lost hint cannot lose persisted work.
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
                        notification = rx.recv() => match notification {
                            Ok(_) => bus.record_consumed(),
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => bus.record_lagged(n),
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {},
                        }
                    }
                }
            }
        }
    });
}

fn spawn_tick_loop(
    interval_secs: u64,
    bus: EventBus,
    store: Arc<dyn myso_automation::AutomationStore>,
) {
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(interval_secs.max(1)));
        loop {
            interval.tick().await;
            let token = Uuid::new_v4();
            let lease_secs = interval_secs.max(60).saturating_mul(2).min(3600);
            match store.acquire_scheduler_lease(token, lease_secs).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => {
                    tracing::warn!(%error, "cannot acquire automation scheduler lease");
                    continue;
                }
            }
            let scheduled = if let Ok(jobs) = store.list_enabled_jobs().await {
                let now = chrono::Utc::now();
                for job in jobs {
                    // A stale replica stops scanning as soon as it no longer owns
                    // the renewable leader lease. Stable slot IDs below remain the
                    // final deduplication barrier across lease expiry/reacquisition.
                    match store.renew_scheduler_lease(token, lease_secs).await {
                        Ok(true) => {}
                        _ => {
                            tracing::warn!(%token, "automation scheduler lease lost; stopping this tick");
                            break;
                        }
                    }
                    // Advance cron/interval only from prior scheduled attempts. A manual
                    // run or event-triggered run must not skip an older missed cron slot.
                    // Counting failed scheduled attempts avoids retrying the same slot on
                    // every tick; stable schedule-event IDs remain the enqueue dedup guard.
                    let last_cursor = match store.latest_scheduled_run_cursor(job.id).await {
                        Ok(value) => value,
                        Err(error) => {
                            tracing::warn!(job_id=%job.id, %error, "cannot read the last scheduled automation attempt");
                            continue;
                        }
                    };
                    let last_window = last_cursor.as_ref().map(|(window, _)| window.as_str());
                    let last_attempt = last_cursor.as_ref().map(|(_, started_at)| *started_at);
                    let Some(window) = myso_automation::trigger_eval::due_window_from_cursor(
                        &job.trigger_set,
                        last_window,
                        last_attempt,
                        now,
                    ) else {
                        continue;
                    };
                    // Persist one targeted schedule delivery per job/window. Multiple replicas
                    // may observe the same due slot; the inbox deduplicates the stable key and
                    // the normal lease/fencing worker owns dispatch and reconciliation.
                    let key = format!("automation:schedule:{}:{}", job.id, window);
                    let scheduled = myso_automation::PlatformEvent {
                        event_version: 1,
                        event_family: "automation".into(),
                        event_type: "scheduled_run".into(),
                        organization_id: Some(job.organization_id.clone()),
                        account_id: Some(job.account_id.clone()),
                        agent_object_id: Some(job.target_agent_object_id.clone()),
                        payload: serde_json::json!({"window": window}),
                        occurred_at_ms: now.timestamp_millis(),
                        source_event_id: key.clone(),
                        deduplication_key: key,
                        source_service: "automation_scheduler".into(),
                        target_job_id: Some(job.id),
                    };
                    // Refresh once more immediately before the persisted slot is
                    // created so a replica that lost leadership does not continue
                    // enqueueing a large schedule scan.
                    match store.renew_scheduler_lease(token, lease_secs).await {
                        Ok(true) => {}
                        _ => {
                            tracing::warn!(%token, "automation scheduler lease lost before slot enqueue");
                            break;
                        }
                    }
                    match store.ingest_scheduled_event(&scheduled, token).await {
                        Ok(true) => bus.publish(scheduled),
                        Ok(false) => {}
                        Err(error) => {
                            tracing::warn!(job_id=%job.id, %error, "cannot persist scheduled automation delivery")
                        }
                    }
                }
                true
            } else {
                tracing::warn!("cannot list enabled jobs during scheduler tick");
                false
            };
            if !scheduled {
                tracing::debug!(%token, "scheduler tick ended without a complete job scan");
            }
            if let Err(error) = store.release_scheduler_lease(token).await {
                tracing::warn!(%token, %error, "cannot release automation scheduler lease");
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
