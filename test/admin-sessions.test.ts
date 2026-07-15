import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import {
  BindingStore,
  encodeChatKey
} from "../src/server/bindings/binding-store.js";
import type { AppConfig } from "../src/server/config.js";
import type {
  PiRpcControlCommand,
  PiRpcDelivery,
  PiRpcShutdownResult,
  PiRpcState
} from "../src/server/pi/pi-rpc-client.js";
import { ChatMessageQueue } from "../src/server/runtime/chat-message-queue.js";
import {
  RuntimeManager,
  type ManagedPiClient
} from "../src/server/runtime/runtime-manager.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-pi-admin-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

class FakeManagedPiClient implements ManagedPiClient {
  readonly pid = 4321;
  readonly controlCommands: PiRpcControlCommand[] = [];
  readonly shutdownReasons: string[] = [];
  nextNewSessionId = "s-new";
  nextSwitchSessionId = "s-switched";
  private readonly exitListeners = new Set<() => void>();
  killed = false;
  state: PiRpcState = {
    model: {
      provider: "deepseek",
      id: "deepseek-v4-flash"
    },
    thinkingLevel: "high",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionId: "s-admin",
    autoCompactionEnabled: true,
    messageCount: 2,
    pendingMessageCount: 0
  };

  async getState(): Promise<PiRpcState> {
    return this.state;
  }

  async deliverUserMessage(): Promise<PiRpcDelivery> {
    return "prompt";
  }

  async runUserMessage(): Promise<string> {
    return "ok";
  }

  async sendControlCommand(command: PiRpcControlCommand): Promise<unknown> {
    this.controlCommands.push(command);
    if (command.type === "get_state") {
      return this.state;
    }
    if (command.type === "set_model") {
      this.state = {
        ...this.state,
        model: {
          provider: command.provider,
          id: command.modelId
        }
      };
      return this.state.model;
    }
    if (command.type === "new_session") {
      this.state = {
        ...this.state,
        sessionId: this.nextNewSessionId,
        sessionFile: `/sessions/${this.nextNewSessionId}.jsonl`,
        messageCount: 0,
        pendingMessageCount: 0
      };
      return undefined;
    }
    if (command.type === "switch_session") {
      this.state = {
        ...this.state,
        sessionId: this.nextSwitchSessionId,
        sessionFile: command.sessionPath
      };
      return undefined;
    }

    return undefined;
  }

  async shutdown(): Promise<PiRpcShutdownResult> {
    this.killed = true;
    return "exited";
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
}

function createConfig(dataDir: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    dataDir,
    piCommand: "pi",
    maxProcesses: 50,
    idleTimeoutMs: 30 * 60 * 1000,
    wecomBotId: "",
    wecomBotSecret: "",
    wecomBotWsUrl: ""
  };
}

describe("admin session API", () => {
  it("lists known sessions with runtime status and accepts single-session control commands", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      displayName: "User A"
    });
    const client = new FakeManagedPiClient();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    await runtime.runMessage(binding, "warm runtime");
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const listResponse = await app.inject({ method: "GET", url: "/api/admin/sessions" });
    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json<{
      sessions: Array<{
        sessionKey: string;
        runtime: { status: string; pid: number | null; state: PiRpcState | null };
      }>;
    }>();

    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0]).toMatchObject({
      sessionKey: encodeChatKey(binding),
      runtime: {
        status: "running",
        pid: 4321,
        state: {
          thinkingLevel: "high",
          messageCount: 2
        }
      }
    });

    const controlResponse = await app.inject({
      method: "POST",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/control`,
      payload: {
        command: {
          type: "set_model",
          provider: "deepseek",
          modelId: "deepseek-v4-pro"
        }
      }
    });

    expect(controlResponse.statusCode).toBe(200);
    expect(controlResponse.json<{ result: unknown }>().result).toMatchObject({
      provider: "deepseek",
      id: "deepseek-v4-pro"
    });
    expect(client.controlCommands).toEqual([
      {
        type: "set_model",
        provider: "deepseek",
        modelId: "deepseek-v4-pro"
      }
    ]);

    await app.close();
    store.close();
  });

  it("runs a single-session control command by starting and stopping an inactive runtime", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "inactive-user",
      displayName: "Inactive User"
    });
    const client = new FakeManagedPiClient();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const controlResponse = await app.inject({
      method: "POST",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/control`,
      payload: {
        command: {
          type: "set_thinking_level",
          level: "medium"
        }
      }
    });

    expect(controlResponse.statusCode).toBe(200);
    expect(controlResponse.json()).toMatchObject({
      startedRuntime: true,
      stoppedRuntime: true
    });
    expect(client.controlCommands).toEqual([
      {
        type: "set_thinking_level",
        level: "medium"
      }
    ]);
    expect(client.killed).toBe(true);
    expect(runtime.activeCount).toBe(0);

    await app.close();
    store.close();
  });

  it("resets a session by stopping its runtime, deleting its binding, and removing its workspace", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "group",
      externalChatId: "group-a",
      displayName: "Group A"
    });
    await writeFile(path.join(binding.sessionDir, "old-session.jsonl"), "{\"type\":\"session\"}\n", "utf8");
    await writeFile(path.join(binding.inboxDir, "old-file.txt"), "old", "utf8");
    await mkdir(path.join(binding.workspacePath, "outbox"), { recursive: true });
    await writeFile(path.join(binding.workspacePath, "outbox", "old-result.txt"), "old", "utf8");
    const client = new FakeManagedPiClient();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    await runtime.runMessage(binding, "warm runtime");
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const resetResponse = await app.inject({
      method: "POST",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/reset`
    });

    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toMatchObject({
      reset: {
        sessionKey: encodeChatKey(binding),
        stoppedRuntime: true,
        deletedBinding: true,
        deletedWorkspace: true
      }
    });
    expect(client.killed).toBe(true);
    expect(runtime.activeCount).toBe(0);
    expect(store.listAll()).toEqual([]);
    expect(existsSync(binding.workspacePath)).toBe(false);

    const recreated = store.getOrCreate({
      botId: binding.botId,
      kind: binding.kind,
      externalChatId: binding.externalChatId,
      displayName: "Group A"
    });
    expect(recreated.sessionId).toBe(binding.sessionId);
    expect(existsSync(recreated.sessionDir)).toBe(true);
    expect(existsSync(recreated.inboxDir)).toBe(true);
    expect(store.hasWeComFileProtocol(recreated, 1)).toBe(false);

    await app.close();
    store.close();
  });

  it("stops a single live runtime without deleting its stored session", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      displayName: "User A"
    });
    const client = new FakeManagedPiClient();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    await runtime.runMessage(binding, "warm runtime");
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const stopResponse = await app.inject({
      method: "POST",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/stop`
    });

    expect(stopResponse.statusCode).toBe(200);
    expect(stopResponse.json()).toMatchObject({
      stop: {
        sessionKey: encodeChatKey(binding),
        stoppedRuntime: true
      }
    });
    expect(client.killed).toBe(true);
    expect(runtime.activeCount).toBe(0);
    expect(store.listAll()).toHaveLength(1);
    expect(existsSync(binding.workspacePath)).toBe(true);

    await app.close();
    store.close();
  });

  it("updates the global idle reaping policy", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      queue: new ChatMessageQueue()
    });

    const initialResponse = await app.inject({ method: "GET", url: "/api/admin/runtime-policy" });
    expect(initialResponse.statusCode).toBe(200);
    expect(initialResponse.json()).toMatchObject({
      runtimePolicy: {
        idleReapingEnabled: true
      }
    });

    const updateResponse = await app.inject({
      method: "POST",
      url: "/api/admin/runtime-policy",
      payload: {
        idleReapingEnabled: false
      }
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      runtimePolicy: {
        idleReapingEnabled: false
      }
    });
    expect(store.getRuntimePolicy()).toEqual({
      idleReapingEnabled: false
    });

    await app.close();
    store.close();
  });

  it("updates global and workspace startup args through the admin API", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "startup-user",
      displayName: "Startup User"
    });
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      queue: new ChatMessageQueue()
    });

    const globalResponse = await app.inject({
      method: "PUT",
      url: "/api/admin/startup-args",
      payload: {
        args: ["--model", "opencode-go/glm-5.2"]
      }
    });
    expect(globalResponse.statusCode).toBe(200);
    expect(globalResponse.json()).toMatchObject({
      startupArgs: {
        args: ["--model", "opencode-go/glm-5.2"]
      }
    });

    const inheritedResponse = await app.inject({ method: "GET", url: "/api/admin/sessions" });
    expect(inheritedResponse.statusCode).toBe(200);
    expect(inheritedResponse.json()).toMatchObject({
      startupArgs: {
        args: ["--model", "opencode-go/glm-5.2"]
      },
      sessions: [
        {
          startup: {
            source: "global",
            args: ["--model", "opencode-go/glm-5.2"],
            workspaceArgs: null
          }
        }
      ]
    });

    const workspaceResponse = await app.inject({
      method: "PUT",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/startup-args`,
      payload: {
        args: ["--thinking", "high"]
      }
    });
    expect(workspaceResponse.statusCode).toBe(200);
    expect(store.getResolvedStartupArgs(binding)).toMatchObject({
      source: "workspace",
      args: ["--thinking", "high"]
    });

    const blockedResponse = await app.inject({
      method: "PUT",
      url: "/api/admin/startup-args",
      payload: {
        args: ["--session-id", "s-other"]
      }
    });
    expect(blockedResponse.statusCode).toBe(400);

    const clearResponse = await app.inject({
      method: "DELETE",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/startup-args`
    });
    expect(clearResponse.statusCode).toBe(200);
    expect(store.getResolvedStartupArgs(binding)).toMatchObject({
      source: "global",
      args: ["--model", "opencode-go/glm-5.2"],
      workspaceArgs: null
    });

    await app.close();
    store.close();
  });

  it("protects a session by starting its runtime, and stop kills the process while preserving data", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "protected-user",
      displayName: "Protected User"
    });
    await writeFile(path.join(binding.sessionDir, "old-session.jsonl"), "{\"type\":\"session\"}\n", "utf8");
    const client = new FakeManagedPiClient();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      isProtected: (runtimeBinding) => store.isRuntimeProtected(runtimeBinding),
      clientFactory: async () => client
    });
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const protectResponse = await app.inject({
      method: "POST",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/protection`,
      payload: {
        protectedRuntime: true
      }
    });

    expect(protectResponse.statusCode).toBe(200);
    expect(protectResponse.json()).toMatchObject({
      protection: {
        sessionKey: encodeChatKey(binding),
        protectedRuntime: true,
        startedRuntime: true
      }
    });
    expect(runtime.activeCount).toBe(1);
    expect(store.getByIdentity(binding)?.protectedRuntime).toBe(true);

    const listResponse = await app.inject({ method: "GET", url: "/api/admin/sessions" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      sessions: [
        {
          sessionKey: encodeChatKey(binding),
          binding: {
            protectedRuntime: true
          },
          runtime: {
            status: "running"
          }
        }
      ]
    });

    const stopResponse = await app.inject({
      method: "POST",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/stop`
    });

    expect(stopResponse.statusCode).toBe(200);
    expect(stopResponse.json()).toMatchObject({
      stop: {
        sessionKey: encodeChatKey(binding),
        stoppedRuntime: true,
        protectedRuntime: false
      }
    });
    expect(client.killed).toBe(true);
    expect(runtime.activeCount).toBe(0);
    expect(store.getByIdentity(binding)?.protectedRuntime).toBe(false);
    expect(store.listAll()).toHaveLength(1);
    expect(existsSync(binding.workspacePath)).toBe(true);

    await app.close();
    store.close();
  });

  it("creates a new Pi session and updates the bridge binding without clearing workspace data", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      displayName: "User A"
    });
    await writeFile(path.join(binding.workspacePath, "kept.txt"), "kept", "utf8");
    store.markWeComFileProtocol(binding, 2);
    const client = new FakeManagedPiClient();
    client.nextNewSessionId = "s-new-session";
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    await runtime.runMessage(binding, "warm runtime");
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/new-session`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      session: {
        sessionKey: encodeChatKey(binding),
        previousSessionId: binding.sessionId,
        sessionId: "s-new-session",
        sessionFile: "/sessions/s-new-session.jsonl",
        startedRuntime: false,
        stoppedRuntime: false
      }
    });
    expect(store.getByIdentity(binding)?.sessionId).toBe("s-new-session");
    expect(store.hasWeComFileProtocol(binding, 1)).toBe(false);
    expect(existsSync(path.join(binding.workspacePath, "kept.txt"))).toBe(true);
    expect(runtime.activeCount).toBe(1);
    expect(client.controlCommands.map((command) => command.type)).toEqual(["new_session", "get_state"]);

    const listResponse = await app.inject({ method: "GET", url: "/api/admin/sessions" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      sessions: [
        {
          binding: {
            sessionId: "s-new-session"
          },
          runtime: {
            status: "running",
            state: {
              sessionId: "s-new-session"
            }
          }
        }
      ]
    });

    await app.close();
    store.close();
  });

  it("switches to an existing session file, updates the binding, and stops a transient runtime", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      displayName: "User A"
    });
    const targetFile = path.join(binding.sessionDir, "target.jsonl");
    await writeFile(targetFile, `${JSON.stringify({ type: "session", id: "s-target-session" })}\n`, "utf8");
    store.markWeComFileProtocol(binding, 2);
    const client = new FakeManagedPiClient();
    client.nextSwitchSessionId = "s-target-session";
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/switch-session`,
      payload: {
        sessionId: "s-target-session"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      session: {
        sessionKey: encodeChatKey(binding),
        previousSessionId: binding.sessionId,
        sessionId: "s-target-session",
        sessionFile: targetFile,
        startedRuntime: true,
        stoppedRuntime: true
      }
    });
    expect(store.getByIdentity(binding)?.sessionId).toBe("s-target-session");
    expect(store.hasWeComFileProtocol(binding, 1)).toBe(false);
    expect(client.killed).toBe(true);
    expect(runtime.activeCount).toBe(0);
    expect(client.controlCommands).toEqual([
      {
        type: "switch_session",
        sessionPath: targetFile
      },
      {
        type: "get_state"
      }
    ]);

    await app.close();
    store.close();
  });

  it("terminates a single session by clearing its binding, workspace, and runtime", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-to-clear",
      displayName: "User To Clear"
    });
    await writeFile(path.join(binding.sessionDir, "old-session.jsonl"), "{\"type\":\"session\"}\n", "utf8");
    await writeFile(path.join(binding.inboxDir, "old-file.txt"), "old", "utf8");
    const client = new FakeManagedPiClient();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    await runtime.runMessage(binding, "warm runtime");
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const terminateResponse = await app.inject({
      method: "POST",
      url: `/api/admin/sessions/${encodeURIComponent(encodeChatKey(binding))}/terminate`
    });

    expect(terminateResponse.statusCode).toBe(200);
    expect(terminateResponse.json()).toMatchObject({
      terminate: {
        sessionKey: encodeChatKey(binding),
        stoppedRuntime: true,
        deletedBinding: true,
        deletedWorkspace: true
      }
    });
    expect(client.killed).toBe(true);
    expect(runtime.activeCount).toBe(0);
    expect(store.listAll()).toEqual([]);
    expect(existsSync(binding.workspacePath)).toBe(false);

    const listResponse = await app.inject({ method: "GET", url: "/api/admin/sessions" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({ sessions: [] });

    await app.close();
    store.close();
  });

  it("broadcasts control commands to running sessions and skips stopped sessions", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const runningBinding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "running-user",
      displayName: "Running User"
    });
    store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "stopped-user",
      displayName: "Stopped User"
    });
    const client = new FakeManagedPiClient();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    await runtime.runMessage(runningBinding, "warm runtime");
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/sessions/control",
      payload: {
        scope: "running",
        command: {
          type: "set_thinking_level",
          level: "medium"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      results: [
        {
          sessionKey: encodeChatKey(runningBinding),
          status: "ok"
        }
      ]
    });
    expect(client.controlCommands).toEqual([
      {
        type: "set_thinking_level",
        level: "medium"
      }
    ]);

    await app.close();
    store.close();
  });

  it("runs global control commands across active and inactive sessions", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const runningBinding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "running-user",
      displayName: "Running User"
    });
    const stoppedBinding = store.getOrCreate({
      botId: "bot-a",
      kind: "group",
      externalChatId: "stopped-group",
      displayName: "Stopped Group"
    });
    const clients = new Map<string, FakeManagedPiClient>();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async (binding) => {
        const client = new FakeManagedPiClient();
        clients.set(binding.externalChatId, client);
        return client;
      }
    });
    await runtime.runMessage(runningBinding, "warm runtime");
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/sessions/control",
      payload: {
        scope: "all",
        command: {
          type: "set_thinking_level",
          level: "low"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const results = response.json<{
      results: Array<{
        sessionKey: string;
        status: string;
        startedRuntime?: boolean;
        stoppedRuntime?: boolean;
      }>;
    }>().results;
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: encodeChatKey(runningBinding),
          status: "ok",
          startedRuntime: false,
          stoppedRuntime: false
        }),
        expect.objectContaining({
          sessionKey: encodeChatKey(stoppedBinding),
          status: "ok",
          startedRuntime: true,
          stoppedRuntime: true
        })
      ])
    );
    expect(clients.get("running-user")?.controlCommands).toEqual([{ type: "set_thinking_level", level: "low" }]);
    expect(clients.get("running-user")?.killed).toBe(false);
    expect(clients.get("stopped-group")?.controlCommands).toEqual([{ type: "set_thinking_level", level: "low" }]);
    expect(clients.get("stopped-group")?.killed).toBe(true);
    expect(runtime.activeCount).toBe(1);

    await app.close();
    store.close();
  });

  it("terminates all sessions by clearing stored bindings and workspaces", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const runningBinding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "running-user",
      displayName: "Running User"
    });
    const stoppedBinding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "stopped-user",
      displayName: "Stopped User"
    });
    await writeFile(path.join(runningBinding.sessionDir, "old-running.jsonl"), "{\"type\":\"session\"}\n", "utf8");
    await writeFile(path.join(stoppedBinding.sessionDir, "old-stopped.jsonl"), "{\"type\":\"session\"}\n", "utf8");
    store.markWeComFileProtocol(runningBinding, 1);
    store.markWeComFileProtocol(stoppedBinding, 1);
    const client = new FakeManagedPiClient();
    const runtime = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });
    await runtime.runMessage(runningBinding, "warm runtime");
    const app = createApp(createConfig(dataDir), {
      bindingStore: store,
      runtime,
      queue: new ChatMessageQueue()
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/sessions/terminate",
      payload: {
        scope: "all"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "all",
      results: expect.arrayContaining([
        expect.objectContaining({
          sessionKey: encodeChatKey(runningBinding),
          status: "ok",
          stoppedRuntime: true,
          deletedBinding: true,
          deletedWorkspace: true
        }),
        expect.objectContaining({
          sessionKey: encodeChatKey(stoppedBinding),
          status: "ok",
          stoppedRuntime: false,
          deletedBinding: true,
          deletedWorkspace: true
        })
      ])
    });
    expect(client.killed).toBe(true);
    expect(runtime.activeCount).toBe(0);
    expect(store.listAll()).toEqual([]);
    expect(existsSync(runningBinding.workspacePath)).toBe(false);
    expect(existsSync(stoppedBinding.workspacePath)).toBe(false);

    const listResponse = await app.inject({ method: "GET", url: "/api/admin/sessions" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({ sessions: [] });

    const recreated = store.getOrCreate({
      botId: runningBinding.botId,
      kind: runningBinding.kind,
      externalChatId: runningBinding.externalChatId,
      displayName: "Running User"
    });
    expect(recreated.sessionId).toBe(runningBinding.sessionId);
    expect(existsSync(recreated.sessionDir)).toBe(true);
    expect(existsSync(recreated.inboxDir)).toBe(true);
    expect(store.hasWeComFileProtocol(recreated, 1)).toBe(false);

    await app.close();
    store.close();
  });
});
