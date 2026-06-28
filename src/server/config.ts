import path from "node:path";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().min(1).default("./data"),
  PI_COMMAND: z.string().min(1).default("pi"),
  MAX_PROCESSES: z.coerce.number().int().min(1).default(50),
  IDLE_TIMEOUT_MS: z.coerce.number().int().min(1).default(30 * 60 * 1000),
  WECOM_BOT_ID: z.string().default(""),
  WECOM_BOT_SECRET: z.string().default(""),
  WECOM_BOT_WS_URL: z.string().default("")
});

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly piCommand: string;
  readonly maxProcesses: number;
  readonly idleTimeoutMs: number;
  readonly wecomBotId: string;
  readonly wecomBotSecret: string;
  readonly wecomBotWsUrl: string;
}

export function loadEnvironmentFile(envFile = ".env", processEnv: NodeJS.ProcessEnv = process.env): void {
  loadDotenv({
    path: envFile,
    processEnv,
    override: false,
    quiet: true
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(env);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir: path.resolve(parsed.DATA_DIR),
    piCommand: parsed.PI_COMMAND,
    maxProcesses: parsed.MAX_PROCESSES,
    idleTimeoutMs: parsed.IDLE_TIMEOUT_MS,
    wecomBotId: parsed.WECOM_BOT_ID,
    wecomBotSecret: parsed.WECOM_BOT_SECRET,
    wecomBotWsUrl: parsed.WECOM_BOT_WS_URL
  };
}

export function validateStartupConfig(config: AppConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (config.wecomBotId.length === 0 || config.wecomBotSecret.length === 0) {
    throw new Error("WECOM_BOT_ID and WECOM_BOT_SECRET are required");
  }

  const piCommandPath = resolveCommand(config.piCommand, env);
  if (piCommandPath === undefined) {
    throw new Error(`PI_COMMAND does not exist or is not executable: ${config.piCommand}`);
  }

  mkdirSync(config.dataDir, { recursive: true });
  accessSync(config.dataDir, constants.W_OK);
}

function resolveCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : undefined;
  }

  const pathEnv = env.PATH ?? env.Path ?? "";
  const searchDirs = pathEnv.split(path.delimiter).filter((item) => item.length > 0);
  const extensions =
    process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const commandCandidates =
    process.platform === "win32" && path.extname(command).length === 0
      ? extensions.map((extension) => `${command}${extension.toLowerCase()}`)
      : [command];

  for (const dir of searchDirs) {
    for (const candidate of commandCandidates) {
      const fullPath = path.join(dir, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return undefined;
}
