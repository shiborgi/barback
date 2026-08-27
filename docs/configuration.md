# Configuration

Set `GATEPATROL_CONFIG` to choose a YAML file; the default is `gatepatrol.yaml`. Start from `config/gatepatrol.example.yaml`.

Any scalar string can reference an environment variable with `env:NAME`. Missing variables fail startup or reload. Keep credentials out of YAML and source control.

## Clients And Policies

Each `auth.clients` entry has a unique ID, Bearer key, policy, and scopes:

- `llm:invoke` permits chat completions.
- `llm:models` permits model discovery.
- `mcp:list` permits MCP initialization, ping, and tool listing.
- `mcp:call` permits tool calls.
- `admin` permits all routes on the admin listener.

Policies allow chat model aliases and MCP toolsets. Unknown references fail validation.

## Cache Controls

The policy establishes the maximum cache mode. Requests may narrow behavior with these optional headers:

| Header | Meaning |
| --- | --- |
| `x-gatepatrol-cache-mode` | `none`, `exact`, `semantic`, or `shadow` |
| `x-gatepatrol-cache-namespace` | Isolated namespace of up to 128 safe characters |
| `x-gatepatrol-cache-ttl` | TTL such as `30s`, capped by configuration |
| `x-gatepatrol-cache-no-store` | Do not store this response when `true` |
| `x-gatepatrol-cache-refresh` | Skip lookup and refresh the entry when `true` |

Responses report cache status, context utilization, usage-window status, and request ID with `x-gatepatrol-*` headers.

## Usage Windows

Windows can be rolling or UTC calendar windows and scoped by client, provider, and model. Limits can apply to requests, input, output, total tokens, or equivalent cost in micros. Reservations use predicted maximum usage atomically; completion reconciles provider and served usage.

Cost limits scoped to a model require versioned pricing on that model. The gateway does not claim billing parity: equivalent cost is an internal policy unit derived from configured pricing.

## MCP

Servers use `stdio` or Streamable HTTP transport. Exposed names are namespaced as `server.tool`. Both server `tools.allow` and policy toolset membership are required. Tool policies classify side effects; only exact, read-only tools can be cached.

The gateway advertises its configured primary protocol and compatibility versions. The default example accepts MCP `2026-07-28`, `2025-11-25`, and `2025-03-26`.
