import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { normalizeStartupArgs } from "../startup/startup-args.js";

export type PiRpcDelivery = "prompt" | "follow_up";
export type PiRpcShutdownResult = "already-exited" | "exited" | "killed" | "force-killed" | "kill-timeout";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type PiQueueMode = "all" | "one-at-a-time";

export interface PiModel {
  readonly id?: string | undefined;
  readonly provider?: string | undefined;
  readonly api?: string | undefined;
  readonly [key: string]: unknown;
}

export type PiRpcControlCommand =
  | { readonly id?: string; readonly type: "get_state" }
  | { readonly id?: string; readonly type: "get_messages" }
  | { readonly id?: string; readonly type: "get_available_models" }
  | { readonly id?: string; readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly id?: string; readonly type: "cycle_model" }
  | { readonly id?: string; readonly type: "set_thinking_level"; readonly level: PiThinkingLevel }
  | { readonly id?: string; readonly type: "cycle_thinking_level" }
  | { readonly id?: string; readonly type: "set_steering_mode"; readonly mode: PiQueueMode }
  | { readonly id?: string; readonly type: "set_follow_up_mode"; readonly mode: PiQueueMode }
  | { readonly id?: string; readonly type: "compact"; readonly customInstructions?: string | undefined }
  | { readonly id?: string; readonly type: "set_auto_compaction"; readonly enabled: boolean }
  | { readonly id?: string; readonly type: "set_auto_retry"; readonly enabled: boolean }
  | { readonly id?: string; readonly type: "abort_retry" }
  | { readonly id?: string; readonly type: "abort" }
  | { readonly id?: string; readonly type: "new_session"; readonly parentSession?: string | undefined }
  | { readonly id?: string; readonly type: "get_session_stats" }
  | { readonly id?: string; readonly type: "bash"; readonly command: string }
  | { readonly id?: string; readonly type: "abort_bash" }
  | { readonly id?: string; readonly type: "export_html"; readonly outputPath?: string | undefined }
  | { readonly id?: string; readonly type: "switch_session"; readonly sessionPath: string }
  | { readonly id?: string; readonly type: "fork"; readonly entryId: string }
  | { readonly id?: string; readonly type: "clone" }
  | { readonly id?: string; readonly type: "get_commands" }
  | { readonly id?: string; readonly type: "set_session_name"; readonly name: string };

export interface PiRpcProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export const DEFAULT_PI_RPC_SHUTDOWN_GRACE_MS = 60_000;
export const DEFAULT_PI_RPC_POST_KILL_WAIT_MS = 10_000;

export interface PiRpcSpawnOptions {
  readonly command: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly sessionName?: string;
  readonly startupArgs?: readonly string[] | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PiRpcRequestOptions {
  readonly requestTimeoutMs?: number;
}

export interface PiRpcState {
  readonly model?: PiModel | null | undefined;
  readonly thinkingLevel: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly steeringMode: "all" | "one-at-a-time";
  readonly followUpMode: "all" | "one-at-a-time";
  readonly sessionFile?: string | undefined;
  readonly sessionId: string;
  readonly sessionName?: string | undefined;
  readonly autoCompactionEnabled: boolean;
  readonly messageCount: number;
  readonly pendingMessageCount: number;
}

type PiRpcCommand =
  | PiRpcControlCommand
  | {
      readonly id?: string;
      readonly type: "prompt";
      readonly message: string;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | {
      readonly id?: string;
      readonly type: "follow_up";
      readonly message: string;
    }
  | {
      readonly id?: string;
      readonly type: "get_last_assistant_text";
    };

interface PendingRequest {
  readonly command: string;
  readonly resolve: (value: PiRpcResponse) => void;
  readonly reject: (reason: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface PiRpcSuccessResponse {
  readonly id?: string | undefined;
  readonly type: "response";
  readonly command: string;
  readonly success: true;
  readonly data?: unknown;
}

interface PiRpcErrorResponse {
  readonly id?: string | undefined;
  readonly type: "response";
  readonly command: string;
  readonly success: false;
  readonly error: string;
}

type PiRpcResponse = PiRpcSuccessResponse | PiRpcErrorResponse;

const rpcResponseSchema = z.discriminatedUnion("success", [
  z.object({
    id: z.string().optional(),
    type: z.literal("response"),
    command: z.string(),
    success: z.literal(true),
    data: z.unknown().optional()
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("response"),
    command: z.string(),
    success: z.literal(false),
    error: z.string()
  })
]);

const rpcStateSchema = z.object({
  model: z.record(z.string(), z.unknown()).nullable().optional(),
  thinkingLevel: z.string(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  steeringMode: z.union([z.literal("all"), z.literal("one-at-a-time")]),
  followUpMode: z.union([z.literal("all"), z.literal("one-at-a-time")]),
  sessionFile: z.string().optional(),
  sessionId: z.string(),
  sessionName: z.string().optional(),
  autoCompactionEnabled: z.boolean(),
  messageCount: z.number(),
  pendingMessageCount: z.number()
});

const lastAssistantTextSchema = z.object({
  text: z.string().nullable().optional()
});

const modelSchema = z.record(z.string(), z.unknown());

const availableModelsSchema = z.object({
  models: z.array(modelSchema)
});

interface AgentEndWaiter {
  readonly promise: Promise<void>;
  cancel(): void;
}

export class PiRpcClient extends EventEmitter {
  private readonly process: PiRpcProcess;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly detachOutput: () => void;
  private readonly detachErrorOutput: () => void;
  private exited = false;
  private shutdownPromise: Promise<PiRpcShutdownResult> | undefined;

  constructor(process: PiRpcProcess, options: PiRpcRequestOptions = {}) {
    super();
    this.process = process;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.detachOutput = attachJsonlLineReader(this.process.stdout, (line) => {
      this.handleLine(line);
    });
    this.detachErrorOutput = attachTextLineReader(this.process.stderr, (line) => {
      console.error(`[pi-rpc stderr pid=${this.process.pid ?? "unknown"}] ${line}`);
    });

    this.process.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exited = true;
      this.rejectAllPending(new Error(formatProcessExit("Pi RPC process exited", code, signal)));
      this.detachOutput();
      this.detachErrorOutput();
      this.emit("exit");
    });
    this.process.once("error", (error) => {
      this.rejectAllPending(error);
      this.detachOutput();
      this.detachErrorOutput();
    });
  }

  static spawn(options: PiRpcSpawnOptions): PiRpcClient {
    const child = spawn(options.command, buildPiRpcArgs(options), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    return new PiRpcClient(child);
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  async getState(): Promise<PiRpcState> {
    const response = await this.request({ type: "get_state" });
    return rpcStateSchema.parse(response.data);
  }

  async sendControlCommand(command: PiRpcControlCommand): Promise<unknown> {
    const response = await this.request(command);
    return response.data === null ? undefined : response.data;
  }

  async getAvailableModels(): Promise<PiModel[]> {
    const response = await this.request({ type: "get_available_models" });
    return availableModelsSchema.parse(response.data).models as PiModel[];
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    const response = await this.request({ type: "set_model", provider, modelId });
    return modelSchema.parse(response.data) as PiModel;
  }

  async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
    await this.request({ type: "set_thinking_level", level });
  }

  async prompt(message: string): Promise<void> {
    await this.request({ type: "prompt", message });
  }

  async followUp(message: string): Promise<void> {
    await this.request({ type: "follow_up", message });
  }

  async getLastAssistantText(): Promise<string | null> {
    const response = await this.request({ type: "get_last_assistant_text" });
    return lastAssistantTextSchema.parse(response.data).text ?? null;
  }

  async deliverUserMessage(message: string): Promise<PiRpcDelivery> {
    const state = await this.getState();
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) {
      await this.followUp(message);
      return "follow_up";
    }

    await this.prompt(message);
    return "prompt";
  }

  async runUserMessage(message: string): Promise<string> {
    const waiter = this.createAgentEndWaiter();
    try {
      await this.deliverUserMessage(message);
      await waiter.promise;
      return (await this.getLastAssistantText()) ?? "";
    } catch (error: unknown) {
      waiter.cancel();
      throw error;
    }
  }

  close(): void {
    this.detachOutput();
    this.detachErrorOutput();
    this.rejectAllPending(new Error("Pi RPC client closed"));
    this.process.stdin.end();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.close();
    return this.process.kill(signal);
  }

  async shutdown(gracePeriodMs = DEFAULT_PI_RPC_SHUTDOWN_GRACE_MS): Promise<PiRpcShutdownResult> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.shutdownOnce(gracePeriodMs);
    return this.shutdownPromise;
  }

  onExit(listener: () => void): () => void {
    this.on("exit", listener);
    return () => {
      this.off("exit", listener);
    };
  }

  private request(command: PiRpcCommand): Promise<PiRpcSuccessResponse> {
    const id = command.id ?? randomUUID();
    const payload = { ...command, id };
    const serialized = `${JSON.stringify(payload)}\n`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC command timed out: ${command.type}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        command: command.type,
        resolve: (response) => {
          if (!response.success) {
            reject(new Error(response.error));
            return;
          }
          resolve(response);
        },
        reject,
        timeout
      });

      this.process.stdin.write(serialized, "utf8", (error) => {
        if (error === null || error === undefined) return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    const parsed = JSON.parse(line) as unknown;
    const responseResult = rpcResponseSchema.safeParse(parsed);
    if (!responseResult.success) {
      this.emitAgentEvent(parsed);
      this.emit("event", parsed);
      return;
    }

    const response = responseResult.data;
    if (response.id === undefined) {
      this.emit("event", response);
      return;
    }

    const pending = this.pending.get(response.id);
    if (pending === undefined) {
      this.emit("event", response);
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private async shutdownOnce(gracePeriodMs: number): Promise<PiRpcShutdownResult> {
    if (this.exited) {
      return "already-exited";
    }

    const exitPromise = this.waitForExit();
    this.close();

    const didExit = await waitForExitOrTimeout(exitPromise, gracePeriodMs);
    if (didExit) {
      return "exited";
    }

    this.process.kill("SIGTERM");
    if (await waitForExitOrTimeout(exitPromise, DEFAULT_PI_RPC_POST_KILL_WAIT_MS)) {
      return "killed";
    }

    this.process.kill("SIGKILL");
    if (await waitForExitOrTimeout(exitPromise, DEFAULT_PI_RPC_POST_KILL_WAIT_MS)) {
      return "force-killed";
    }

    return "kill-timeout";
  }

  private waitForExit(): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.process.once("exit", () => {
        resolve();
      });
    });
  }

  private createAgentEndWaiter(): AgentEndWaiter {
    let settled = false;
    let rejectWaiter: (error: Error) => void = () => {};
    let cleanupWaiter: () => void = () => {};

    const promise = new Promise<void>((resolve, reject) => {
      rejectWaiter = reject;

      const cleanup = () => {
        this.off("agent_end", onAgentEnd);
        this.process.off("exit", onExit);
      };
      cleanupWaiter = cleanup;

      const onAgentEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(formatProcessExit("Pi RPC process exited before agent_end", code, signal)));
      };

      this.once("agent_end", onAgentEnd);
      this.process.once("exit", onExit);
    });
    promise.catch(() => undefined);

    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        cleanupWaiter();
        rejectWaiter(new Error("Agent end wait cancelled"));
      }
    };
  }

  private emitAgentEvent(value: unknown): void {
    if (typeof value !== "object" || value === null || !("type" in value)) {
      return;
    }

    if (value.type === "agent_end") {
      this.emit("agent_end", value);
    }
  }
}

function formatProcessExit(prefix: string, code: number | null, signal: NodeJS.Signals | null): string {
  const details: string[] = [];
  if (code !== null) {
    details.push(`code=${code}`);
  }
  if (signal !== null) {
    details.push(`signal=${signal}`);
  }

  return details.length === 0 ? prefix : `${prefix} (${details.join(", ")})`;
}

async function waitForExitOrTimeout(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, timeoutMs);

    void exitPromise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export function buildPiRpcArgs(
  options: Pick<PiRpcSpawnOptions, "sessionId" | "sessionDir" | "sessionName" | "startupArgs">
): string[] {
  const args = ["--mode", "rpc", "--session-id", options.sessionId, "--session-dir", options.sessionDir];

  if (options.sessionName !== undefined && options.sessionName.trim().length > 0) {
    args.push("--name", options.sessionName);
  }

  if (options.startupArgs !== undefined) {
    args.push(...normalizeStartupArgs(options.startupArgs));
  }

  return args;
}

function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
  return attachTextLineReader(stream, onLine);
}

function attachTextLineReader(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emitLine = (line: string) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length === 0) return;
    emitLine(buffer);
    buffer = "";
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}
