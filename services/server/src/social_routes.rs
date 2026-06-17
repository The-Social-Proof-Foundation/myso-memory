use axum::{
    extract::{Extension, Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::types::{AppError, AppState, AuthInfo};

const MAX_POST_CONTENT_LEN: usize = 8_192;
const MAX_REACTION_LEN: usize = 64;

#[derive(Debug, Deserialize)]
pub struct CreatePostBody {
    pub content: String,
    #[serde(rename = "platformObjectId")]
    pub platform_object_id: Option<String>,
    #[serde(rename = "mediaUrls")]
    pub media_urls: Option<Vec<String>>,
    pub mentions: Option<Vec<String>>,
    #[serde(rename = "metadataJson")]
    pub metadata_json: Option<String>,
    #[serde(rename = "allowComments")]
    pub allow_comments: Option<bool>,
    #[serde(rename = "allowReactions")]
    pub allow_reactions: Option<bool>,
    #[serde(rename = "allowReposts")]
    pub allow_reposts: Option<bool>,
    #[serde(rename = "allowQuotes")]
    pub allow_quotes: Option<bool>,
    #[serde(rename = "allowTips")]
    pub allow_tips: Option<bool>,
    #[serde(rename = "enableSpt")]
    pub enable_spt: Option<bool>,
    #[serde(rename = "enablePoc")]
    pub enable_poc: Option<bool>,
    #[serde(rename = "enableSpot")]
    pub enable_spot: Option<bool>,
    #[serde(rename = "mydataId")]
    pub mydata_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCommentBody {
    #[serde(rename = "postId")]
    pub post_id: String,
    pub content: String,
    #[serde(rename = "parentCommentId")]
    pub parent_comment_id: Option<String>,
    #[serde(rename = "mediaUrls")]
    pub media_urls: Option<Vec<String>>,
    pub mentions: Option<Vec<String>>,
    #[serde(rename = "metadataJson")]
    pub metadata_json: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReactPostBody {
    #[serde(rename = "postId")]
    pub post_id: String,
    pub reaction: String,
    #[serde(rename = "platformObjectId")]
    pub platform_object_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReactCommentBody {
    #[serde(rename = "commentId")]
    pub comment_id: String,
    pub reaction: String,
    #[serde(rename = "platformObjectId")]
    pub platform_object_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateRepostBody {
    #[serde(rename = "originalPostId")]
    pub original_post_id: String,
    pub content: Option<String>,
    #[serde(rename = "platformObjectId")]
    pub platform_object_id: Option<String>,
    #[serde(rename = "mediaUrls")]
    pub media_urls: Option<Vec<String>>,
    pub mentions: Option<Vec<String>>,
    #[serde(rename = "metadataJson")]
    pub metadata_json: Option<String>,
    #[serde(rename = "allowComments")]
    pub allow_comments: Option<bool>,
    #[serde(rename = "allowReactions")]
    pub allow_reactions: Option<bool>,
    #[serde(rename = "allowReposts")]
    pub allow_reposts: Option<bool>,
    #[serde(rename = "allowQuotes")]
    pub allow_quotes: Option<bool>,
    #[serde(rename = "allowTips")]
    pub allow_tips: Option<bool>,
    #[serde(rename = "enableSpt")]
    pub enable_spt: Option<bool>,
    #[serde(rename = "enablePoc")]
    pub enable_poc: Option<bool>,
    #[serde(rename = "enableSpot")]
    pub enable_spot: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteCommentBody {
    #[serde(rename = "postId")]
    pub post_id: String,
}

#[derive(Debug, Serialize)]
pub struct SocialActionResponse {
    pub digest: String,
    #[serde(rename = "postId", skip_serializing_if = "Option::is_none")]
    pub post_id: Option<String>,
    #[serde(rename = "commentId", skip_serializing_if = "Option::is_none")]
    pub comment_id: Option<String>,
    #[serde(rename = "repostId", skip_serializing_if = "Option::is_none")]
    pub repost_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

fn ensure_social_configured(state: &AppState) -> Result<(), AppError> {
    if !state.config.social_chain.is_configured() {
        return Err(AppError::Internal(
            "Social chain bootstrap object IDs are not configured on the server".into(),
        ));
    }
    Ok(())
}

fn validate_content(content: &str) -> Result<(), AppError> {
    if content.trim().is_empty() {
        return Err(AppError::BadRequest("content must not be empty".into()));
    }
    if content.len() > MAX_POST_CONTENT_LEN {
        return Err(AppError::BadRequest(format!(
            "content exceeds max length ({MAX_POST_CONTENT_LEN})"
        )));
    }
    Ok(())
}

fn validate_reaction(reaction: &str) -> Result<(), AppError> {
    if reaction.is_empty() {
        return Err(AppError::BadRequest("reaction must not be empty".into()));
    }
    if reaction.len() > MAX_REACTION_LEN {
        return Err(AppError::BadRequest(format!(
            "reaction exceeds max length ({MAX_REACTION_LEN})"
        )));
    }
    Ok(())
}

fn require_delete_co_sign(auth: &AuthInfo) -> Result<(), AppError> {
    if !auth.owner_co_signed {
        return Err(AppError::Forbidden(
            "delete requires owner co-sign (x-owner-public-key + x-owner-signature)".into(),
        ));
    }
    Ok(())
}

async fn forward_social_execute(
    state: &AppState,
    auth: &AuthInfo,
    action: &str,
    params: Value,
    owner_private_key: Option<String>,
) -> Result<SocialActionResponse, AppError> {
    ensure_social_configured(state)?;

    let sub_agent_key = auth
        .sub_agent_key
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("x-delegate-key required for social actions".into()))?;

    let payload = json!({
        "action": action,
        "params": params,
        "memoryAccountId": auth.account_id,
        "senderPrivateKey": sub_agent_key,
        "ownerPrivateKey": owner_private_key,
    });

    let url = format!("{}/social/execute", state.config.sidecar_url.trim_end_matches('/'));
    let mut req = state.http_client.post(&url).json(&payload);
    if let Some(secret) = &state.config.sidecar_secret {
        req = req.header("X-Sidecar-Secret", secret);
    }

    let resp = req.send().await.map_err(|e| {
        AppError::Internal(format!("sidecar social/execute transport error: {e}"))
    })?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Internal(format!(
            "sidecar social/execute error {status}: {body_text}"
        )));
    }

    let parsed: Value = serde_json::from_str(&body_text).map_err(|e| {
        AppError::Internal(format!("sidecar social/execute parse error: {e}"))
    })?;

    Ok(SocialActionResponse {
        digest: parsed
            .get("digest")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        post_id: parsed
            .get("postId")
            .and_then(|v| v.as_str())
            .map(String::from),
        comment_id: parsed
            .get("commentId")
            .and_then(|v| v.as_str())
            .map(String::from),
        repost_id: parsed
            .get("repostId")
            .and_then(|v| v.as_str())
            .map(String::from),
        deleted: parsed.get("deleted").and_then(|v| v.as_bool()),
    })
}

pub async fn create_post(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<CreatePostBody>,
) -> Result<Json<SocialActionResponse>, AppError> {
    validate_content(&body.content)?;
    let params = json!({
        "content": body.content,
        "platformObjectId": body.platform_object_id,
        "mediaUrls": body.media_urls,
        "mentions": body.mentions,
        "metadataJson": body.metadata_json,
        "allowComments": body.allow_comments,
        "allowReactions": body.allow_reactions,
        "allowReposts": body.allow_reposts,
        "allowQuotes": body.allow_quotes,
        "allowTips": body.allow_tips,
        "enableSpt": body.enable_spt,
        "enablePoc": body.enable_poc,
        "enableSpot": body.enable_spot,
        "mydataId": body.mydata_id,
    });
    let result = forward_social_execute(&state, &auth, "create_post", params, None).await?;
    Ok(Json(result))
}

pub async fn create_comment(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<CreateCommentBody>,
) -> Result<Json<SocialActionResponse>, AppError> {
    validate_content(&body.content)?;
    let params = json!({
        "postId": body.post_id,
        "content": body.content,
        "parentCommentId": body.parent_comment_id,
        "mediaUrls": body.media_urls,
        "mentions": body.mentions,
        "metadataJson": body.metadata_json,
    });
    let result = forward_social_execute(&state, &auth, "create_comment", params, None).await?;
    Ok(Json(result))
}

pub async fn react_to_post(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<ReactPostBody>,
) -> Result<Json<SocialActionResponse>, AppError> {
    validate_reaction(&body.reaction)?;
    let params = json!({
        "postId": body.post_id,
        "reaction": body.reaction,
        "platformObjectId": body.platform_object_id,
    });
    let result = forward_social_execute(&state, &auth, "react_to_post", params, None).await?;
    Ok(Json(result))
}

pub async fn react_to_comment(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<ReactCommentBody>,
) -> Result<Json<SocialActionResponse>, AppError> {
    validate_reaction(&body.reaction)?;
    let params = json!({
        "commentId": body.comment_id,
        "reaction": body.reaction,
        "platformObjectId": body.platform_object_id,
    });
    let result = forward_social_execute(&state, &auth, "react_to_comment", params, None).await?;
    Ok(Json(result))
}

pub async fn create_repost(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<CreateRepostBody>,
) -> Result<Json<SocialActionResponse>, AppError> {
    if let Some(ref content) = body.content {
        validate_content(content)?;
    }
    let params = json!({
        "originalPostId": body.original_post_id,
        "content": body.content,
        "platformObjectId": body.platform_object_id,
        "mediaUrls": body.media_urls,
        "mentions": body.mentions,
        "metadataJson": body.metadata_json,
        "allowComments": body.allow_comments,
        "allowReactions": body.allow_reactions,
        "allowReposts": body.allow_reposts,
        "allowQuotes": body.allow_quotes,
        "allowTips": body.allow_tips,
        "enableSpt": body.enable_spt,
        "enablePoc": body.enable_poc,
        "enableSpot": body.enable_spot,
    });
    let result = forward_social_execute(&state, &auth, "create_repost", params, None).await?;
    Ok(Json(result))
}

pub async fn delete_post(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(post_id): Path<String>,
) -> Result<Json<SocialActionResponse>, AppError> {
    require_delete_co_sign(&auth)?;
    let owner_key = auth
        .owner_delegate_key
        .clone()
        .ok_or_else(|| {
            AppError::BadRequest(
                "x-owner-delegate-key required for delete (owner signs the chain tx)".into(),
            )
        })?;
    let params = json!({ "postId": post_id });
    let result =
        forward_social_execute(&state, &auth, "delete_post", params, Some(owner_key)).await?;
    Ok(Json(result))
}

pub async fn delete_comment(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(comment_id): Path<String>,
    Json(body): Json<DeleteCommentBody>,
) -> Result<Json<SocialActionResponse>, AppError> {
    require_delete_co_sign(&auth)?;
    let owner_key = auth
        .owner_delegate_key
        .clone()
        .ok_or_else(|| {
            AppError::BadRequest(
                "x-owner-delegate-key required for delete (owner signs the chain tx)".into(),
            )
        })?;
    let params = json!({
        "postId": body.post_id,
        "commentId": comment_id,
    });
    let result =
        forward_social_execute(&state, &auth, "delete_comment", params, Some(owner_key)).await?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AuthInfo;

    fn auth_with_co_sign(signed: bool) -> AuthInfo {
        AuthInfo {
            public_key: "abcd".into(),
            owner: "0xowner".into(),
            account_id: "0xaccount".into(),
            agent_object_id: "0xagent".into(),
            derived_address: "0xderived".into(),
            capabilities: 0,
            approval_required_caps: 0,
            max_action_spend: None,
            platform_scope: None,
            platform_id: None,
            label: "test".into(),
            sub_agent_key: None,
            mydata_session: None,
            owner_co_signed: signed,
            owner_delegate_key: None,
        }
    }

    #[test]
    fn require_delete_co_sign_rejects_without_owner() {
        let err = require_delete_co_sign(&auth_with_co_sign(false)).unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[test]
    fn require_delete_co_sign_accepts_with_owner() {
        require_delete_co_sign(&auth_with_co_sign(true)).unwrap();
    }

    #[test]
    fn validate_content_rejects_empty() {
        assert!(validate_content("   ").is_err());
    }

    #[test]
    fn validate_reaction_rejects_empty() {
        assert!(validate_reaction("").is_err());
    }
}
