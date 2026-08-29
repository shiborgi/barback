#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
app_name="${BARBACK_APP_CONTAINER:-barback-gateway}"
valkey_name="${BARBACK_VALKEY_CONTAINER:-barback-valkey}"
google_mcp_name="${BARBACK_GOOGLE_MCP_CONTAINER:-google-mcp}"

if ! command -v container >/dev/null 2>&1; then
  printf 'Apple Container CLI not found. Install it and try again.\n' >&2
  exit 1
fi

started=0
failed=0

supervise() {
  local name="$1"
  local optional="$2"
  if ! container inspect "$name" >/dev/null 2>&1; then
    if [[ "$optional" == "true" ]]; then
      printf 'Skipping absent optional container: %s\n' "$name"
      return 0
    fi
    printf 'Container not found: %s\n' "$name" >&2
    failed=1
    return 1
  fi
  if container list --format json | grep -Fq "\"id\":\"$name\""; then
    printf 'Container already running: %s\n' "$name"
    return 0
  fi
  printf 'Starting stopped container: %s\n' "$name"
  if container start "$name"; then
    started=1
  else
    printf 'Failed to start container: %s\n' "$name" >&2
    failed=1
  fi
}

supervise "$valkey_name" "false"
supervise "$app_name" "false"
supervise "$google_mcp_name" "true"

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

if [[ "$started" -ne 0 ]]; then
  printf 'Refreshing gateway addresses after restart.\n'
  start_barback_script="$(command -v start-barback.sh || true)"
  if [[ -z "$start_barback_script" ]]; then
    start_barback_script="$root_dir/scripts/start-barback.sh"
  fi
  if ! "$start_barback_script"; then
    printf 'Failed to refresh gateway addresses.\n' >&2
    exit 1
  fi
fi

exit 0
