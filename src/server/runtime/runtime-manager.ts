import type { StoredChatBinding } from "../bindings/binding-store.js";
import {
  DEFAULT_PI_RPC_SHUTDOWN_GRACE_MS,
  type PiRpcControlCommand,
  type PiRpcDelivery,
  type PiRpcShutdownResult,
  type PiRpcState
} from "../pi/pi-rpc-client.js";
import { logError, logInfo, logWarn, type LogDetails } from "../logging.js";

export interface ManagedPiClient {
  readonly pid?: number | undefined;
  getState(): Promise<PiRpcState>;
  sendControlCommand(command: PiRpcControlCommand): Promise<unknown>;
  deliverUserMessage(message: string): Promise<PiRpcDelivery>;
  runUserMessage(message: string): Promise<string>;
  shutdown(gracePeriodMs?: number): Promise<PiRpcShutdownResult>;
  kill(signal?: NodeJS.Signals | number): boolean;
  onExit(listener: () => void): () => void;
}

export interface RuntimeManagerOptions {
  readonly maxProcesses: number;
  readonly idleTimeoutMs: number;
  readonly clientFactory: (binding: StoredChatBinding) => Promise<ManagedPiClient>;
  readonly now?: () => number;
  readonly idleReapingEnabled?: (() => boolean) | undefined;
  readonly isProtected?: ((binding: StoredChatBinding) => boolean) | undefined;
}

interface RuntimeEntry {
  readonly binding: StoredChatBinding;
  readonly client: ManagedPiClient;
  activeOperations: number;
  lastUsedAt: number;
}

export interface RuntimeEntryView {
  readonly binding: StoredChatBinding;
  readonly pid?: number | undefined;
  readonly activeOperations: number;
  readonly lastUsedAt: number;
  readonly state?: PiRpcState | undefined;
  readonly stateError?: string | undefined;
}

export interface RuntimeControlResult {
  readonly result?: unknown;
  readonly startedRuntime: boolean;
  readonly stoppedRuntime: boolean;
  readonly shutdownResult?: PiRpcShutdownResult | undefined;
}

interface KillInspection {
  readonly state: PiRpcState | undefined;
  readonly canKill: boolean;
  readonly reason: "idle" | "busy" | "state_unavailable";
}

type ShutdownReason =
  | "idle"
  | "service_shutdown"
  | "delivery_error"
  | "admin_stop"
  | "admin_reset"
  | "admin_control"
  | "admin_restart"
  | "scheduled_task";

export class RuntimeManager {
  private readonly maxProcesses: number;
  private readonly idleTimeoutMs: number;
  private readonly clientFactory: (binding: StoredChatBinding) => Promise<ManagedPiClient>;
  private readonly now: () => number;
  private readonly idleReapingEnabled: () => boolean;
  private readonly isProtected: (binding: StoredChatBinding) => boolean;
  private readonly entries = new Map<string, RuntimeEntry>();

  constructor(options: RuntimeManagerOptions) {
    if (options.maxProcesses < 1) {
      throw new Error("maxProcesses must be at least 1");
    }
    if (options.idleTimeoutMs < 1) {
      throw new Error("idleTimeoutMs must be at least 1");
    }

    this.maxProcesses = options.maxProcesses;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.clientFactory = options.clientFactory;
    this.now = options.now ?? Date.now;
    this.idleReapingEnabled = options.idleReapingEnabled ?? (() => true);
    this.isProtected = options.isProtected ?? (() => false);
  }

  get activeCount(): number {
    return this.entries.size;
  }

  hasLiveRuntime(binding: StoredChatBinding): boolean {
    return this.entries.has(getBindingKey(binding));
  }

  async listEntries(): Promise<RuntimeEntryView[]> {
    return Promise.all(
      Array.from(this.entries.values()).map(async (entry) => {
        try {
          return {
            binding: entry.binding,
            pid: entry.client.pid,
            activeOperations: entry.activeOperations,
            lastUsedAt: entry.lastUsedAt,
            state: await entry.client.getState()
          };
        } catch (error: unknown) {
          return {
            binding: entry.binding,
            pid: entry.client.pid,
            activeOperations: entry.activeOperations,
            lastUsedAt: entry.lastUsedAt,
            stateError: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
  }

  async deliver(binding: StoredChatBinding, message: string): Promise<PiRpcDelivery> {
    const entry = await this.getOrCreateEntry(binding);
    entry.activeOperations += 1;
    try {
      const result = await entry.client.deliverUserMessage(message);
      entry.lastUsedAt = this.now();
      return result;
    } catch (error: unknown) {
      await this.dropEntry(binding, entry, "delivery_error");
      throw error;
    } finally {
      entry.activeOperations -= 1;
    }
  }

  async runMessage(binding: StoredChatBinding, message: string): Promise<string> {
    const entry = await this.getOrCreateEntry(binding);
    entry.activeOperations += 1;
    try {
      const result = await entry.client.runUserMessage(message);
      entry.lastUsedAt = this.now();
      return result;
    } catch (error: unknown) {
      await this.dropEntry(binding, entry, "delivery_error");
      throw error;
    } finally {
      entry.activeOperations -= 1;
    }
  }

  async sendControlCommand(binding: StoredChatBinding, command: PiRpcControlCommand): Promise<unknown> {
    const control = await this.runControlCommand(binding, command, {
      startIfMissing: false,
      stopIfStarted: false
    });
    return control.result;
  }

  async ensureBinding(binding: StoredChatBinding): Promise<{ readonly startedRuntime: boolean; readonly pid?: number | undefined }> {
    const key = getBindingKey(binding);
    const existing = this.entries.get(key);
    const entry = existing ?? (await this.getOrCreateEntry(binding));
    return {
      startedRuntime: existing === undefined,
      pid: entry.client.pid
    };
  }

  updateBinding(binding: StoredChatBinding): boolean {
    const key = getBindingKey(binding);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }

    this.entries.set(key, {
      ...entry,
      binding
    });
    return true;
  }

  async runControlCommand(
    binding: StoredChatBinding,
    command: PiRpcControlCommand,
    options: { readonly startIfMissing: boolean; readonly stopIfStarted: boolean }
  ): Promise<RuntimeControlResult> {
    const entry = this.entries.get(getBindingKey(binding));
    if (entry === undefined && !options.startIfMissing) {
      throw new Error(`No live Pi process for session: ${binding.sessionId}`);
    }

    const controlEntry = entry ?? (await this.getOrCreateEntry(binding));
    const startedRuntime = entry === undefined;
    let stoppedRuntime = false;
    let shutdownResult: PiRpcShutdownResult | undefined;
    let result: unknown;
    controlEntry.activeOperations += 1;
    try {
      result = await controlEntry.client.sendControlCommand(command);
      controlEntry.lastUsedAt = this.now();
    } finally {
      controlEntry.activeOperations -= 1;
      if (startedRuntime && options.stopIfStarted) {
        this.entries.delete(getBindingKey(binding));
        shutdownResult = await this.shutdownEntry(controlEntry, "admin_control");
        stoppedRuntime = true;
      }
    }

    return {
      result,
      startedRuntime,
      stoppedRuntime,
      shutdownResult
    };
  }

  async shutdownBinding(
    binding: StoredChatBinding,
    reason: Extract<ShutdownReason, "admin_stop" | "admin_reset" | "admin_control" | "admin_restart" | "scheduled_task"> = "admin_stop"
  ): Promise<{ readonly stopped: boolean; readonly result?: PiRpcShutdownResult | undefined }> {
    const key = getBindingKey(binding);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return { stopped: false };
    }

    this.entries.delete(key);
    const result = await this.shutdownEntry(entry, reason);
    return {
      stopped: true,
      result
    };
  }

  private async getOrCreateEntry(binding: StoredChatBinding): Promise<RuntimeEntry> {
    const key = getBindingKey(binding);
    let entry = this.entries.get(key);

    if (entry === undefined) {
      await this.ensureCapacity();
      const client = await this.clientFactory(binding);
      entry = {
        binding,
        client,
        activeOperations: 0,
        lastUsedAt: this.now()
      };
      this.entries.set(key, entry);
      client.onExit(() => {
        if (this.entries.get(key)?.client === client) {
          this.entries.delete(key);
          logInfo("pi.process_removed", {
            sessionId: binding.sessionId,
            pid: client.pid,
            reason: "exit"
          });
        }
      });
    }

    return entry;
  }

  async reapIdle(): Promise<number> {
    if (!this.idleReapingEnabled()) {
      return 0;
    }

    let killed = 0;
    const now = this.now();

    for (const [key, entry] of this.entries) {
      const idleForMs = now - entry.lastUsedAt;
      if (idleForMs < this.idleTimeoutMs) {
        continue;
      }

      if (this.isProtected(entry.binding)) {
        logInfo("pi.idle_reap_skipped", {
          sessionId: entry.binding.sessionId,
          pid: entry.client.pid,
          reason: "protected_runtime",
          idleForMs
        });
        continue;
      }

      if (entry.activeOperations > 0) {
        logInfo("pi.idle_reap_skipped", {
          sessionId: entry.binding.sessionId,
          pid: entry.client.pid,
          reason: "active_operation",
          idleForMs,
          activeOperations: entry.activeOperations
        });
        continue;
      }

      const inspection = await this.inspectKillState(entry.client);
      if (!inspection.canKill) {
        const logDetails = {
          ...baseRuntimeLogDetails(entry),
          ...stateLogDetails(inspection.state),
          reason: inspection.reason,
          idleForMs
        };

        if (inspection.reason === "state_unavailable") {
          logWarn("pi.idle_reap_skipped", logDetails);
        } else {
          logInfo("pi.idle_reap_skipped", logDetails);
        }
        continue;
      }

      this.entries.delete(key);
      await this.shutdownEntry(entry, "idle", {
        idleForMs,
        ...stateLogDetails(inspection.state)
      });
      killed += 1;
    }

    return killed;
  }

  async shutdown(): Promise<number> {
    let killed = 0;
    const entries = Array.from(this.entries.values());
    this.entries.clear();

    await Promise.all(
      entries.map(async (entry) => {
        await this.shutdownEntry(entry, "service_shutdown");
        killed += 1;
      })
    );

    return killed;
  }

  private async ensureCapacity(): Promise<void> {
    if (this.entries.size < this.maxProcesses) {
      return;
    }

    await this.reapIdle();

    if (this.entries.size >= this.maxProcesses) {
      throw new Error(`Pi process limit reached: ${this.maxProcesses}`);
    }
  }

  private async inspectKillState(client: ManagedPiClient): Promise<KillInspection> {
    try {
      const state = await client.getState();
      const canKill = !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0;
      return {
        state,
        canKill,
        reason: canKill ? "idle" : "busy"
      };
    } catch {
      return {
        state: undefined,
        canKill: false,
        reason: "state_unavailable"
      };
    }
  }

  private async dropEntry(binding: StoredChatBinding, entry: RuntimeEntry, reason: ShutdownReason): Promise<void> {
    const key = getBindingKey(binding);
    if (this.entries.get(key) !== entry) {
      return;
    }

    this.entries.delete(key);
    await this.shutdownEntry(entry, reason);
  }

  private async shutdownEntry(
    entry: RuntimeEntry,
    reason: ShutdownReason,
    details: LogDetails = {}
  ): Promise<PiRpcShutdownResult | undefined> {
    const startedAt = this.now();
    logInfo("pi.shutdown_started", {
      ...baseRuntimeLogDetails(entry),
      ...details,
      reason,
      gracePeriodMs: DEFAULT_PI_RPC_SHUTDOWN_GRACE_MS
    });

    try {
      const result = await entry.client.shutdown(DEFAULT_PI_RPC_SHUTDOWN_GRACE_MS);
      logInfo("pi.shutdown_finished", {
        ...baseRuntimeLogDetails(entry),
        reason,
        shutdownResult: result,
        elapsedMs: this.now() - startedAt
      });
      return result;
    } catch (error: unknown) {
      logError("pi.shutdown_failed", error, {
        ...baseRuntimeLogDetails(entry),
        reason,
        elapsedMs: this.now() - startedAt
      });
      return undefined;
    }
  }
}

export function getBindingKey(binding: StoredChatBinding): string {
  return `${binding.botId}\0${binding.kind}\0${binding.externalChatId}`;
}

function baseRuntimeLogDetails(entry: RuntimeEntry): LogDetails {
  return {
    sessionId: entry.binding.sessionId,
    pid: entry.client.pid
  };
}

function stateLogDetails(state: PiRpcState | undefined): LogDetails {
  if (state === undefined) {
    return {};
  }

  return {
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
    pendingMessageCount: state.pendingMessageCount,
    messageCount: state.messageCount
  };
}
