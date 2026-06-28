import path from "node:path";
import { createApp } from "./app.js";
import { BindingStore } from "./bindings/binding-store.js";
import { loadConfig, loadEnvironmentFile, validateStartupConfig } from "./config.js";
import { logError, logInfo } from "./logging.js";
import { PiRpcClient } from "./pi/pi-rpc-client.js";
import { ChatMessageQueue } from "./runtime/chat-message-queue.js";
import { RuntimeManager } from "./runtime/runtime-manager.js";
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
const app = createApp(config, {
  bindingStore
});
const reaperInterval = setInterval(() => {
  void runtime.reapIdle();
}, Math.min(config.idleTimeoutMs, 60_000));
reaperInterval.unref();
const weComBot = startWeComBot(config, (client) => {
  return new WeComBridge({
    bindingStore,
    queue,
    runtime,
    sender: createWeComSender(client),
    downloader: createWeComDownloader(client)
  });
});

app.addHook("onClose", async () => {
  clearInterval(reaperInterval);
  weComBot?.disconnect();
  const stoppedProcesses = await runtime.shutdown();
  logInfo("service.shutdown", {
    stoppedProcesses
  });
  bindingStore.close();
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
