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

See [configuration](docs/configuration.md), [architecture](docs/architecture.md), [operations](docs/operations.md), the proposed [DNS and service discovery specification](docs/dns-service-discovery-spec.md), and the [complete technical guide](docs/complete-guide.md) for details.

## Apple Container

The DNS reconciler creates the NAT `barback` network, starts the managed resolver, Valkey, and gateway from `barback-stack.yaml`, and gives managed services the resolver plus the configured DNS search domain. The gateway descriptor supplies its `.env` file, required runtime settings, and read-only `barback.yaml` mount. Google MCP remains an optional adopted external dependency. DNS, Valkey, and MCP ports are not published; application endpoints use FQDNs, never container IPs.

```sh
cp config/barback.example.yaml barback.yaml
cp .env.example .env
# Edit .env and set the Ollama API key, model names, and Google MCP token.
cp config/barback-stack.example.yaml barback-stack.yaml
bun run reconcile -- up
```

`bun run reconcile -- reconcile` validates the manifest, Apple Container network, service labels, identities, and published ports before atomically publishing DNS records and a lease. Run it under `launchd` every 10 seconds. `status` emits non-secret JSON, and `client-config` writes a validated FQDN-only OneCLI client configuration. If the supervisor stops, the resolver fails closed when the lease expires. The resolver deliberately receives no `--dns` argument.

The default `valkey/valkey:8-alpine` image does not include Valkey Search. For this setup, set `storage.valkey.vectorSearch` and `cache.semantic.enabled` to `false` in `barback.yaml`, or use a Valkey image with Search support.

If `container build` reports that Rosetta is not installed, set `rosetta = false` under `[build]` in `~/.config/container/config.toml`, restart Apple Container, and run the reconciler again.

Apple Container has no restart policy. Use `launchd` to supervise the reconciler instead of `keepalive.sh`; the foreground reconciler is what keeps the resolver lease valid and refreshes records after independently recreated services receive a new address.

launchd (supervised foreground process):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.shiborgi.barback.dns-reconciler</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/bun</string>
    <string>run</string>
    <string>reconcile</string>
    <string>--</string>
    <string>supervise</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/server/Development/shiborgi/barback</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.shiborgi.barback.dns-reconciler.plist`. The adopted Google MCP service is an external dependency owned by the google-mcp project; the reconciler validates and records it but does not implement or start it. Bartender and OneCLI are also external dependencies: Barback only publishes their non-secret FQDN client contract.

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
