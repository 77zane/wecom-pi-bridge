import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BindingStore } from "../src/server/bindings/binding-store.js";

const tempDirs: string[] = [];
const stores: BindingStore[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-pi-bridge-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("BindingStore", () => {
  it("creates and reuses a single-chat workspace/session binding", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);

    const first = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      displayName: "User A"
    });
    const second = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      displayName: "Renamed User"
    });

    expect(second).toEqual(first);
    expect(first.workspacePath).toBe(path.join(dataDir, "workspaces", "wecom", "bot-a", "single", "user-a"));
    expect(first.sessionDir).toBe(path.join(first.workspacePath, ".pi-sessions"));
    expect(first.inboxDir).toBe(path.join(first.workspacePath, "inbox"));
    expect(first.sessionId).toMatch(/^s-[0-9a-f]{32}$/);
  });

  it("keeps group chats isolated from single chats", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);

    const single = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "shared-id",
      displayName: "User"
    });
    const group = store.getOrCreate({
      botId: "bot-a",
      kind: "group",
      externalChatId: "shared-id",
      displayName: "Group"
    });

    expect(group.workspacePath).toBe(path.join(dataDir, "workspaces", "wecom", "bot-a", "group", "shared-id"));
    expect(group.sessionId).not.toBe(single.sessionId);
  });

  it("sanitizes workspace path segments without changing the stable chat identity", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);

    const binding = store.getOrCreate({
      botId: "bot/a",
      kind: "single",
      externalChatId: "..\\user/a",
      displayName: "Unsafe"
    });

    expect(binding.workspacePath).toBe(
      path.join(dataDir, "workspaces", "wecom", "bot_a", "single", "_user_a")
    );
    expect(binding.externalChatId).toBe("..\\user/a");
  });

  it("persists the WeCom file protocol injection version per binding", async () => {
    const dataDir = await createTempDir();
    const dbPath = path.join(dataDir, "app.db");
    const store = new BindingStore(dbPath, dataDir);
    stores.push(store);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      displayName: "User A"
    });

    expect(store.hasWeComFileProtocol(binding, 1)).toBe(false);
    store.markWeComFileProtocol(binding, 1);
    expect(store.hasWeComFileProtocol(binding, 1)).toBe(true);
    expect(store.hasWeComFileProtocol(binding, 2)).toBe(false);
  });
});
