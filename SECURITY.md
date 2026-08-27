# Security Policy

## Reporting

Report vulnerabilities privately through GitHub's security advisory feature for `shiborgi/gatepatrol`. Do not open a public issue with credentials, prompts, or exploit details.

## Deployment Baseline

- Bind public and admin listeners to loopback by default.
- Put TLS and network authentication in front of any non-local deployment.
- Use separate, randomly generated client and admin keys via environment variables.
- Keep Valkey and MCP upstreams on trusted networks.
- Leave content/header logging and semantic serving disabled unless their risks are understood.
- Restrict MCP tools to the minimum allowlist and accurately classify side effects.

Gatepatrol redacts common credential fields, but operators remain responsible for log destinations, environment security, upstream trust, and retention policies.
