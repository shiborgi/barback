#!/usr/bin/env bash

set -euo pipefail

container_name="${BARBACK_VALKEY_CONTAINER:-barback-valkey}"
image="${BARBACK_VALKEY_IMAGE:-valkey/valkey:8-alpine}"
network="${BARBACK_VALKEY_NETWORK:-default}"
host="${BARBACK_VALKEY_HOST:-127.0.0.1}"
port="${BARBACK_VALKEY_PORT:-6379}"
volume="${BARBACK_VALKEY_VOLUME:-barback-valkey-data}"
publish="${BARBACK_VALKEY_PUBLISH:-true}"

if ! command -v container >/dev/null 2>&1; then
  printf 'Apple Container CLI not found. Install it and try again.\n' >&2
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

if container inspect "$container_name" >/dev/null 2>&1; then
  if container list --format json | grep -Fq "\"id\":\"$container_name\""; then
    printf 'Valkey container already running: %s\n' "$container_name"
  else
    printf 'Starting existing Valkey container: %s\n' "$container_name"
    container start "$container_name"
  fi
else
  printf 'Creating Valkey container: %s\n' "$container_name"
  run_args=(
    --detach
    --name "$container_name"
    --network "$network"
    --volume "$volume:/data"
  )
  if [[ "$publish" == "true" ]]; then
    run_args+=(--publish "$host:$port:6379")
  fi
  container run "${run_args[@]}" "$image"
fi

for _ in {1..30}; do
  if [[ "$(container exec "$container_name" valkey-cli ping 2>/dev/null)" == "PONG" ]]; then
    if [[ "$publish" == "true" ]]; then
      printf 'Valkey is ready at %s:%s\n' "$host" "$port"
    else
      printf 'Valkey is ready on Apple Container network %s\n' "$network"
    fi
    exit 0
  fi
  sleep 1
done

printf 'Valkey did not become ready. Check logs with: container logs %s\n' "$container_name" >&2
exit 1
