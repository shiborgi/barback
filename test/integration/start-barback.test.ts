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

const valkeyInspect = '[{"status":{"networks":[{"ipv4Address":"192.168.64.10/24"}]}}]';

function gatewayInspect(resolver = "192.168.65.2", healthIp = "127.0.0.1") {
  return `[{"status":{"networks":[{"ipv4Address":"${healthIp}/24"}]},"configuration":{"dns":{"nameservers":["${resolver}"]}}}]`;
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
      BARBACK_DNS_RESOLVER: "192.168.65.2",
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

describe("start-barback.sh DNS addressing", () => {
  test("injects canonical dependency URLs and the Barback resolver", async () => {
    const { exitCode, log, stdout } = await runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "inspect-barback-gateway.json": gatewayInspect(),
      "list.json": '[{"id":"barback-valkey"}]',
    });
    expect(exitCode).toBe(0);
    expect(log).toContain("--dns 192.168.65.2");
    expect(log).toContain("--dns-search barback.internal");
    expect(log).toContain("--env VALKEY_URL=redis://valkey.barback.internal:6379");
    expect(log).toContain("--env GOOGLE_MCP_URL=http://google.mcp.barback.internal:8090/mcp");
    expect(log).not.toContain("google-mcp-ip");
    expect(stdout).not.toContain("192.168.64.12");
  });

  test("does not discover google-mcp before starting the gateway", async () => {
    const { exitCode, log } = await runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "inspect-barback-gateway.json": gatewayInspect(),
      "list.json": '[{"id":"barback-valkey"}]',
    });
    expect(exitCode).toBe(0);
    expect(log).not.toContain("inspect google-mcp");
  });

  test("recreates the gateway when its bootstrap resolver differs", async () => {
    const { exitCode, log, stdout } = await runScript({
      "inspect-barback-valkey.json": valkeyInspect,
      "inspect-barback-gateway.json": gatewayInspect("192.168.64.11"),
      "list.json": '[{"id":"barback-valkey"},{"id":"barback-gateway"}]',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recreating gateway container after the DNS resolver changed.");
    expect(log).toContain("stop barback-gateway");
    expect(log).toContain("delete barback-gateway");
    expect(log).toContain("--dns 192.168.65.2");
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
