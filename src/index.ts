import { createAdminApp, createApp } from "./api/app.ts";
import { ConfigStore, loadConfig } from "./config/loader.ts";
import { Runtime } from "./core/runtime.ts";
import { startTelemetry } from "./telemetry/otel.ts";

const path = process.env.GATEPATROL_CONFIG ?? "gatepatrol.yaml";
const configStore = new ConfigStore(await loadConfig(path), path);
const runtime = await Runtime.create(configStore);
const telemetry = await startTelemetry(configStore.get().telemetry);
const config = configStore.get();

const server = Bun.serve({
  hostname: config.server.host,
  port: config.server.port,
  fetch: createApp(runtime).fetch,
});
const admin = Bun.serve({
  hostname: config.server.admin.host,
  port: config.server.admin.port,
  fetch: createAdminApp(runtime).fetch,
});

runtime.logger.info("server.started", {
  public: server.url.toString(),
  admin: admin.url.toString(),
  environment: config.environment,
});

process.on("SIGHUP", () => {
  void runtime.reload().then(
    () => runtime.logger.info("config.reloaded"),
    (error) => runtime.logger.error("config.reload_failed", { error: String(error) }),
  );
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.logger.info("server.stopping", { signal });
  await Promise.all([server.stop(false), admin.stop(false)]);
  await runtime.close();
  await telemetry?.shutdown();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
