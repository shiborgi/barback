# Architecture

Gatepatrol keeps one request pipeline and explicit boundaries around external systems.

1. Hono accepts the OpenAI-compatible or MCP request and assigns a request ID.
2. Bearer authentication resolves a client and its scopes and policy.
3. The policy selects allowed models or MCP toolsets and clamps output limits.
4. Context pressure and usage windows reserve the maximum predicted usage before provider work.
5. Exact cache is checked first. Eligible semantic candidates are evaluated only for requests with stable hard filters.
6. The Ollama adapter performs timeout, retry, and circuit-breaker handling and normalizes native responses.
7. Provider and served usage are reconciled separately, then metrics and versioned usage events are recorded.

Valkey stores exact entries, locks, usage windows, usage events, and MCP read-cache entries. Valkey Search stores semantic vectors. A process-local L1 fronts exact entries without changing their canonical identity.

## Cache Safety

Exact keys include client, namespace, provider, model, normalized messages, tools, sampling parameters, output constraints, and response format. Client isolation is therefore the default even when callers choose the same namespace.

Semantic cache starts in `shadow` mode. It records candidates and similarity without serving them. Serving additionally requires `servingApproved: true`, the configured minimum sample count and precision, and a false-hit rate below the configured maximum. Tool-call responses are never cached.

MCP is deny-by-default. A tool must be allowed by its upstream server configuration and by a toolset attached to the client's policy. Only tools explicitly declared `effect: read` can use exact MCP caching, and cache lookup occurs before upstream execution.

## Reload Model

`SIGHUP` or `POST /admin/config/reload` parses and cross-validates a complete replacement configuration before swapping runtime resources. A failed parse leaves the active configuration untouched.
