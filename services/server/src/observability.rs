//! Lightweight observability helpers for tracing spans.

use tracing::{info_span, Span};

pub fn remember_job_span(job_id: &str, agent_object_id: &str) -> Span {
    info_span!(
        "remember.job",
        job_id = job_id,
        agent_object_id = agent_object_id
    )
}

pub fn recall_rank_span(limit: usize) -> Span {
    info_span!("recall.rank", limit = limit)
}
