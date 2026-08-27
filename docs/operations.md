# Operations

## Health And Metrics

The public listener exposes liveness and readiness. Readiness verifies Valkey, configured providers, and MCP upstreams. Prometheus metrics and administrative operations are available only on the authenticated admin listener.

Keep both listeners bound to loopback unless an authenticated, TLS-terminating reverse proxy protects them. Do not expose Ollama, Valkey, or MCP upstreams directly.

## Container

The Dockerfile is OCI-compatible and works with Apple Container:

```sh
container build --tag gatepatrol:local .
container run --rm \
  --publish 127.0.0.1:8080:8080 \
  --publish 127.0.0.1:8081:8081 \
  --env-file .env \
  --volume "$PWD/gatepatrol.yaml:/app/gatepatrol.yaml:ro" \
  gatepatrol:local
```

Inside a container, configure the server hosts as `0.0.0.0`. Point `VALKEY_URL` at a reachable Valkey address rather than container loopback.

## Reload And Shutdown

Send `SIGHUP` or call the admin reload endpoint after changing YAML. Invalid replacements are rejected without changing the active runtime. `SIGINT` and `SIGTERM` stop both listeners and close runtime and telemetry resources.

## Troubleshooting

- A `401` means the Bearer key is absent or unknown.
- A `403` means the client lacks a scope or its policy denies the model/tool.
- A `429` means an atomic usage-window reservation exceeded a hard limit.
- A `503` from readiness identifies unavailable dependencies in the response body.
- Set semantic cache to disabled when Valkey Search is unavailable.

Structured logs redact credential-shaped fields. Content and headers are not captured unless explicitly enabled; enabling either can expose sensitive prompts or metadata.
