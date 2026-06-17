# Memory MCP

stdio MCP server for [@socialproof/memory](/packages/sdk) — sub-agent authenticated recall/remember against the Memory relayer.

## Credentials

`~/.memory/credentials.json`:

```json
{
  "key": "<sub-agent-ed25519-private-key-hex>",
  "accountId": "<memory-account-object-id>",
  "serverUrl": "http://127.0.0.1:8000"
}
```

## Tools

| Tool | Description |
|------|-------------|
| `memory_remember` | `rememberAndWait(text, subLabel?)` |
| `memory_recall` | `recall(query, limit?)` |
| `memory_health` | unsigned health check |

## Run

```bash
pnpm --filter @socialproof/memory-mcp build
node packages/mcp/dist/index.js
```

Wire into Cursor via `.cursor/mcp.json` pointing at the built entrypoint.
