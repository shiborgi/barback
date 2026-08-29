import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = new URL("../../scripts/keepalive.sh", import.meta.url).pathname;

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
cmd="$1"; shift
case "$cmd" in
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
  start)
    name="$1"
    if [[ -f "$STUB_FIXTURES/fail-start-$name" ]]; then
      exit 1
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

const dirs: string[] = [];

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  log: string;
  startBarbackCalls: number;
}

async function runScript(
  fixtures: Record<string, string>,
  opts: { startBarbackExit?: number } = {},
): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "barback-keepalive-"));
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
  const startBarbackLog = join(dir, "start-barback.log");
  writeFileSync(startBarbackLog, "");
  const startBarback = join(bin, "start-barback.sh");
  writeFileSync(
    startBarback,
    `#!/usr/bin/env bash
printf '%s\\n' "start-barback" >> "$START_BARBACK_LOG"
exit ${opts.startBarbackExit ?? 0}
`,
  );
  chmodSync(startBarback, 0o755);

  const proc = Bun.spawn(["bash", scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_FIXTURES: fixturesDir,
      START_BARBACK_LOG: startBarbackLog,
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const startBarbackCalls = readFileSync(startBarbackLog, "utf8")
    .split("\n")
    .filter((line) => line === "start-barback").length;
  return { exitCode, stdout, stderr, log: readFileSync(log, "utf8"), startBarbackCalls };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const runningInspect = '[{"status":{"state":"running"}}]';
const stoppedInspect = '[{"status":{"state":"stopped"}}]';

describe("keepalive.sh supervision pass", () => {
  test("starts stopped containers and leaves running containers untouched", async () => {
    const { exitCode, log } = await runScript({
      "inspect-barback-valkey.json": stoppedInspect,
      "inspect-barback-gateway.json": runningInspect,
      "inspect-google-mcp.json": stoppedInspect,
      "list.json": '[{"id":"barback-gateway"}]',
    });
    expect(exitCode).toBe(0);
    expect(log).toContain("start barback-valkey");
    expect(log).toContain("start google-mcp");
    expect(log).not.toContain("start barback-gateway");
  });

  test("invokes start-barback.sh after a restart and is idempotent when all run", async () => {
    const restarted = await runScript({
      "inspect-barback-valkey.json": stoppedInspect,
      "inspect-barback-gateway.json": runningInspect,
      "inspect-google-mcp.json": runningInspect,
      "list.json": '[{"id":"barback-gateway"}]',
    });
    expect(restarted.exitCode).toBe(0);
    expect(restarted.startBarbackCalls).toBe(1);

    const allRunning = await runScript({
      "inspect-barback-valkey.json": runningInspect,
      "inspect-barback-gateway.json": runningInspect,
      "inspect-google-mcp.json": runningInspect,
      "list.json": '[{"id":"barback-valkey"},{"id":"barback-gateway"},{"id":"google-mcp"}]',
    });
    expect(allRunning.exitCode).toBe(0);
    expect(allRunning.startBarbackCalls).toBe(0);
    expect(allRunning.log).not.toContain("start ");
  });

  test("skips an absent optional google-mcp and exits non-zero on a failed start", async () => {
    const absent = await runScript({
      "inspect-barback-valkey.json": runningInspect,
      "inspect-barback-gateway.json": runningInspect,
      "list.json": '[{"id":"barback-valkey"},{"id":"barback-gateway"}]',
    });
    expect(absent.exitCode).toBe(0);
    expect(absent.log).not.toContain("start google-mcp");

    const failed = await runScript({
      "inspect-barback-valkey.json": stoppedInspect,
      "inspect-barback-gateway.json": runningInspect,
      "inspect-google-mcp.json": runningInspect,
      "list.json": '[{"id":"barback-gateway"}]',
      "fail-start-barback-valkey": "",
    });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.startBarbackCalls).toBe(0);
  });
});
