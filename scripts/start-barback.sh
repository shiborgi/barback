#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
app_name="${BARBACK_APP_CONTAINER:-barback-gateway}"
image="${BARBACK_APP_IMAGE:-barback:local}"
network="${BARBACK_CONTAINER_NETWORK:-default}"
valkey_name="${BARBACK_VALKEY_CONTAINER:-barback-valkey}"
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

printf 'Building gateway image: %s\n' "$image"
container build --tag "$image" "$root_dir"

if container inspect "$app_name" >/dev/null 2>&1; then
  if container list --format json | grep -Fq "\"id\":\"$app_name\""; then
    if container exec "$app_name" bun -e 'import Redis from "ioredis"; const redis = new Redis(process.env.VALKEY_URL); console.log(await redis.ping()); await redis.quit();' 2>/dev/null | grep -Fq PONG; then
      printf 'Gateway container already running: %s\n' "$app_name"
      exit 0
    fi
    printf 'Recreating gateway container after the Valkey address changed.\n'
    container stop "$app_name"
  fi
  container delete "$app_name"
fi

printf 'Starting gateway container: %s\n' "$app_name"
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
