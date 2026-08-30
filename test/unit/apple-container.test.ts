import { describe, expect, test } from "bun:test";
import { AppleContainerCli, AppleContainerCommandError } from "../../src/dns/apple-container.ts";

describe("AppleContainerCli", () => {
  test("creates only a missing network and rejects a wrong existing mode", async () => {
    const calls: string[][] = [];
    const missing = new AppleContainerCli(async (args) => {
      calls.push(args);
      if (args[0] === "network" && args[1] === "inspect")
        throw new AppleContainerCommandError(args, "network barback not found");
      return "";
    });
    await missing.ensureNetwork("barback", "nat");
    expect(calls).toEqual([
      ["network", "inspect", "barback"],
      ["network", "create", "barback"],
    ]);

    const wrongMode = new AppleContainerCli(async () => '[{"configuration":{"mode":"bridged"}}]');
    await expect(wrongMode.ensureNetwork("barback", "nat")).rejects.toThrow(/must use nat/);
  });

  test("stops a running container before deleting it", async () => {
    const calls: string[][] = [];
    const cli = new AppleContainerCli(async (args) => {
      calls.push(args);
      if (args[0] === "inspect")
        return '[{"id":"abc","status":{"state":"running"},"configuration":{}}]';
      return "";
    });
    await cli.remove("barback-gateway");
    expect(calls).toEqual([
      ["inspect", "barback-gateway"],
      ["stop", "barback-gateway"],
      ["delete", "barback-gateway"],
    ]);
  });

  test("parses the Apple Container network hostAddress and passes env files", async () => {
    const calls: string[][] = [];
    const cli = new AppleContainerCli(async (args) => {
      calls.push(args);
      if (args[0] === "inspect")
        return '[{"status":{"state":"running","networks":[{"ipv4Address":"192.0.2.2/24","hostAddress":"192.0.2.1"}]},"configuration":{"networks":[{"network":"barback"}]}}]';
      return "";
    });
    expect((await cli.inspect("resolver"))?.hostAddress).toBe("192.0.2.1");
    await cli.run({
      name: "test",
      image: "image",
      network: "barback",
      labels: {},
      envFile: ".env",
    });
    expect(calls.at(-1)).toContain("--env-file");
  });
});
