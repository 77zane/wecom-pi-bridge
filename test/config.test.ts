import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { loadConfig, loadEnvironmentFile, validateStartupConfig } from "../src/server/config.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-pi-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("loadConfig", () => {
  it("loads default development settings", () => {
    const config = loadConfig({});

    expect(config.nodeEnv).toBe("development");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.piCommand).toBe("pi");
  });

  it("normalizes data directory to an absolute path", () => {
    const config = loadConfig({
      DATA_DIR: "./relative-data"
    });

    expect(config.dataDir).toMatch(/relative-data$/);
    expect(config.dataDir).not.toBe("./relative-data");
  });

  it("loads settings from an env file into the provided environment object", async () => {
    const dir = await createTempDir();
    const envFile = path.join(dir, ".env");
    await writeFile(envFile, "PORT=4567\nDATA_DIR=./from-env\nPI_COMMAND=custom-pi\n", "utf8");
    const env: NodeJS.ProcessEnv = {};

    loadEnvironmentFile(envFile, env);
    const config = loadConfig(env);

    expect(config.port).toBe(4567);
    expect(config.dataDir).toMatch(/from-env$/);
    expect(config.piCommand).toBe("custom-pi");
  });

  it("validates required runtime config before starting the service", async () => {
    const dir = await createTempDir();
    const piCommand = path.join(dir, "pi.cmd");
    await writeFile(piCommand, "@echo off\n", "utf8");
    const config = loadConfig({
      DATA_DIR: path.join(dir, "data"),
      PI_COMMAND: piCommand,
      WECOM_BOT_ID: "bot-a",
      WECOM_BOT_SECRET: "secret"
    });

    expect(() => validateStartupConfig(config)).not.toThrow();
  });

  it("rejects startup config with missing bot credentials or Pi command", async () => {
    const dir = await createTempDir();
    const missingCommandConfig = loadConfig({
      DATA_DIR: path.join(dir, "data"),
      PI_COMMAND: path.join(dir, "missing-pi.cmd"),
      WECOM_BOT_ID: "bot-a",
      WECOM_BOT_SECRET: "secret"
    });

    expect(() => validateStartupConfig(missingCommandConfig)).toThrow("PI_COMMAND does not exist");

    const piCommand = path.join(dir, "pi.cmd");
    await writeFile(piCommand, "@echo off\n", "utf8");
    const missingBotConfig = loadConfig({
      DATA_DIR: path.join(dir, "data"),
      PI_COMMAND: piCommand
    });

    expect(() => validateStartupConfig(missingBotConfig)).toThrow("WECOM_BOT_ID and WECOM_BOT_SECRET are required");
  });
});
