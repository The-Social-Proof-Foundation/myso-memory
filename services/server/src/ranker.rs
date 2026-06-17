//! Composite-scoring ranker for recall results.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::types::SearchHit;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoringWeights {
    pub semantic: f64,
    pub recency: f64,
    pub recency_half_life_days: f64,
    pub importance: f64,
}

impl Default for ScoringWeights {
    fn default() -> Self {
        Self {
            semantic: 1.0,
            recency: 0.0,
            recency_half_life_days: 7.0,
            importance: 0.0,
        }
    }
}

impl ScoringWeights {
    pub fn is_ranker_active(&self) -> bool {
        self.recency.abs() >= f64::EPSILON || self.importance.abs() >= f64::EPSILON
    }
}

#[derive(Debug, Clone)]
pub struct RankedHit {
    pub blob_id: String,
    pub distance: f64,
    pub score: Option<f64>,
    pub created_at: Option<DateTime<Utc>>,
    pub importance: f32,
}

pub struct CompositeRanker;

impl CompositeRanker {
    pub fn rank(
        hits: Vec<SearchHit>,
        weights: &ScoringWeights,
        now: DateTime<Utc>,
    ) -> Vec<RankedHit> {
        if !weights.is_ranker_active() {
            return hits
                .into_iter()
                .map(|h| RankedHit {
                    blob_id: h.blob_id,
                    distance: h.distance,
                    score: None,
                    created_at: h.created_at,
                    importance: h.importance,
                })
                .collect();
        }

        let mut ranked: Vec<RankedHit> = hits
            .into_iter()
            .map(|h| {
                let score = Self::score(&h, weights, now);
                RankedHit {
                    blob_id: h.blob_id,
                    distance: h.distance,
                    score: Some(score),
                    created_at: h.created_at,
                    importance: h.importance,
                }
            })
            .collect();

        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        ranked
    }

    fn score(hit: &SearchHit, weights: &ScoringWeights, now: DateTime<Utc>) -> f64 {
        let semantic_term = weights.semantic * (1.0 - hit.distance);

        let recency_term = if weights.recency.abs() < f64::EPSILON {
            0.0
        } else if let Some(created_at) = hit.created_at {
            let age_secs = (now - created_at).num_seconds().max(0) as f64;
            let age_days = age_secs / 86_400.0;
            if weights.recency_half_life_days <= 0.0 {
                0.0
            } else {
                let decay = (-age_days * std::f64::consts::LN_2 / weights.recency_half_life_days)
                    .exp();
                weights.recency * decay
            }
        } else {
            0.0
        };

        let importance_term = if weights.importance.abs() >= f64::EPSILON {
            weights.importance * (hit.importance as f64)
        } else {
            0.0
        };

        semantic_term + recency_term + importance_term
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_weights_preserve_order() {
        let hits = vec![
            SearchHit {
                blob_id: "a".into(),
                distance: 0.1,
                created_at: None,
                importance: 0.5,
            },
            SearchHit {
                blob_id: "b".into(),
                distance: 0.3,
                created_at: None,
                importance: 0.5,
            },
        ];
        let ranked = CompositeRanker::rank(hits, &ScoringWeights::default(), Utc::now());
        assert_eq!(ranked[0].blob_id, "a");
        assert!(ranked[0].score.is_none());
    }
}
