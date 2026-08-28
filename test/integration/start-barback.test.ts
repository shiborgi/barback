import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = new URL("../../scripts/start-barback.sh", import.meta.url).pathname;

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
cmd="$1"; shift
case "$cmd" in
  system|build|run|stop|delete|start)
    exit 0
    ;;
  network)
    exit 0
    ;;
  inspect)
    name="$1"
    fixture="$STUB_FIXTURES/inspect-$name.json"
    if [[ -f "$fixture" ]]; then
      cat "$fixture"
      exit 0
    fi
    exit 1
    ;;
  list)
    cat "$STUB_FIXTURES/list.json"
    ;;
  exec)
    echo "PONG"
    ;;
  *)
    exit 0
    ;;
esac
`;

const valkeyInspect =
  '[{"status":{"networks":[{"ipv4Address":"192.168.64.10/24"}]},"configuration":{"labels":{}}}]';

function googleInspect(ip: string) {
  return `[{"status":{"networks":[{"ipv4Address":"${ip}/24"}]},"configuration":{"labels":{}}}]`;
}

function gatewayInspect(labelIp: string) {
  return `[{"status":{"networks":[{"ipv4Address":"${labelIp}/24"}]},"configuration":{"labels":{"google-mcp-ip":"${labelIp}"}}}]`;
}

const dirs: string[] = [];

function runScript(fixtures: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "barback-start-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = join(bin, "container");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const fixturesDir = join(dir, "fixtures");
  mkdirSync(fixturesDir);
  for (const [name, content] of Object.entries(fixtures)) {
    writeFileSync(join(fixturesDir, name), content);
  }
  const log = join(dir, "stub.log");
  const configFile = join(dir, "barback.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(configFile, "mcp: {}\n");
  writeFileSync(envFile, "BARBACK_CLIENT_KEY=test\n");

  const proc = Bun.spawnSync(["bash", scriptPath], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_FIXTURES: fixturesDir,
      BARBACK_CONFIG_FILE: configFile,
      BARBACK_ENV_FILE: envFile,
    },
  });
  return { proc, log: readFileSync(log, "utf8") };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("start-barback.sh google-mcp addressing", () => {
  test("injects GOOGLE_MCP_URL with the resolved IP when the google-mcp container exists", () => {
    const { proc, log } = runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "inspect-google-mcp.json": googleInspect("192.168.64.12"),
      "list.json": '[{"id":"barback-valkey"}]',
    });
    expect(proc.exitCode).toBe(0);
    expect(log).toContain("--env GOOGLE_MCP_URL=http://192.168.64.12:8090/mcp");
    expect(log).toContain("--label google-mcp-ip=192.168.64.12");
    expect(proc.stdout.toString()).toContain(
      "Resolved google-mcp upstream: http://192.168.64.12:8090/mcp",
    );
  });

  test("skips injection and prints a notice when the google-mcp container is absent", () => {
    const { proc, log } = runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "list.json": '[{"id":"barback-valkey"}]',
    });
    expect(proc.exitCode).toBe(0);
    expect(log).not.toContain("GOOGLE_MCP_URL");
    expect(proc.stdout.toString()).toContain(
      "google-mcp container not found; skipping upstream injection",
    );
  });

  test("recreates the gateway when the recorded google-mcp IP differs", () => {
    const { proc, log } = runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "inspect-google-mcp.json": googleInspect("192.168.64.12"),
      "inspect-barback-gateway.json": gatewayInspect("192.168.64.11"),
      "list.json": '[{"id":"barback-valkey"},{"id":"barback-gateway"}]',
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain(
      "Recreating gateway container after the google-mcp address changed.",
    );
    expect(log).toContain("stop barback-gateway");
    expect(log).toContain("delete barback-gateway");
    expect(log).toContain("--env GOOGLE_MCP_URL=http://192.168.64.12:8090/mcp");
  });
});
