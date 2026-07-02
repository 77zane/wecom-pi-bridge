import { rm } from "node:fs/promises";
import {
  BindingStore,
  decodeChatKey,
  encodeChatKey,
  type BindingIdentity,
  type RuntimePolicy,
  type StoredChatBinding
} from "../bindings/binding-store.js";
import type { PiRpcControlCommand, PiRpcState } from "../pi/pi-rpc-client.js";
import type { ChatMessageQueue } from "../runtime/chat-message-queue.js";
import {
  getBindingKey,
  RuntimeManager,
  type RuntimeControlResult,
  type RuntimeEntryView
} from "../runtime/runtime-manager.js";
import {
  listSessionSummaries,
  type SessionSummaryView
} from "../sessions/session-reader.js";

export interface AdminSessionRuntimeView {
  readonly status: "running" | "stopped";
  readonly activity: "idle" | "streaming" | "compacting" | "pending" | "unknown" | "stopped";
  readonly pid: number | null;
  readonly activeOperations: number;
  readonly lastUsedAt: string | null;
  readonly state: PiRpcState | null;
  readonly stateError: string | null;
}

export interface AdminSessionView {
  readonly sessionKey: string;
  readonly binding: StoredChatBinding;
  readonly runtime: AdminSessionRuntimeView;
  readonly sessions: SessionSummaryView[];
}

export interface SessionResetResult {
  readonly sessionKey: string;
  readonly stoppedRuntime: boolean;
  readonly deletedBinding: boolean;
  readonly deletedWorkspace: boolean;
  readonly workspacePath: string;
}

export interface SessionStopResult {
  readonly sessionKey: string;
  readonly stoppedRuntime: boolean;
  readonly protectedRuntime: boolean;
}

export interface SessionProtectionResult {
  readonly sessionKey: string;
  readonly protectedRuntime: boolean;
  readonly startedRuntime: boolean;
  readonly pid?: number | undefined;
}

export interface BroadcastControlResult {
  readonly sessionKey: string;
  readonly status: "ok" | "skipped" | "error";
  readonly result?: unknown;
  readonly startedRuntime?: boolean | undefined;
  readonly stoppedRuntime?: boolean | undefined;
  readonly error?: string | undefined;
}

export interface TerminateSessionResult {
  readonly sessionKey: string;
  readonly status: "ok" | "error";
  readonly stoppedRuntime: boolean;
  readonly deletedBinding?: boolean | undefined;
  readonly deletedWorkspace?: boolean | undefined;
  readonly workspacePath?: string | undefined;
  readonly error?: string | undefined;
}

export class AdminSessionService {
  constructor(
    private readonly bindingStore: BindingStore,
    private readonly runtime: RuntimeManager | undefined,
    private readonly queue: ChatMessageQueue | undefined
  ) {}

  async listSessions(): Promise<AdminSessionView[]> {
    const runtimeEntries = await this.getRuntimeEntriesByKey();
    const bindings = this.bindingStore.listAll();

    return Promise.all(
      bindings.map(async (binding) => ({
        sessionKey: encodeChatKey(binding),
        binding,
        runtime: toRuntimeView(runtimeEntries.get(getBindingKey(binding))),
        sessions: await listSessionSummaries(binding.sessionDir)
      }))
    );
  }

  getRuntimePolicy(): RuntimePolicy {
    return this.bindingStore.getRuntimePolicy();
  }

  setRuntimePolicy(policy: RuntimePolicy): RuntimePolicy {
    return this.bindingStore.setRuntimePolicy(policy);
  }

  async sendControlCommand(sessionKey: string, command: PiRpcControlCommand): Promise<RuntimeControlResult> {
    if (this.runtime === undefined) {
      throw new Error("Runtime manager is not available");
    }

    const binding = this.getBindingBySessionKey(sessionKey);
    if (binding === undefined) {
      throw new Error("Session not found");
    }

    return this.runtime.runControlCommand(binding, command, {
      startIfMissing: true,
      stopIfStarted: true
    });
  }

  async broadcastControlCommand(
    command: PiRpcControlCommand,
    scope: "running" | "all" = "running"
  ): Promise<BroadcastControlResult[]> {
    if (this.runtime === undefined) {
      return [];
    }

    if (scope === "all") {
      const results: BroadcastControlResult[] = [];
      for (const binding of this.bindingStore.listAll()) {
        results.push(await this.runControlForBinding(binding, command, true));
      }

      return results;
    }

    const entries = await this.runtime.listEntries();
    return Promise.all(
      entries.map(async (entry) => this.runControlForBinding(entry.binding, command, false))
    );
  }

  async stopSession(sessionKey: string): Promise<SessionStopResult | undefined> {
    const identity = this.decodeSessionKey(sessionKey);
    if (identity === undefined) {
      return undefined;
    }

    const binding = this.bindingStore.getByIdentity(identity);
    if (binding === undefined) {
      return undefined;
    }

    const unprotectedBinding = this.bindingStore.setRuntimeProtection(identity, false) ?? binding;
    const stopped = await this.runtime?.shutdownBinding(binding, "admin_stop");
    return {
      sessionKey,
      stoppedRuntime: stopped?.stopped ?? false,
      protectedRuntime: unprotectedBinding.protectedRuntime
    };
  }

  async setSessionProtection(
    sessionKey: string,
    protectedRuntime: boolean
  ): Promise<SessionProtectionResult | undefined> {
    const identity = this.decodeSessionKey(sessionKey);
    if (identity === undefined) {
      return undefined;
    }

    const binding = this.bindingStore.setRuntimeProtection(identity, protectedRuntime);
    if (binding === undefined) {
      return undefined;
    }

    const ensured = protectedRuntime
      ? await this.runtime?.ensureBinding(binding)
      : undefined;

    return {
      sessionKey,
      protectedRuntime: binding.protectedRuntime,
      startedRuntime: ensured?.startedRuntime ?? false,
      pid: ensured?.pid
    };
  }

  async terminateAllSessions(): Promise<TerminateSessionResult[]> {
    const results: TerminateSessionResult[] = [];

    for (const binding of this.bindingStore.listAll()) {
      const sessionKey = encodeChatKey(binding);
      try {
        const terminated = await this.resetSession(sessionKey);
        results.push({
          sessionKey,
          status: "ok",
          stoppedRuntime: terminated?.stoppedRuntime ?? false,
          deletedBinding: terminated?.deletedBinding ?? false,
          deletedWorkspace: terminated?.deletedWorkspace ?? false,
          workspacePath: terminated?.workspacePath
        });
      } catch (error: unknown) {
        results.push({
          sessionKey,
          status: "error",
          stoppedRuntime: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return results;
  }

  async terminateSession(sessionKey: string): Promise<SessionResetResult | undefined> {
    return this.resetSession(sessionKey);
  }

  async resetSession(sessionKey: string): Promise<SessionResetResult | undefined> {
    const identity = decodeChatKey(sessionKey);
    const binding = this.bindingStore.getByIdentity(identity);
    if (binding === undefined) {
      return undefined;
    }

    const shutdownPromise =
      this.runtime?.shutdownBinding(binding, "admin_reset") ?? Promise.resolve({ stopped: false });
    const resetTask = async (): Promise<SessionResetResult> => {
      const stopped = await shutdownPromise;
      const deletedBinding = this.bindingStore.delete(identity) !== undefined;
      await rm(binding.workspacePath, { recursive: true, force: true });

      return {
        sessionKey,
        stoppedRuntime: stopped.stopped,
        deletedBinding,
        deletedWorkspace: true,
        workspacePath: binding.workspacePath
      };
    };

    return this.queue === undefined ? resetTask() : this.queue.run(binding, resetTask);
  }

  private getBindingBySessionKey(sessionKey: string): StoredChatBinding | undefined {
    const identity = this.decodeSessionKey(sessionKey);
    if (identity === undefined) {
      return undefined;
    }

    return this.bindingStore.getByIdentity(identity);
  }

  private decodeSessionKey(sessionKey: string): BindingIdentity | undefined {
    try {
      return decodeChatKey(sessionKey);
    } catch {
      return undefined;
    }
  }

  private async runControlForBinding(
    binding: StoredChatBinding,
    command: PiRpcControlCommand,
    startIfMissing: boolean
  ): Promise<BroadcastControlResult> {
    const sessionKey = encodeChatKey(binding);

    try {
      const control = await this.runtime?.runControlCommand(binding, command, {
        startIfMissing,
        stopIfStarted: startIfMissing
      });
      return {
        sessionKey,
        status: "ok",
        result: control?.result,
        startedRuntime: control?.startedRuntime,
        stoppedRuntime: control?.stoppedRuntime
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!startIfMissing && message.startsWith("No live Pi process")) {
        return {
          sessionKey,
          status: "skipped",
          error: message
        };
      }

      return {
        sessionKey,
        status: "error",
        error: message
      };
    }
  }

  private async getRuntimeEntriesByKey(): Promise<Map<string, RuntimeEntryView>> {
    if (this.runtime === undefined) {
      return new Map();
    }

    const entries = await this.runtime.listEntries();
    return new Map(entries.map((entry) => [getBindingKey(entry.binding), entry]));
  }
}

function toRuntimeView(entry: RuntimeEntryView | undefined): AdminSessionRuntimeView {
  if (entry === undefined) {
    return {
      status: "stopped",
      activity: "stopped",
      pid: null,
      activeOperations: 0,
      lastUsedAt: null,
      state: null,
      stateError: null
    };
  }

  return {
    status: "running",
    activity: getRuntimeActivity(entry.state),
    pid: entry.pid ?? null,
    activeOperations: entry.activeOperations,
    lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
    state: entry.state ?? null,
    stateError: entry.stateError ?? null
  };
}

function getRuntimeActivity(state: PiRpcState | undefined): AdminSessionRuntimeView["activity"] {
  if (state === undefined) {
    return "unknown";
  }
  if (state.isStreaming) {
    return "streaming";
  }
  if (state.isCompacting) {
    return "compacting";
  }
  if (state.pendingMessageCount > 0) {
    return "pending";
  }

  return "idle";
}
