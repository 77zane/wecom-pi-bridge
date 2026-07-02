import path from "node:path";
import { createApp } from "./app.js";
import { BindingStore } from "./bindings/binding-store.js";
import { loadConfig, loadEnvironmentFile, validateStartupConfig } from "./config.js";
import { logError, logInfo } from "./logging.js";
import { PiRpcClient } from "./pi/pi-rpc-client.js";
import { ChatMessageQueue } from "./runtime/chat-message-queue.js";
import { RuntimeManager } from "./runtime/runtime-manager.js";
import { ScheduledTaskService } from "./scheduler/scheduled-task-service.js";
import { ScheduledTaskStore } from "./scheduler/scheduled-task-store.js";
import { ConversationDispatcher } from "./wecom/conversation-dispatcher.js";
import { WeComBridge } from "./wecom/wecom-bridge.js";
import {
  createWeComDownloader,
  createWeComSender,
  startWeComBot
} from "./wecom/wecom-bot.js";

loadEnvironmentFile();
const config = loadConfig();
validateStartupConfig(config);
const bindingStore = new BindingStore(path.join(config.dataDir, "app.db"), config.dataDir);
const runtime = new RuntimeManager({
  maxProcesses: config.maxProcesses,
  idleTimeoutMs: config.idleTimeoutMs,
  idleReapingEnabled: () => bindingStore.getRuntimePolicy().idleReapingEnabled,
  isProtected: (binding) => bindingStore.isRuntimeProtected(binding),
  clientFactory: async (binding) =>
    PiRpcClient.spawn({
      command: config.piCommand,
      cwd: binding.workspacePath,
      sessionId: binding.sessionId,
      sessionDir: binding.sessionDir,
      sessionName: binding.externalChatId
    })
});
const queue = new ChatMessageQueue();
const scheduledTaskStore = new ScheduledTaskStore(path.join(config.dataDir, "app.db"));
const scheduledTasks = new ScheduledTaskService(scheduledTaskStore, bindingStore, runtime);
const app = createApp(config, {
  bindingStore,
  runtime,
  queue,
  scheduledTasks
});
const reaperInterval = setInterval(() => {
  void runtime.reapIdle();
}, Math.min(config.idleTimeoutMs, 60_000));
reaperInterval.unref();
const schedulerInterval = setInterval(() => {
  void scheduledTasks.tick();
}, 30_000);
schedulerInterval.unref();
const weComBot = startWeComBot(config, (client) => {
  const sender = createWeComSender(client);
  const dispatcher = new ConversationDispatcher(bindingStore, queue, runtime, sender);
  scheduledTasks.setDispatcher(dispatcher);
  return new WeComBridge({
    bindingStore,
    queue,
    runtime,
    sender,
    dispatcher,
    downloader: createWeComDownloader(client)
  });
});

app.addHook("onClose", async () => {
  clearInterval(reaperInterval);
  clearInterval(schedulerInterval);
  weComBot?.disconnect();
  const stoppedProcesses = await runtime.shutdown();
  logInfo("service.shutdown", {
    stoppedProcesses
  });
  bindingStore.close();
  scheduledTaskStore.close();
});

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) {
    process.exit(1);
  }

  shuttingDown = true;
  try {
    await app.close();
    process.exit(0);
  } catch (error: unknown) {
    logError("service.shutdown_failed", error, {
      signal
    });
    process.exit(1);
  }
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await app.listen({
  host: config.host,
  port: config.port
});
