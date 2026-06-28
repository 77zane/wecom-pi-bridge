import { describe, expect, it } from "vitest";
import type { StoredChatBinding } from "../src/server/bindings/binding-store.js";
import type {
  PiRpcDelivery,
  PiRpcShutdownResult,
  PiRpcState
} from "../src/server/pi/pi-rpc-client.js";
import {
  RuntimeManager,
  type ManagedPiClient
} from "../src/server/runtime/runtime-manager.js";

class FakeManagedPiClient implements ManagedPiClient {
  readonly pid = 1234;
  readonly deliveredMessages: string[] = [];
  readonly shutdownGracePeriods: number[] = [];
  private readonly exitListeners = new Set<() => void>();
  killed = false;
  runError: Error | undefined;
  runPromise: Promise<string> | undefined;
  shutdownPromise: Promise<PiRpcShutdownResult> | undefined;
  stateError: Error | undefined;
  state: PiRpcState = {
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    sessionId: "s-test",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0
  };

  async getState(): Promise<PiRpcState> {
    if (this.stateError !== undefined) {
      throw this.stateError;
    }

    return this.state;
  }

  async deliverUserMessage(message: string): Promise<PiRpcDelivery> {
    this.deliveredMessages.push(message);
    return "prompt";
  }

  async runUserMessage(message: string): Promise<string> {
    if (this.runError !== undefined) {
      throw this.runError;
    }

    this.deliveredMessages.push(message);
    if (this.runPromise !== undefined) {
      return this.runPromise;
    }

    return `reply:${message}`;
  }

  async shutdown(gracePeriodMs?: number): Promise<PiRpcShutdownResult> {
    this.shutdownGracePeriods.push(gracePeriodMs ?? 0);
    this.killed = true;
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }

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

  emitExit(): void {
    for (const listener of this.exitListeners) {
      listener();
    }
  }
}

function createBinding(id: string): StoredChatBinding {
  return {
    botId: "bot-a",
    kind: "single",
    externalChatId: id,
    workspacePath: `C:\\data\\${id}`,
    sessionId: `s-${id}`,
    sessionDir: `C:\\data\\${id}\\.pi-sessions`,
    inboxDir: `C:\\data\\${id}\\inbox`
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: (value: T) => void = () => {};
  let rejectDeferred: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });

  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RuntimeManager", () => {
  it("reuses the live Pi client for the same binding", async () => {
    const client = new FakeManagedPiClient();
    let created = 0;
    const manager = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => {
        created += 1;
        return client;
      }
    });

    const binding = createBinding("user-a");
    await manager.deliver(binding, "first");
    await manager.deliver(binding, "second");

    expect(created).toBe(1);
    expect(client.deliveredMessages).toEqual(["first", "second"]);
    expect(manager.activeCount).toBe(1);
  });

  it("can run a message and return Pi final text", async () => {
    const client = new FakeManagedPiClient();
    const manager = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });

    await expect(manager.runMessage(createBinding("user-a"), "hello")).resolves.toBe("reply:hello");
  });

  it("drops a failed client so the next message can create a fresh process", async () => {
    const first = new FakeManagedPiClient();
    first.runError = new Error("Pi RPC process exited");
    const second = new FakeManagedPiClient();
    const clients = [first, second];
    const manager = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => {
        const client = clients.shift();
        if (client === undefined) {
          throw new Error("missing fake client");
        }
        return client;
      }
    });

    const binding = createBinding("user-a");
    await expect(manager.runMessage(binding, "first")).rejects.toThrow("Pi RPC process exited");
    expect(first.killed).toBe(true);
    expect(manager.activeCount).toBe(0);

    await expect(manager.runMessage(binding, "second")).resolves.toBe("reply:second");
    expect(second.deliveredMessages).toEqual(["second"]);
    expect(manager.activeCount).toBe(1);
  });

  it("gracefully shuts down an idle client when process capacity is needed", async () => {
    let now = 0;
    const first = new FakeManagedPiClient();
    const second = new FakeManagedPiClient();
    const clients = [first, second];
    const manager = new RuntimeManager({
      maxProcesses: 1,
      idleTimeoutMs: 1_000,
      now: () => now,
      clientFactory: async () => {
        const client = clients.shift();
        if (client === undefined) {
          throw new Error("missing fake client");
        }
        return client;
      }
    });

    await manager.deliver(createBinding("user-a"), "first");
    now = 2_000;
    await manager.deliver(createBinding("user-b"), "second");

    expect(first.killed).toBe(true);
    expect(first.shutdownGracePeriods).toEqual([60_000]);
    expect(second.deliveredMessages).toEqual(["second"]);
    expect(manager.activeCount).toBe(1);
  });

  it("does not kill a client that is still streaming", async () => {
    let now = 0;
    const first = new FakeManagedPiClient();
    first.state = {
      ...first.state,
      isStreaming: true
    };
    const manager = new RuntimeManager({
      maxProcesses: 1,
      idleTimeoutMs: 1_000,
      now: () => now,
      clientFactory: async () => first
    });

    await manager.deliver(createBinding("user-a"), "first");
    now = 2_000;

    await expect(manager.deliver(createBinding("user-b"), "second")).rejects.toThrow("Pi process limit reached");
    expect(first.killed).toBe(false);
    expect(manager.activeCount).toBe(1);
  });

  it("starts idle time after Pi finishes replying and skips active operations", async () => {
    let now = 0;
    const client = new FakeManagedPiClient();
    const reply = createDeferred<string>();
    client.runPromise = reply.promise;
    const manager = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 1_000,
      now: () => now,
      clientFactory: async () => client
    });

    const runPromise = manager.runMessage(createBinding("user-a"), "slow");
    await flushPromises();
    expect(client.deliveredMessages).toEqual(["slow"]);

    now = 2_000;
    await expect(manager.reapIdle()).resolves.toBe(0);
    expect(client.killed).toBe(false);

    reply.resolve("done");
    await expect(runPromise).resolves.toBe("done");

    now = 2_500;
    await expect(manager.reapIdle()).resolves.toBe(0);
    expect(client.killed).toBe(false);

    now = 3_100;
    await expect(manager.reapIdle()).resolves.toBe(1);
    expect(client.killed).toBe(true);
  });

  it("does not kill a client when get_state fails", async () => {
    let now = 0;
    const first = new FakeManagedPiClient();
    first.stateError = new Error("state timeout");
    const manager = new RuntimeManager({
      maxProcesses: 1,
      idleTimeoutMs: 1_000,
      now: () => now,
      clientFactory: async () => first
    });

    await manager.deliver(createBinding("user-a"), "first");
    now = 2_000;

    await expect(manager.deliver(createBinding("user-b"), "second")).rejects.toThrow("Pi process limit reached");
    expect(first.killed).toBe(false);
    expect(manager.activeCount).toBe(1);
  });

  it("gracefully shuts down and clears all live clients on shutdown", async () => {
    const first = new FakeManagedPiClient();
    const second = new FakeManagedPiClient();
    const clients = [first, second];
    const manager = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => {
        const client = clients.shift();
        if (client === undefined) {
          throw new Error("missing fake client");
        }
        return client;
      }
    });

    await manager.runMessage(createBinding("user-a"), "first");
    await manager.runMessage(createBinding("user-b"), "second");

    expect(manager.activeCount).toBe(2);
    await expect(manager.shutdown()).resolves.toBe(2);

    expect(first.killed).toBe(true);
    expect(second.killed).toBe(true);
    expect(first.shutdownGracePeriods).toEqual([60_000]);
    expect(second.shutdownGracePeriods).toEqual([60_000]);
    expect(manager.activeCount).toBe(0);
  });

  it("starts all live client shutdowns concurrently", async () => {
    const first = new FakeManagedPiClient();
    const second = new FakeManagedPiClient();
    const firstShutdown = createDeferred<PiRpcShutdownResult>();
    const secondShutdown = createDeferred<PiRpcShutdownResult>();
    first.shutdownPromise = firstShutdown.promise;
    second.shutdownPromise = secondShutdown.promise;
    const clients = [first, second];
    const manager = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => {
        const client = clients.shift();
        if (client === undefined) {
          throw new Error("missing fake client");
        }
        return client;
      }
    });

    await manager.runMessage(createBinding("user-a"), "first");
    await manager.runMessage(createBinding("user-b"), "second");

    const shutdownPromise = manager.shutdown();
    await flushPromises();

    expect(first.shutdownGracePeriods).toEqual([60_000]);
    expect(second.shutdownGracePeriods).toEqual([60_000]);

    firstShutdown.resolve("exited");
    secondShutdown.resolve("exited");

    await expect(shutdownPromise).resolves.toBe(2);
    expect(manager.activeCount).toBe(0);
  });

  it("removes a client when the underlying Pi process exits", async () => {
    const client = new FakeManagedPiClient();
    const manager = new RuntimeManager({
      maxProcesses: 50,
      idleTimeoutMs: 30 * 60 * 1000,
      clientFactory: async () => client
    });

    await manager.runMessage(createBinding("user-a"), "first");
    expect(manager.activeCount).toBe(1);

    client.emitExit();

    expect(manager.activeCount).toBe(0);
  });
});
