//! Fixed configured-fullnode reads and lossless chain value parsers. No caller RPC/URL selection.
use crate::types::{AppError, AppState};
use serde_json::{json, Value};
fn invalid() -> AppError {
    AppError::Internal("Chain data is invalid or unavailable".into())
}
fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
pub(crate) fn id(value: &str) -> Result<String, AppError> {
    let v = value
        .strip_prefix("0x")
        .ok_or_else(|| bad("Invalid chain object/address ID"))?;
    if v.is_empty() || v.len() > 64 || !v.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad("Invalid chain object/address ID"));
    }
    Ok(format!("0x{:0>64}", v.to_ascii_lowercase()))
}
pub(crate) fn address(v: Option<&Value>) -> Result<String, AppError> {
    id(v.and_then(Value::as_str).ok_or_else(invalid)?)
}
pub(crate) fn same(a: &str, b: &str) -> bool {
    matches!((id(a),id(b)),(Ok(a),Ok(b)) if a==b)
}
pub(crate) fn u64_value(v: Option<&Value>) -> Result<u64, AppError> {
    match v {
        Some(Value::String(s))
            if !s.is_empty()
                && (s == "0" || !s.starts_with('0'))
                && s.bytes().all(|b| b.is_ascii_digit()) =>
        {
            s.parse().map_err(|_| invalid())
        }
        Some(Value::Number(n)) => n.as_u64().ok_or_else(invalid),
        _ => Err(invalid()),
    }
}
pub(crate) fn coin_type(value: &str) -> Result<String, AppError> {
    if value.len() > 512 || !value.is_ascii() {
        return Err(invalid());
    }
    struct Parser<'a> {
        s: &'a str,
        p: usize,
    }
    impl Parser<'_> {
        fn space(&mut self) {
            while self
                .s
                .as_bytes()
                .get(self.p)
                .is_some_and(u8::is_ascii_whitespace)
            {
                self.p += 1;
            }
        }
        fn eat(&mut self, text: &str) -> Result<(), AppError> {
            self.space();
            if !self.s[self.p..].starts_with(text) {
                return Err(invalid());
            }
            self.p += text.len();
            Ok(())
        }
        fn word(&mut self) -> Result<String, AppError> {
            self.space();
            let start = self.p;
            while self
                .s
                .as_bytes()
                .get(self.p)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            {
                self.p += 1;
            }
            let w = &self.s[start..self.p];
            if w.is_empty() || !w.as_bytes()[0].is_ascii_alphabetic() && w.as_bytes()[0] != b'_' {
                return Err(invalid());
            }
            Ok(w.into())
        }
        fn ty(&mut self, depth: u8) -> Result<String, AppError> {
            if depth > 8 {
                return Err(invalid());
            }
            self.space();
            for simple in ["bool", "u8", "u16", "u32", "u64", "u128", "u256", "address"] {
                if self.s[self.p..].starts_with(simple)
                    && !self
                        .s
                        .as_bytes()
                        .get(self.p + simple.len())
                        .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
                {
                    self.p += simple.len();
                    return Ok(simple.into());
                }
            }
            if self.s[self.p..].starts_with("vector") {
                self.eat("vector")?;
                self.eat("<")?;
                let t = self.ty(depth + 1)?;
                self.eat(">")?;
                return Ok(format!("vector<{t}>"));
            }
            if self.s[self.p..].starts_with("0x") {
                self.p += 2;
            }
            let start = self.p;
            while self
                .s
                .as_bytes()
                .get(self.p)
                .is_some_and(u8::is_ascii_hexdigit)
            {
                self.p += 1;
            }
            let bytes = &self.s[start..self.p];
            if bytes.is_empty() || bytes.len() > 64 {
                return Err(invalid());
            }
            let addr = id(&format!("0x{bytes}"))?;
            self.eat("::")?;
            let module = self.word()?;
            self.eat("::")?;
            let name = self.word()?;
            let mut out = format!("{addr}::{module}::{name}");
            self.space();
            if self.s.as_bytes().get(self.p) == Some(&b'<') {
                self.p += 1;
                let mut args = vec![self.ty(depth + 1)?];
                self.space();
                while self.s.as_bytes().get(self.p) == Some(&b',') {
                    self.p += 1;
                    args.push(self.ty(depth + 1)?);
                    if args.len() > 16 {
                        return Err(invalid());
                    }
                    self.space();
                }
                self.eat(">")?;
                out.push('<');
                out.push_str(&args.join(","));
                out.push('>');
            }
            Ok(out)
        }
    }
    let mut parser = Parser { s: value, p: 0 };
    let out = parser.ty(0)?;
    parser.space();
    if parser.p != value.len() || !out.starts_with("0x") {
        return Err(invalid());
    }
    Ok(out)
}
pub(crate) async fn rpc(state: &AppState, method: &str, params: Value) -> Result<Value, AppError> {
    let mut response = state
        .http_client
        .post(&state.config.myso_rpc_url)
        .timeout(std::time::Duration::from_secs(20))
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .await
        .map_err(|_| invalid())?;
    if !response.status().is_success() {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
        if bytes.len().saturating_add(chunk.len()) > 2 * 1024 * 1024 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    body.get("result")
        .filter(|v| !v.is_null())
        .cloned()
        .ok_or_else(invalid)
}
pub(crate) async fn object(state: &AppState, object_id: &str) -> Result<Value, AppError> {
    let object_id = id(object_id)?;
    let result = rpc(
        state,
        "myso_getObject",
        json!([object_id,{"showContent":true,"showOwner":true}]),
    )
    .await?;
    let data = result
        .get("data")
        .ok_or_else(|| AppError::BlobNotFound("Chain object unavailable".into()))?;
    if address(data.get("objectId"))? != object_id {
        return Err(invalid());
    }
    Ok(data.clone())
}

pub(crate) fn digest_bytes(value: &str) -> Result<[u8; 32], AppError> {
    if value.is_empty() || value.len() > 44 {
        return Err(invalid());
    }
    let alphabet = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut bytes = [0u8; 32];
    for byte in value.bytes() {
        let mut carry = alphabet
            .iter()
            .position(|digit| *digit == byte)
            .ok_or_else(invalid)? as u16;
        for digit in bytes.iter_mut().rev() {
            carry += u16::from(*digit) * 58;
            *digit = carry as u8;
            carry >>= 8;
        }
        if carry != 0 {
            return Err(invalid());
        }
    }
    if value.bytes().take_while(|byte| *byte == b'1').count()
        != bytes.iter().take_while(|byte| **byte == 0).count()
    {
        return Err(invalid());
    }
    Ok(bytes)
}
