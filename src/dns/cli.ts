import { loadConfig } from "../config/loader.ts";
import { StackReconciler } from "./reconciler.ts";
import { loadStack, validateStackAgainstBarback } from "./stack-loader.ts";
import { publishClientConfig } from "./state.ts";

const commands = new Set(["up", "reconcile", "status", "client-config", "down"]);

export async function runReconcilerCli(args = process.argv.slice(2)): Promise<void> {
  const [command] = args;
  if (!command || !commands.has(command) || args.length !== 1) {
    throw new Error("Usage: barback-reconcile <up|reconcile|status|client-config|down>");
  }
  const [stack, config] = await Promise.all([loadStack(), loadConfig()]);
  validateStackAgainstBarback(stack, config);
  const reconciler = new StackReconciler(stack, config);
  if (command === "up") await reconciler.up();
  if (command === "reconcile") await reconciler.reconcile();
  if (command === "down") await reconciler.down();
  if (command === "status") process.stdout.write(`${JSON.stringify(await reconciler.status())}\n`);
  if (command === "client-config") {
    const clientConfig = await reconciler.clientConfig();
    await publishClientConfig(reconciler.state.root, clientConfig);
    process.stdout.write(`${JSON.stringify(clientConfig)}\n`);
  }
}

if (import.meta.main) {
  runReconcilerCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
