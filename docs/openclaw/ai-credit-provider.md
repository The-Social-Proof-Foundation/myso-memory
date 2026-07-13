---
title: "AI Credit Provider (OpenClaw / Hermes)"
description: "Point OpenClaw or Hermes at the AI credit oracle OpenAI-compatible /v1 surface so chat is billed through on-chain AI credits and OpenRouter."
---

Route OpenClaw (and other OpenAI-compatible harnesses such as Hermes) through MySo AI credits instead of a raw OpenAI/OpenRouter API key.

Two services stay separate:

| Service | Port (local) | Role |
| --- | --- | --- |
| Memory relayer | `:8000` | Encrypted memory recall/capture + signed native SDK routes |
| AI credit oracle | `:8095` | OpenAI-compatible model provider + OpenRouter key holder + reserve/capture |

The oracle exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/models` | List configured AI-credit models |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (non-streaming) |
| `POST` | `/v1/responses` | OpenAI Responses API (non-streaming; preferred by OpenClaw) |

Auth for those routes is standard Bearer token auth (`Authorization: Bearer <token>`). The oracle maps that token to a preconfigured owner/balance/agent identity, then runs the same reserve → OpenRouter → capture path as `POST /v1/ai-credit/inference`.

The Memory relayer still exposes the **native signed** route `POST /api/ai-credit/inference` for the Memory SDK. It is not an OpenAI-compatible proxy.

```mermaid
flowchart LR
  OpenClaw[OpenClaw Chat] -->|"Bearer + /v1/responses"| Oracle[AI Credit Oracle :8095]
  Hermes[Hermes Or Harness] -->|"Bearer + /v1/chat/completions"| Oracle
  Relayer[Memory Relayer :8000] -->|"signed /api/ai-credit/inference"| OracleNative["/v1/ai-credit/inference"]
  Oracle --> Core[run_inference_core]
  OracleNative --> Core
  Core --> Ledger[Reservation Ledger]
  Core --> Chain[Reserve And Capture]
  Core --> OpenRouter[OpenRouter]
```

## Oracle env

Enable inference **and** configure the OpenAI provider identity on the oracle:

```bash
AI_CREDIT_INFERENCE_ENABLED=true
AI_CREDIT_OPENROUTER_API_KEY=sk-or-...
AI_CREDIT_ORACLE_API_SECRET=local-oracle-secret
AI_CREDIT_CONFIG_OBJECT_ID=0x...
AI_CREDIT_SETTLEMENT_KEY_HEX=...

# OpenAI-compatible bridge (required for OpenClaw/Hermes)
AI_CREDIT_PROVIDER_TOKEN=local-openclaw-token
AI_CREDIT_PROVIDER_OWNER=0xYOUR_OWNER_ADDRESS
AI_CREDIT_PROVIDER_BALANCE_ID=0xYOUR_AI_CREDIT_BALANCE
AI_CREDIT_PROVIDER_MEMORY_ACCOUNT_ID=0xYOUR_MEMORY_ACCOUNT
AI_CREDIT_PROVIDER_AGENT_OBJECT_ID=0xYOUR_SUB_AGENT_OBJECT
# Optional: comma-separated model ids for GET /v1/models
AI_CREDIT_PROVIDER_MODELS=openai/gpt-4o-mini,openai/gpt-4o
```

The mapped agent must already hold `CAP_AI_SPEND` and the balance must exist on-chain. Policy / capability checks still run inside the oracle reserve path.

## Memory relayer env

For Memory plugin recall/capture and native analyze/ask billing:

```bash
AI_CREDIT_ENABLED=true
AI_CREDIT_ORACLE_URL=http://127.0.0.1:8095
AI_CREDIT_ORACLE_API_SECRET=local-oracle-secret
DEFAULT_LLM_MODEL=openai/gpt-4o-mini
```

Do **not** configure `AI_CREDIT_PROVIDER_*` on the relayer. Those belong only to the oracle.

## OpenClaw config

Point the **model provider** at the oracle and the **memory plugin** at the relayer. Example `~/.openclaw/openclaw.json` fragment:

```jsonc
{
  "agents": {
    "defaults": {
      "model": { "primary": "myso-ai-credit/openai/gpt-4o-mini" }
    }
  },
  "models": {
    "providers": {
      "myso-ai-credit": {
        "baseUrl": "http://127.0.0.1:8095/v1",
        "api": "openai-responses",
        "apiKey": "${MYSO_AI_CREDIT_PROVIDER_TOKEN}",
        "models": [
          { "id": "openai/gpt-4o-mini", "name": "openai/gpt-4o-mini" },
          { "id": "openai/gpt-4o", "name": "openai/gpt-4o" }
        ]
      }
    }
  },
  "plugins": {
    "entries": {
      "memory": {
        "enabled": true,
        "config": {
          "privateKey": "${MEMORY_PRIVATE_KEY}",
          "accountId": "0xREPLACE_WITH_YOUR_MEMORY_ACCOUNT_ID",
          "serverUrl": "http://127.0.0.1:8000"
        }
      }
    }
  }
}
```

Then:

```bash
export MYSO_AI_CREDIT_PROVIDER_TOKEN=local-openclaw-token
export MEMORY_PRIVATE_KEY=...   # hex sub-agent key for memory plugin

openclaw models auth paste-api-key --provider myso-ai-credit --profile-id myso-ai-credit:apikey
# paste the same token when prompted

openclaw gateway   # terminal 1
openclaw chat      # terminal 2
```

If your OpenClaw build rejects the custom provider id via `paste-api-key`, store the token with:

```bash
openclaw config set models.providers.myso-ai-credit.apiKey "$MYSO_AI_CREDIT_PROVIDER_TOKEN"
```

## Hermes / other harnesses

Any client that supports a custom OpenAI base URL works the same way against the **oracle**:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8095/v1
export OPENAI_API_KEY=local-openclaw-token
```

## Smoke test (no OpenClaw)

```bash
curl -s http://127.0.0.1:8095/v1/models \
  -H "Authorization: Bearer local-openclaw-token" | jq

curl -s http://127.0.0.1:8095/v1/chat/completions \
  -H "Authorization: Bearer local-openclaw-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role":"user","content":"Reply with: AI_CREDIT_OK"}],
    "max_tokens": 32
  }' | jq
```

## Local E2E checklist

1. Start AI-credit oracle on `:8095` with inference + OpenRouter + provider token mapping.
2. Start Memory relayer on `:8000` with `AI_CREDIT_ENABLED=true` and matching oracle secret (for native Memory/AI routes).
3. Confirm `GET http://127.0.0.1:8095/v1/models` with the Bearer token returns your models.
4. Configure OpenClaw with `models.providers.myso-ai-credit.baseUrl = http://127.0.0.1:8095/v1` and memory plugin `serverUrl = http://127.0.0.1:8000`.
5. Run `openclaw gateway` then `openclaw chat`.
6. Expected proof:
   - OpenClaw receives an assistant reply
   - Oracle logs show reserve + capture
   - OpenClaw is **not** configured with a direct OpenAI/OpenRouter API key for this model
   - The OpenRouter API key exists only on the oracle

## Notes

- Streaming is not supported in the first version of the bridge (`stream: true` returns `400`).
- Native signed Memory routes (`POST /api/ai-credit/inference`) remain unchanged and should still be used by the Memory SDK.
- OpenClaw should **not** have a direct OpenAI/OpenRouter key for this path; only the oracle holds provider credentials.
