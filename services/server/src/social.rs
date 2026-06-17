use serde::Deserialize;

/// Sub-agent row returned by the social server API.
#[derive(Debug, Clone, Deserialize)]
pub struct SocialSubAgent {
    pub agent_object_id: String,
    pub account_id: String,
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug)]
pub enum SocialApiError {
    Http(String),
    NotFound,
    Parse(String),
}

impl std::fmt::Display for SocialApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SocialApiError::Http(msg) => write!(f, "social API HTTP error: {}", msg),
            SocialApiError::NotFound => write!(f, "sub-agent not found in social index"),
            SocialApiError::Parse(msg) => write!(f, "social API parse error: {}", msg),
        }
    }
}

impl std::error::Error for SocialApiError {}

/// Fetch a sub-agent by derived address from the social server.
pub async fn fetch_sub_agent_by_derived_address(
    http_client: &reqwest::Client,
    base_url: &str,
    derived_address: &str,
) -> Result<SocialSubAgent, SocialApiError> {
    let url = format!(
        "{}/sub-agents/{}",
        base_url.trim_end_matches('/'),
        derived_address
    );

    let response = http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| SocialApiError::Http(e.to_string()))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(SocialApiError::NotFound);
    }

    if !response.status().is_success() {
        return Err(SocialApiError::Http(format!(
            "status {}",
            response.status()
        )));
    }

    response
        .json::<SocialSubAgent>()
        .await
        .map_err(|e| SocialApiError::Parse(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn social_sub_agent_deserializes() {
        let json = r#"{
            "agent_object_id": "0xagent",
            "derived_address": "0xderived",
            "account_id": "0xaccount",
            "capabilities": 3,
            "active": true
        }"#;
        let row: SocialSubAgent = serde_json::from_str(json).unwrap();
        assert_eq!(row.account_id, "0xaccount");
        assert_eq!(row.agent_object_id, "0xagent");
        assert!(row.active);
    }

    #[tokio::test]
    async fn fetch_sub_agent_hits_mock_social_api() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock social server");
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = vec![0u8; 4096];
            let _ = socket.read(&mut buf).await;
            let body = r#"{"agent_object_id":"0xagent","derived_address":"0xderived","account_id":"0xaccount","capabilities":3,"active":true}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.ok();
        });

        let client = reqwest::Client::new();
        let base = format!("http://{}", addr);
        let row = fetch_sub_agent_by_derived_address(&client, &base, "0xderived")
            .await
            .expect("fetch");
        assert_eq!(row.account_id, "0xaccount");
        assert_eq!(row.agent_object_id, "0xagent");
    }
}
