import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SendMsgBody, WeComMediaType } from "@wecom/aibot-node-sdk";
import { BindingStore } from "../src/server/bindings/binding-store.js";
import type { PiRpcControlCommand, PiRpcDelivery, PiRpcShutdownResult, PiRpcState } from "../src/server/pi/pi-rpc-client.js";
import { ChatMessageQueue } from "../src/server/runtime/chat-message-queue.js";
import { RuntimeManager, type ManagedPiClient } from "../src/server/runtime/runtime-manager.js";
import { ScheduledTaskService } from "../src/server/scheduler/scheduled-task-service.js";
import { ScheduledTaskStore } from "../src/server/scheduler/scheduled-task-store.js";
import { ConversationDispatcher, type WeComSender } from "../src/server/wecom/conversation-dispatcher.js";

const tempDirs: string[] = [];
const bindingStores: BindingStore[] = [];
const taskStores: ScheduledTaskStore[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-pi-scheduled-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const store of bindingStores.splice(0)) {
    store.close();
  }
  for (const store of taskStores.splice(0)) {
    store.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

class FakeManagedPiClient implements ManagedPiClient {
  readonly pid = 1234;
  readonly messages: string[] = [];
  readonly controlCommands: PiRpcControlCommand[] = [];
  shutdownCount = 0;

  async getState(): Promise<PiRpcState> {
    return {
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: "s-test",
      autoCompactionEnabled: true,
      messageCount: this.messages.length,
      pendingMessageCount: 0
    };
  }

  async sendControlCommand(command: PiRpcControlCommand): Promise<unknown> {
    this.controlCommands.push(command);
    return { ok: true };
  }

  async deliverUserMessage(message: string): Promise<PiRpcDelivery> {
    this.messages.push(message);
    return "prompt";
  }

  async runUserMessage(message: string): Promise<string> {
    this.messages.push(message);
    return `reply:${this.messages.length}`;
  }

  async shutdown(): Promise<PiRpcShutdownResult> {
    this.shutdownCount += 1;
    return "exited";
  }

  kill(): boolean {
    this.shutdownCount += 1;
    return true;
  }

  onExit(): () => void {
    return () => {};
  }
}

class FakeSender implements WeComSender {
  readonly sent: Array<{ chatId: string; body: SendMsgBody }> = [];
  readonly uploads: Array<{ type: WeComMediaType; filename: string }> = [];
  readonly mediaMessages: Array<{ chatId: string; type: WeComMediaType; mediaId: string }> = [];

  async sendMessage(chatId: string, body: SendMsgBody): Promise<void> {
    this.sent.push({ chatId, body });
  }

  async uploadMedia(_buffer: Buffer, options: { readonly type: WeComMediaType; readonly filename: string }): Promise<{ readonly mediaId: string }> {
    this.uploads.push({ type: options.type, filename: options.filename });
    return { mediaId: `media-${this.uploads.length}` };
  }

  async sendMediaMessage(chatId: string, type: WeComMediaType, mediaId: string): Promise<void> {
    this.mediaMessages.push({ chatId, type, mediaId });
  }
}

describe("ScheduledTaskService", () => {
  it("runs steps in order, replies for prompts, and stops only scheduler-started runtimes", async () => {
    const dataDir = await createTempDir();
    const dbPath = path.join(dataDir, "app.db");
    const bindingStore = new BindingStore(dbPath, dataDir);
    bindingStores.push(bindingStore);
    const binding = bindingStore.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      displayName: "User A"
    });
    const taskStore = new ScheduledTaskStore(dbPath);
    taskStores.push(taskStore);
    const client = new FakeManagedPiClient();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    const queue = new ChatMessageQueue();
    const sender = new FakeSender();
    const dispatcher = new ConversationDispatcher(bindingStore, queue, runtime, sender);
    const service = new ScheduledTaskService(taskStore, bindingStore, runtime);
    service.setDispatcher(dispatcher);
    const task = taskStore.createTask({
      name: "daily",
      enabled: true,
      scope: "session",
      sessionKey: Buffer.from(JSON.stringify([binding.botId, binding.kind, binding.externalChatId]), "utf8").toString("base64url"),
      schedule: { type: "cron", expression: "0 9 * * *" },
      steps: [
        { type: "prompt", message: "first" },
        { type: "control", command: { type: "set_thinking_level", level: "high" } },
        { type: "prompt", message: "second" }
      ]
    });

    const result = await service.runTaskNow(task.id);

    expect(result?.successCount).toBe(1);
    expect(client.messages).toHaveLength(2);
    expect(client.messages[0]).toContain("first");
    expect(client.messages[1]).toBe("second");
    expect(client.controlCommands).toEqual([{ type: "set_thinking_level", level: "high" }]);
    expect(sender.sent.map((item) => item.body)).toEqual([
      { msgtype: "markdown", markdown: { content: "reply:1" } },
      { msgtype: "markdown", markdown: { content: "reply:2" } }
    ]);
    expect(client.shutdownCount).toBe(1);
    expect(runtime.activeCount).toBe(0);
  });
});
