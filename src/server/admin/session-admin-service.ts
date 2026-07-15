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
import type { ResolvedStartupArgs } from "../startup/startup-args.js";

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
  readonly startup: ResolvedStartupArgs;
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

export interface SessionRestartResult {
  readonly sessionKey: string;
  readonly stoppedRuntime: boolean;
  readonly protectedRuntime: boolean;
  readonly startedRuntime: boolean;
  readonly pid?: number | undefined;
}

export interface SessionRebindResult {
  readonly sessionKey: string;
  readonly previousSessionId: string;
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly startedRuntime: boolean;
  readonly stoppedRuntime: boolean;
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

export interface StartupArgsUpdateResult {
  readonly args: string[];
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
        startup: this.bindingStore.getResolvedStartupArgs(binding) ?? {
          source: "none",
          args: [],
          globalArgs: [],
          workspaceArgs: null
        },
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

  getGlobalStartupArgs(): StartupArgsUpdateResult {
    return {
      args: this.bindingStore.getGlobalStartupArgs()
    };
  }

  setGlobalStartupArgs(args: readonly string[]): StartupArgsUpdateResult {
    return {
      args: this.bindingStore.setGlobalStartupArgs(args)
    };
  }

  setWorkspaceStartupArgs(sessionKey: string, args: readonly string[]): StoredChatBinding | undefined {
    const identity = this.decodeSessionKey(sessionKey);
    if (identity === undefined) {
      return undefined;
    }

    return this.bindingStore.setWorkspaceStartupArgs(identity, args);
  }

  clearWorkspaceStartupArgs(sessionKey: string): StoredChatBinding | undefined {
    const identity = this.decodeSessionKey(sessionKey);
    if (identity === undefined) {
      return undefined;
    }

    return this.bindingStore.clearWorkspaceStartupArgs(identity);
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

  async restartSessionRuntime(sessionKey: string): Promise<SessionRestartResult | undefined> {
    const identity = this.decodeSessionKey(sessionKey);
    if (identity === undefined) {
      return undefined;
    }

    const binding = this.bindingStore.getByIdentity(identity);
    if (binding === undefined) {
      return undefined;
    }

    return this.restartBindingRuntime(binding);
  }

  async restartRuntimes(scope: "running" | "all"): Promise<SessionRestartResult[]> {
    if (scope === "all") {
      const results: SessionRestartResult[] = [];
      for (const binding of this.bindingStore.listAll()) {
        results.push(await this.restartBindingRuntime(binding));
      }

      return results;
    }

    if (this.runtime === undefined) {
      return [];
    }

    const entries = await this.runtime.listEntries();
    const results: SessionRestartResult[] = [];
    for (const entry of entries) {
      results.push(await this.restartBindingRuntime(entry.binding));
    }

    return results;
  }

  async createAndBindNewSession(sessionKey: string, parentSession?: string | undefined): Promise<SessionRebindResult | undefined> {
    const binding = this.getBindingBySessionKey(sessionKey);
    if (binding === undefined) {
      return undefined;
    }

    return this.runSessionMutation(binding, async () =>
      this.rebindAfterControlCommand(binding, {
        type: "new_session",
        parentSession
      })
    );
  }

  async switchAndBindSession(sessionKey: string, targetSessionId: string): Promise<SessionRebindResult | undefined> {
    const binding = this.getBindingBySessionKey(sessionKey);
    if (binding === undefined) {
      return undefined;
    }

    const summary = (await listSessionSummaries(binding.sessionDir)).find((item) => item.id === targetSessionId);
    if (summary === undefined) {
      throw new Error("Session file not found");
    }

    return this.runSessionMutation(binding, async () =>
      this.rebindAfterControlCommand(binding, {
        type: "switch_session",
        sessionPath: summary.filePath
      })
    );
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

  private async runSessionMutation<T>(binding: StoredChatBinding, task: () => Promise<T>): Promise<T> {
    return this.queue === undefined ? task() : this.queue.run(binding, task);
  }

  private async restartBindingRuntime(binding: StoredChatBinding): Promise<SessionRestartResult> {
    const stopped = await this.runtime?.shutdownBinding(binding, "admin_restart");
    const latestBinding = this.bindingStore.getByIdentity(binding) ?? binding;
    const ensured = latestBinding.protectedRuntime
      ? await this.runtime?.ensureBinding(latestBinding)
      : undefined;

    return {
      sessionKey: encodeChatKey(latestBinding),
      stoppedRuntime: stopped?.stopped ?? false,
      protectedRuntime: latestBinding.protectedRuntime,
      startedRuntime: ensured?.startedRuntime ?? false,
      pid: ensured?.pid
    };
  }

  private async rebindAfterControlCommand(
    binding: StoredChatBinding,
    command: Extract<PiRpcControlCommand, { readonly type: "new_session" | "switch_session" }>
  ): Promise<SessionRebindResult> {
    if (this.runtime === undefined) {
      throw new Error("Runtime manager is not available");
    }

    const wasRunning = this.runtime.hasLiveRuntime(binding);
    let updatedBinding = binding;
    let startedRuntime = false;
    let stoppedRuntime = false;
    let nextState: PiRpcState | undefined;

    try {
      const control = await this.runtime.runControlCommand(binding, command, {
        startIfMissing: true,
        stopIfStarted: false
      });
      startedRuntime = control.startedRuntime;
      const stateControl = await this.runtime.runControlCommand(binding, { type: "get_state" }, {
        startIfMissing: true,
        stopIfStarted: false
      });
      nextState = asPiRpcState(stateControl.result);
      updatedBinding = this.bindingStore.setSessionId(binding, nextState.sessionId) ?? binding;
      this.runtime.updateBinding(updatedBinding);
    } finally {
      if (!wasRunning) {
        const stopped = await this.runtime.shutdownBinding(updatedBinding, "admin_control");
        stoppedRuntime = stopped.stopped;
      }
    }

    if (nextState === undefined) {
      throw new Error("Pi did not return a valid session state");
    }

    return {
      sessionKey: encodeChatKey(updatedBinding),
      previousSessionId: binding.sessionId,
      sessionId: updatedBinding.sessionId,
      sessionFile: nextState.sessionFile ?? null,
      startedRuntime,
      stoppedRuntime
    };
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

function asPiRpcState(value: unknown): PiRpcState {
  if (typeof value !== "object" || value === null) {
    throw new Error("Pi did not return a valid session state");
  }

  const state = value as Partial<PiRpcState>;
  if (typeof state.sessionId !== "string" || state.sessionId.length === 0) {
    throw new Error("Pi did not return a valid session id");
  }

  return state as PiRpcState;
}
