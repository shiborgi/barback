#!/usr/bin/env bash

set -euo pipefail

container_name="${BARBACK_VALKEY_CONTAINER:-barback-valkey}"
image="${BARBACK_VALKEY_IMAGE:-valkey/valkey:8-alpine}"
network="${BARBACK_VALKEY_NETWORK:-barback}"
volume="${BARBACK_VALKEY_VOLUME:-barback-valkey-data}"
resolver="${BARBACK_DNS_RESOLVER:-}"
search="${BARBACK_DNS_SEARCH:-barback.internal}"
stack_id="${BARBACK_STACK_ID:-}"

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
  configured_network="$(container inspect "$container_name" | plutil -extract '0.configuration.networks.0.network' raw - 2>/dev/null || true)"
  configured_resolver="$(container inspect "$container_name" | plutil -extract '0.configuration.dns.nameservers.0' raw - 2>/dev/null || true)"
  if [[ "$configured_network" != "$network" || ( -n "$resolver" && "$configured_resolver" != "$resolver" ) ]]; then
    printf 'Recreating Valkey container with the Barback network and DNS configuration.\n'
    if container list --format json | grep -Fq "\"id\":\"$container_name\""; then container stop "$container_name"; fi
    container delete "$container_name"
    run_args=(
      --detach
      --name "$container_name"
      --network "$network"
      --volume "$volume:/data"
      --label "io.shiborgi.barback.stack=$stack_id"
      --label "io.shiborgi.barback.service=valkey"
      --label "io.shiborgi.barback.role=storage"
    )
    if [[ -n "$resolver" ]]; then run_args+=(--dns "$resolver" --dns-search "$search"); fi
    container run "${run_args[@]}" "$image"
  elif container list --format json | grep -Fq "\"id\":\"$container_name\""; then
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
    --label "io.shiborgi.barback.stack=$stack_id"
    --label "io.shiborgi.barback.service=valkey"
    --label "io.shiborgi.barback.role=storage"
  )
  if [[ -n "$resolver" ]]; then
    run_args+=(--dns "$resolver" --dns-search "$search")
  fi
  container run "${run_args[@]}" "$image"
fi

for _ in {1..30}; do
  if [[ "$(container exec "$container_name" valkey-cli ping 2>/dev/null)" == "PONG" ]]; then
    printf 'Valkey is ready on Apple Container network %s\n' "$network"
    exit 0
  fi
  sleep 1
done

printf 'Valkey did not become ready. Check logs with: container logs %s\n' "$container_name" >&2
exit 1
