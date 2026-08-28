#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
app_name="${BARBACK_APP_CONTAINER:-barback-gateway}"
image="${BARBACK_APP_IMAGE:-barback:local}"
network="${BARBACK_CONTAINER_NETWORK:-default}"
valkey_name="${BARBACK_VALKEY_CONTAINER:-barback-valkey}"
google_mcp_name="${BARBACK_GOOGLE_MCP_CONTAINER:-google-mcp}"
config_file="${BARBACK_CONFIG_FILE:-$root_dir/barback.yaml}"
env_file="${BARBACK_ENV_FILE:-$root_dir/.env}"

if ! command -v container >/dev/null 2>&1; then
  printf 'Apple Container CLI not found. Install it and try again.\n' >&2
  exit 1
fi

if [[ ! -f "$config_file" ]]; then
  printf 'Configuration not found: %s\n' "$config_file" >&2
  printf 'Create it with: cp config/barback.example.yaml barback.yaml\n' >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  printf 'Environment file not found: %s\n' "$env_file" >&2
  printf 'Create it with: cp .env.example .env\n' >&2
  exit 1
fi

if ! container system status >/dev/null 2>&1; then
  printf 'Starting Apple Container services...\n'
  container system start
fi

if ! container network inspect "$network" >/dev/null 2>&1; then
  printf 'Creating Apple Container network: %s\n' "$network"
  container network create "$network"
fi

BARBACK_VALKEY_CONTAINER="$valkey_name" \
BARBACK_VALKEY_NETWORK="$network" \
BARBACK_VALKEY_PUBLISH=false \
"$root_dir/scripts/start-valkey.sh"

valkey_address="$(container inspect "$valkey_name" | plutil -extract '0.status.networks.0.ipv4Address' raw -)"
valkey_ip="${valkey_address%%/*}"
if [[ -z "$valkey_ip" ]]; then
  printf 'Could not determine the Valkey container IP.\n' >&2
  exit 1
fi

google_mcp_ip=""
google_mcp_url=""
if container inspect "$google_mcp_name" >/dev/null 2>&1; then
  google_mcp_address="$(container inspect "$google_mcp_name" | plutil -extract '0.status.networks.0.ipv4Address' raw - 2>/dev/null || true)"
  google_mcp_ip="${google_mcp_address%%/*}"
fi
if [[ -z "$google_mcp_ip" ]]; then
  printf 'google-mcp container not found; skipping upstream injection\n'
else
  google_mcp_url="http://$google_mcp_ip:8090/mcp"
  printf 'Resolved google-mcp upstream: %s\n' "$google_mcp_url"
fi

printf 'Building gateway image: %s\n' "$image"
container build --tag "$image" "$root_dir"

if container inspect "$app_name" >/dev/null 2>&1; then
  if container list --format json | grep -Fq "\"id\":\"$app_name\""; then
    valkey_ok=false
    if container exec "$app_name" bun -e 'import Redis from "ioredis"; const redis = new Redis(process.env.VALKEY_URL); console.log(await redis.ping()); await redis.quit();' 2>/dev/null | grep -Fq PONG; then
      valkey_ok=true
    fi
    recorded_google_mcp_ip="$(container inspect "$app_name" | plutil -extract '0.configuration.labels.google-mcp-ip' raw - 2>/dev/null || true)"
    if { $valkey_ok; } && { [[ -z "$google_mcp_ip" ]] || [[ "$recorded_google_mcp_ip" == "$google_mcp_ip" ]]; }; then
      printf 'Gateway container already running: %s\n' "$app_name"
      exit 0
    fi
    if ! $valkey_ok; then
      printf 'Recreating gateway container after the Valkey address changed.\n'
    else
      printf 'Recreating gateway container after the google-mcp address changed.\n'
    fi
    container stop "$app_name"
  fi
  container delete "$app_name"
fi

printf 'Starting gateway container: %s\n' "$app_name"
run_extra_args=""
if [[ -n "$google_mcp_url" ]]; then
  run_extra_args="$run_extra_args --env GOOGLE_MCP_URL=$google_mcp_url"
fi
if [[ -n "$google_mcp_ip" ]]; then
  run_extra_args="$run_extra_args --label google-mcp-ip=$google_mcp_ip"
fi
container run \
  --detach \
  --name "$app_name" \
  --network "$network" \
  --publish 127.0.0.1:8080:8080 \
  --publish 127.0.0.1:8081:8081 \
  --env-file "$env_file" \
  --env BARBACK_CONFIG=/app/barback.yaml \
  --env BARBACK_SERVER_HOST=0.0.0.0 \
  --env BARBACK_ADMIN_HOST=0.0.0.0 \
  --env VALKEY_URL="redis://$valkey_ip:6379" \
  $run_extra_args \
  --volume "$config_file:/app/barback.yaml:ro" \
  "$image"

for _ in {1..30}; do
  if container exec "$app_name" bun -e 'import Redis from "ioredis"; const redis = new Redis(process.env.VALKEY_URL); console.log(await redis.ping()); await redis.quit();' 2>/dev/null | grep -Fq PONG; then
    printf 'Gateway is running on 127.0.0.1:8080 and 127.0.0.1:8081\n'
    printf 'Gateway-Valkey network: %s (%s)\n' "$network" "$valkey_ip"
    exit 0
  fi
  sleep 1
done

printf 'Gateway did not connect to Valkey. Check logs with: container logs %s\n' "$app_name" >&2
exit 1
