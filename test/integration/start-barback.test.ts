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

const SLEEP_STUB = `#!/usr/bin/env bash
exit 0
`;

const valkeyInspect =
  '[{"status":{"networks":[{"ipv4Address":"192.168.64.10/24"}]},"configuration":{"labels":{}}}]';

function googleInspect(ip: string) {
  return `[{"status":{"networks":[{"ipv4Address":"${ip}/24"}]},"configuration":{"labels":{}}}]`;
}

function gatewayInspect(labelIp: string, healthIp = "127.0.0.1") {
  return `[{"status":{"networks":[{"ipv4Address":"${healthIp}/24"}]},"configuration":{"labels":{"google-mcp-ip":"${labelIp}"}}}]`;
}

const dirs: string[] = [];

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  log: string;
  requests: string[];
}

async function runScript(
  fixtures: Record<string, string>,
  opts: { healthStatus?: number } = {},
): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "barback-start-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = join(bin, "container");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const sleepStub = join(bin, "sleep");
  writeFileSync(sleepStub, SLEEP_STUB);
  chmodSync(sleepStub, 0o755);
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

  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push(req.url);
      return new Response("ok", { status: opts.healthStatus ?? 200 });
    },
  });

  const proc = Bun.spawn(["bash", scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_FIXTURES: fixturesDir,
      BARBACK_CONFIG_FILE: configFile,
      BARBACK_ENV_FILE: envFile,
      BARBACK_HEALTH_PORT: String(server.port),
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  server.stop(true);
  return { exitCode, stdout, stderr, log: readFileSync(log, "utf8"), requests };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("start-barback.sh google-mcp addressing", () => {
  test("injects GOOGLE_MCP_URL with the resolved IP when the google-mcp container exists", async () => {
    const { exitCode, log, stdout } = await runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "inspect-google-mcp.json": googleInspect("192.168.64.12"),
      "inspect-barback-gateway.json": gatewayInspect("192.168.64.12"),
      "list.json": '[{"id":"barback-valkey"}]',
    });
    expect(exitCode).toBe(0);
    expect(log).toContain("--env GOOGLE_MCP_URL=http://192.168.64.12:8090/mcp");
    expect(log).toContain("--label google-mcp-ip=192.168.64.12");
    expect(stdout).toContain("Resolved google-mcp upstream: http://192.168.64.12:8090/mcp");
  });

  test("skips injection and prints a notice when the google-mcp container is absent", async () => {
    const { exitCode, log, stdout } = await runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "inspect-barback-gateway.json": gatewayInspect(""),
      "list.json": '[{"id":"barback-valkey"}]',
    });
    expect(exitCode).toBe(0);
    expect(log).not.toContain("GOOGLE_MCP_URL");
    expect(stdout).toContain("google-mcp container not found; skipping upstream injection");
  });

  test("recreates the gateway when the recorded google-mcp IP differs", async () => {
    const { exitCode, log, stdout } = await runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "inspect-google-mcp.json": googleInspect("192.168.64.12"),
      "inspect-barback-gateway.json": gatewayInspect("192.168.64.11"),
      "list.json": '[{"id":"barback-valkey"},{"id":"barback-gateway"}]',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recreating gateway container after the google-mcp address changed.");
    expect(log).toContain("stop barback-gateway");
    expect(log).toContain("delete barback-gateway");
    expect(log).toContain("--env GOOGLE_MCP_URL=http://192.168.64.12:8090/mcp");
  });
});

describe("start-barback.sh gateway HTTP health gate", () => {
  test("polls the gateway container IP and succeeds when /health answers 200", async () => {
    const { exitCode, requests } = await runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "inspect-barback-gateway.json": gatewayInspect(""),
      "list.json": '[{"id":"barback-valkey"}]',
    });
    expect(exitCode).toBe(0);
    expect(
      requests.some((url) => url.startsWith("http://127.0.0.1:") && url.endsWith("/health")),
    ).toBe(true);
  });

  test("exits non-zero with a logs hint when /health never answers within the bound", async () => {
    const { exitCode, stderr } = await runScript(
      {
        "inspect-barback-valkey.json": valkeyInspect,
        "inspect-barback-gateway.json": gatewayInspect(""),
        "list.json": '[{"id":"barback-valkey"}]',
      },
      { healthStatus: 500 },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("container logs barback-gateway");
  });
});
