import { decodeChatKey, type BindingStore, type StoredChatBinding } from "../bindings/binding-store.js";
import { logError, logInfo } from "../logging.js";
import type { PiRpcControlCommand } from "../pi/pi-rpc-client.js";
import type { RuntimeManager } from "../runtime/runtime-manager.js";
import type { ConversationDispatcher } from "../wecom/conversation-dispatcher.js";
import type { WeComChatAddress } from "../wecom/wecom-message.js";
import {
  ScheduledTaskStore,
  type ScheduledExecutionTrigger,
  type ScheduledTask,
  type ScheduledTaskExecution,
  type ScheduledTaskInput,
  type ScheduledTaskStep
} from "./scheduled-task-store.js";

export interface ScheduledTaskRunResult {
  readonly execution: ScheduledTaskExecution;
  readonly targetCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly errors: string[];
}

export class ScheduledTaskService {
  private dispatcher: ConversationDispatcher | undefined;
  private running = false;
  private readonly activeTaskIds = new Set<string>();

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly bindingStore: BindingStore,
    private readonly runtime: RuntimeManager
  ) {}

  setDispatcher(dispatcher: ConversationDispatcher): void {
    this.dispatcher = dispatcher;
  }

  listTasks(): ScheduledTask[] {
    return this.store.listTasks();
  }

  listExecutions(taskId?: string | undefined): ScheduledTaskExecution[] {
    return this.store.listExecutions(taskId);
  }

  createTask(input: ScheduledTaskInput): ScheduledTask {
    return this.store.createTask(input);
  }

  updateTask(id: string, input: ScheduledTaskInput): ScheduledTask | undefined {
    return this.store.updateTask(id, input);
  }

  deleteTask(id: string): boolean {
    return this.store.deleteTask(id);
  }

  async runTaskNow(id: string): Promise<ScheduledTaskRunResult | undefined> {
    const task = this.store.getTask(id);
    if (task === undefined) {
      return undefined;
    }

    return this.runTask(task, "manual", { updateSchedule: false });
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      for (const task of this.store.listDueTasks(now)) {
        await this.runTask(task, "scheduled", { updateSchedule: true });
      }
    } finally {
      this.running = false;
    }
  }

  private async runTask(
    task: ScheduledTask,
    trigger: ScheduledExecutionTrigger,
    options: { readonly updateSchedule: boolean }
  ): Promise<ScheduledTaskRunResult> {
    if (this.activeTaskIds.has(task.id)) {
      const execution = this.store.startExecution(task.id, trigger);
      const error = "Task is already running";
      this.store.finishExecution(execution.id, {
        status: "error",
        targetCount: 0,
        successCount: 0,
        errorCount: 1,
        error
      });
      return {
        execution: this.store.getExecution(execution.id) ?? execution,
        targetCount: 0,
        successCount: 0,
        errorCount: 1,
        errors: [error]
      };
    }

    this.activeTaskIds.add(task.id);
    const execution = this.store.startExecution(task.id, trigger);
    if (options.updateSchedule) {
      this.store.markTaskStarted(task);
    }

    let targetCount = 0;
    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    try {
      const bindings = this.resolveBindings(task);
      targetCount = bindings.length;
      logInfo("scheduled_task.started", {
        taskId: task.id,
        trigger,
        scope: task.scope,
        targetCount
      });

      for (const binding of bindings) {
        try {
          await this.runForBinding(task, binding);
          successCount += 1;
        } catch (error: unknown) {
          errorCount += 1;
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${binding.externalChatId}: ${message}`);
          logError("scheduled_task.target_failed", error, {
            taskId: task.id,
            sessionId: binding.sessionId
          });
        }
      }

      const status = errorCount === 0 ? "success" : "error";
      const errorText = errors.length === 0 ? null : errors.join("\n");
      this.store.finishExecution(execution.id, {
        status,
        targetCount,
        successCount,
        errorCount,
        error: errorText
      });
      if (options.updateSchedule) {
        this.store.markTaskFinished(task, status, errorText);
      }
      logInfo("scheduled_task.finished", {
        taskId: task.id,
        trigger,
        status,
        targetCount,
        successCount,
        errorCount
      });

      return {
        execution: this.store.getExecution(execution.id) ?? execution,
        targetCount,
        successCount,
        errorCount,
        errors
      };
    } finally {
      this.activeTaskIds.delete(task.id);
    }
  }

  private resolveBindings(task: ScheduledTask): StoredChatBinding[] {
    if (task.scope === "global") {
      return this.bindingStore.listAll();
    }

    if (task.sessionKey === undefined) {
      throw new Error("Session-scoped task is missing sessionKey");
    }

    const binding = this.bindingStore.getByIdentity(decodeChatKey(task.sessionKey));
    if (binding === undefined) {
      throw new Error("Session not found");
    }

    return [binding];
  }

  private async runForBinding(task: ScheduledTask, binding: StoredChatBinding): Promise<void> {
    const wasRunning = this.runtime.hasLiveRuntime(binding);
    const ensured = await this.runtime.ensureBinding(binding);
    const shouldStopAfterRun = !wasRunning && ensured.startedRuntime;
    try {
      for (const step of task.steps) {
        await this.runStep(binding, step);
      }
    } finally {
      if (shouldStopAfterRun) {
        await this.runtime.shutdownBinding(binding, "scheduled_task");
      }
    }
  }

  private async runStep(binding: StoredChatBinding, step: ScheduledTaskStep): Promise<void> {
    if (step.type === "control") {
      await this.runtime.runControlCommand(binding, step.command as PiRpcControlCommand, {
        startIfMissing: true,
        stopIfStarted: false
      });
      return;
    }

    if (this.dispatcher === undefined) {
      throw new Error("Conversation dispatcher is not available");
    }

    await this.dispatcher.runPromptAndReply(toScheduledAddress(binding), binding, step.message);
  }
}

function toScheduledAddress(binding: StoredChatBinding): WeComChatAddress {
  return {
    botId: binding.botId,
    kind: binding.kind,
    externalChatId: binding.externalChatId,
    replyChatId: binding.externalChatId
  };
}
