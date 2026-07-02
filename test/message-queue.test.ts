import { describe, expect, it } from "vitest";
import type { StoredChatBinding } from "../src/server/bindings/binding-store.js";
import { ChatMessageQueue } from "../src/server/runtime/chat-message-queue.js";

function createBinding(id: string): StoredChatBinding {
  return {
    botId: "bot-a",
    kind: "single",
    externalChatId: id,
    workspacePath: `C:\\data\\${id}`,
    sessionId: `s-${id}`,
    sessionDir: `C:\\data\\${id}\\.pi-sessions`,
    inboxDir: `C:\\data\\${id}\\inbox`,
    protectedRuntime: false
  };
}

function createDeferred(): {
  readonly promise: Promise<string>;
  resolve(value: string): void;
} {
  let resolvePromise: (value: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise
  };
}

describe("ChatMessageQueue", () => {
  it("serializes tasks for the same chat", async () => {
    const queue = new ChatMessageQueue();
    const first = createDeferred();
    const second = createDeferred();
    const starts: string[] = [];
    const binding = createBinding("user-a");

    const firstRun = queue.run(binding, () => {
      starts.push("first");
      return first.promise;
    });
    const secondRun = queue.run(binding, () => {
      starts.push("second");
      return second.promise;
    });

    await Promise.resolve();
    expect(starts).toEqual(["first"]);
    first.resolve("one");
    await expect(firstRun).resolves.toBe("one");
    await Promise.resolve();
    expect(starts).toEqual(["first", "second"]);
    second.resolve("two");
    await expect(secondRun).resolves.toBe("two");
  });

  it("runs different chats independently", async () => {
    const queue = new ChatMessageQueue();
    const starts: string[] = [];

    await Promise.all([
      queue.run(createBinding("user-a"), async () => {
        starts.push("a");
        return "a";
      }),
      queue.run(createBinding("user-b"), async () => {
        starts.push("b");
        return "b";
      })
    ]);

    expect(starts.sort()).toEqual(["a", "b"]);
  });
});
