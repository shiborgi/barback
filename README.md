# Gatepatrol

Gatepatrol is a local policy gateway for LLM and MCP traffic. It exposes an OpenAI-compatible chat API and a single MCP endpoint while enforcing client authentication, model and tool policy, usage windows, context limits, observability, and deterministic caching.

Gatepatrol is an independent project. It does not require Codepatrol or any client-specific headers; clients opt into Gatepatrol's cache controls only when they need them.

## Status

This repository contains the MVP gateway and the semantic-cache L2 gate in shadow mode. Ollama Cloud is the first provider. Semantic serving is disabled unless it is explicitly approved and its observed quality metrics pass the configured thresholds.

## Quick Start

Requirements:

- Bun 1.4.0
- Valkey 8; Valkey Search is required only for semantic cache
- An Ollama Cloud API key and model names

```sh
bun install --frozen-lockfile
cp config/gatepatrol.example.yaml gatepatrol.yaml
export GATEPATROL_CLIENT_KEY=local-client-key
export GATEPATROL_ADMIN_KEY=local-admin-key
export OLLAMA_API_KEY=your-key
export OLLAMA_CODE_MODEL=your-chat-model
export OLLAMA_EMBEDDING_MODEL=your-embedding-model
export VALKEY_URL=redis://127.0.0.1:6379
bun run start
```

For a Valkey installation without the Search module, set `storage.valkey.vectorSearch: false` and `cache.semantic.enabled: false`.

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Authorization: Bearer local-client-key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"code-default","messages":[{"role":"user","content":"Hello"}]}'
```

## OpenCode

Gatepatrol can provide both the model and MCP transport to OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "gatepatrol": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Gatepatrol",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1",
        "apiKey": "{env:GATEPATROL_CLIENT_KEY}"
      },
      "models": {
        "code-default": { "name": "Code Default" }
      }
    }
  },
  "mcp": {
    "gatepatrol": {
      "type": "remote",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": {
        "Authorization": "Bearer {env:GATEPATROL_CLIENT_KEY}"
      }
    }
  }
}
```

## Interfaces

Public listener, `127.0.0.1:8080` by default:

- `POST /v1/chat/completions`
- `GET /v1/models`
- `POST /mcp`
- `GET /health`, `/health/live`, and `/health/ready`

Authenticated admin listener, `127.0.0.1:8081` by default:

- `GET /metrics`
- `GET /admin/usage/windows`
- `GET /admin/cache/stats`
- `DELETE /admin/cache/entries/:id`
- `DELETE /admin/cache/namespaces/:namespace`
- `POST /admin/config/reload`

See [configuration](docs/configuration.md), [architecture](docs/architecture.md), and [operations](docs/operations.md) for details.

## Development

```sh
bun run check
bun run test:unit
bun run test:contract
VALKEY_URL=redis://127.0.0.1:6379 bun run test:integration
```

Live provider and MCP suites are opt-in: `bun run test:live`. They are never part of the deterministic default test run.

## License

MIT
