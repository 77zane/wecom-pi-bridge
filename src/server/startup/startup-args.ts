import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WECOM_FILE_PROTOCOL_INSTRUCTION } from "../wecom/outbound-file-protocol.js";

export type StartupArgsSource = "none" | "global" | "workspace";

export interface ResolvedStartupArgs {
  readonly source: StartupArgsSource;
  readonly args: string[];
  readonly globalArgs: string[];
  readonly workspaceArgs: string[] | null;
}

const BLOCKED_LONG_FLAGS = new Set([
  "--mode",
  "--session-id",
  "--session-dir",
  "--session",
  "--continue",
  "--resume",
  "--fork",
  "--no-session",
  "--name",
  "--print",
  "--export",
  "--list-models",
  "--help",
  "--version"
]);

const BLOCKED_SHORT_FLAGS = new Set(["-c", "-r", "-n", "-p", "-h", "-v"]);

export function normalizeStartupArgs(args: readonly unknown[]): string[] {
  const normalized = args.map((arg) => {
    if (typeof arg !== "string") {
      throw new Error("Startup args must be a JSON array of strings");
    }

    return arg;
  });

  for (const arg of normalized) {
    if (arg.length === 0) {
      throw new Error("Startup args cannot contain empty strings");
    }

    const flagName = arg.startsWith("--") ? (arg.split("=", 1)[0] ?? arg) : arg;
    if (BLOCKED_LONG_FLAGS.has(flagName) || BLOCKED_SHORT_FLAGS.has(flagName)) {
      throw new Error(`Startup arg is controlled by bridge and cannot be configured: ${flagName}`);
    }
  }

  return normalized;
}

export function parseStoredStartupArgs(value: string | null | undefined): string[] {
  if (value === null || value === undefined || value.length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Stored startup args must be a JSON array");
  }

  return normalizeStartupArgs(parsed);
}

export function serializeStartupArgs(args: readonly string[]): string {
  return JSON.stringify(normalizeStartupArgs(args));
}

export function ensureBridgeStartupPromptFile(dataDir: string): string {
  const promptDir = path.join(dataDir, "startup-prompts");
  mkdirSync(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, "wecom-file-protocol.md");
  writeFileSync(promptPath, `${WECOM_FILE_PROTOCOL_INSTRUCTION}\n`, "utf8");
  return promptPath;
}
