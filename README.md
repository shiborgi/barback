# Barback

Barback is a local policy gateway for LLM and MCP traffic. It exposes an OpenAI-compatible chat API and a single MCP endpoint while enforcing client authentication, model and tool policy, usage windows, context limits, observability, and deterministic caching.

Barback is an independent project. It does not require Codepatrol or any client-specific headers; clients opt into Barback's cache controls only when they need them.

## Status

This repository contains the MVP gateway and the semantic-cache L2 gate in shadow mode. Ollama Cloud is the first provider. Semantic serving is disabled unless it is explicitly approved and its observed quality metrics pass the configured thresholds.

## Quick Start

Requirements:

- Bun 1.4.0
- Valkey 8; Valkey Search is required only for semantic cache
- An Ollama Cloud API key and model names

```sh
bun install --frozen-lockfile
cp config/barback.example.yaml barback.yaml
cp .env.example .env
# Edit .env and set the Ollama API key and model names.
./scripts/start-valkey.sh
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

Barback can provide both the model and MCP transport to OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "barback": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Barback",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1",
        "apiKey": "{env:BARBACK_CLIENT_KEY}"
      },
      "models": {
        "code-default": { "name": "Code Default" }
      }
    }
  },
  "mcp": {
    "barback": {
      "type": "remote",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": {
        "Authorization": "Bearer {env:BARBACK_CLIENT_KEY}"
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

See [configuration](docs/configuration.md), [architecture](docs/architecture.md), [operations](docs/operations.md), and the [complete technical guide](docs/complete-guide.md) for details.

## Apple Container

The gateway and Valkey can run as containers on the same Apple Container network. Install Apple Container from its signed release package, start its system service, create the local configuration and environment file, then run:

```sh
container system start
cp config/barback.example.yaml barback.yaml
cp .env.example .env
# Edit .env and set the Ollama API key and model names.
./scripts/start-barback.sh
```

`start-barback.sh` builds the gateway image, starts Valkey without publishing its port, discovers Valkey's internal network address, and passes it to the gateway as `VALKEY_URL`. The gateway ports remain available at `127.0.0.1:8080` and `127.0.0.1:8081`.

The default `valkey/valkey:8-alpine` image does not include Valkey Search. For this setup, set `storage.valkey.vectorSearch` and `cache.semantic.enabled` to `false` in `barback.yaml`, or use a Valkey image with Search support.

If `container build` reports that Rosetta is not installed, set `rosetta = false` under `[build]` in `~/.config/container/config.toml`, restart Apple Container, and run the stack script again.

## CodePatrol

This repository is configured for the complete CodePatrol lifecycle: spec, plan, build, reviews, verification, ship, AgentPatrol resolution, ContextPatrol snapshots, and optional GitHub synchronization. The verification gate runs `bun --no-env-file run check` so ignored local credentials and service settings cannot change the result.

The committed `codepatrol.json` points to the local AgentPatrol and ContextPatrol sibling checkouts used by this workspace. Update those absolute resolver paths when using a different checkout layout. CodePatrol itself is an external CLI and does not need to be added as a Barback runtime dependency.

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
