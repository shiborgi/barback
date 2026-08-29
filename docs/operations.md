# Operations

## Health And Metrics

The public listener exposes liveness and readiness. Readiness verifies Valkey, configured providers, and MCP upstreams. Prometheus metrics and administrative operations are available only on the authenticated admin listener.

Keep both listeners bound to loopback unless an authenticated, TLS-terminating reverse proxy protects them. Do not expose Ollama, Valkey, or MCP upstreams directly.

## Container

The Dockerfile is OCI-compatible and works with Apple Container:

```sh
container build --tag barback:local .
container run --rm \
  --publish 127.0.0.1:8080:8080 \
  --publish 127.0.0.1:8081:8081 \
  --env-file .env \
  --volume "$PWD/barback.yaml:/app/barback.yaml:ro" \
  barback:local
```

Inside a container, configure the server hosts as `0.0.0.0`. Point `VALKEY_URL` at a reachable Valkey address rather than container loopback.

To run the gateway and Valkey together on Apple Container's `default` network:

```sh
container system start
cp config/barback.example.yaml barback.yaml
cp .env.example .env
# Edit .env and set the Ollama API key and model names.
./scripts/start-barback.sh
```

The stack script builds `barback:local`, starts `barback-valkey` without exposing Redis to the host, discovers its internal IP, and starts `barback-gateway` with `VALKEY_URL=redis://<valkey-ip>:6379`. Override `BARBACK_CONTAINER_NETWORK` to use another Apple Container network.

Apple Container does not resolve container names via DNS, so the script addresses dependencies by container IP on the shared network. Container IPs change when a container restarts, and `start-barback.sh` re-resolves them on every run. When the optional `google-mcp` container is present on the network, the script resolves its IP and injects `GOOGLE_MCP_URL=http://<ip>:8090/mcp`, which the gateway reads through `url: env:GOOGLE_MCP_URL` in `barback.yaml`. Published ports can be unreachable from the host with `ECONNRESET` unless Local Network access is granted; use the container IP from `container inspect` instead.

The default `valkey/valkey:8-alpine` image does not include Valkey Search. For a basic installation, set `storage.valkey.vectorSearch: false` and `cache.semantic.enabled: false` in `barback.yaml`.

If `container build` reports that Rosetta is not installed, set `rosetta = false` under `[build]` in `~/.config/container/config.toml`, restart Apple Container, and run the stack script again.

Stop the stack with:

```sh
container stop barback-gateway barback-valkey
```

## Live Verification

An opt-in suite verifies the running stack over the public listener. It is never part of the default `bun run check` run. It asserts that Barback advertises `google.list_calendars` over MCP and returns one authenticated non-streaming chat completion. It never echoes bearer tokens, API keys, refresh tokens, or full response content.

Start the stack, then point the suite at it with your client key:

```sh
./scripts/start-barback.sh
BARBACK_BASE_URL=http://127.0.0.1:8080 BARBACK_CLIENT_KEY=<key> bun run test:live
```

`BARBACK_BASE_URL` defaults to `http://127.0.0.1:8080`. On failure the suite reports only the HTTP status, the failing assertion, and the minimal assertion data (whether `google.list_calendars` was found, or content presence and length).

## Local Valkey

Start Valkey with Apple Container for local integration tests:

```sh
./scripts/start-valkey.sh
VALKEY_URL=redis://127.0.0.1:6379 bun run test:integration
```

The script uses the `barback-valkey` container and `barback-valkey-data` volume by default. Stop and remove the container with:

```sh
container stop barback-valkey
container delete barback-valkey
```

If `container exec barback-valkey valkey-cli ping` returns `PONG` but the host gets `ECONNRESET`, grant Local Network access to `container-runtime-linux` in System Settings > Privacy & Security > Local Network. On macOS versions where the runtime is not listed, allow the default container subnet and reboot:

```sh
sudo defaults write com.apple.network.local-network AllowedEthernetLocalNetworkAddresses -array "192.168.64.0/24"
sudo defaults write com.apple.network.local-network AllowedWiFiLocalNetworkAddresses -array "192.168.64.0/24"
```

After rebooting, restart Apple Container and run `./scripts/start-valkey.sh` again.

## Reload And Shutdown

Send `SIGHUP` or call the admin reload endpoint after changing YAML. Invalid replacements are rejected without changing the active runtime. `SIGINT` and `SIGTERM` stop both listeners and close runtime and telemetry resources.

## Troubleshooting

- A `401` means the Bearer key is absent or unknown.
- A `403` means the client lacks a scope or its policy denies the model/tool.
- A `429` means an atomic usage-window reservation exceeded a hard limit.
- A `503` from readiness identifies unavailable dependencies in the response body.
- Set semantic cache to disabled when Valkey Search is unavailable.

Structured logs redact credential-shaped fields. Content and headers are not captured unless explicitly enabled; enabling either can expose sensitive prompts or metadata.
