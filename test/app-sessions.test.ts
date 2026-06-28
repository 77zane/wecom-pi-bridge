import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import {
  BindingStore,
  encodeChatKey
} from "../src/server/bindings/binding-store.js";
import type { AppConfig } from "../src/server/config.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-pi-app-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

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

describe("session API", () => {
  it("lists chats with Pi-owned session summaries and reads a selected session", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      displayName: "User A"
    });
    store.close();

    const sessionPath = path.join(binding.sessionDir, "session.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "session", id: binding.sessionId, name: "User A Session" }),
        JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hello" } })
      ].join("\n"),
      "utf8"
    );

    const app = createApp(createConfig(dataDir));
    const listResponse = await app.inject({ method: "GET", url: "/api/chats" });
    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json<{
      chats: Array<{
        chatKey: string;
        sessions: Array<{ id: string; name: string | null }>;
      }>;
    }>();

    expect(listBody.chats).toHaveLength(1);
    expect(listBody.chats[0]?.sessions).toEqual([
      expect.objectContaining({
        id: binding.sessionId,
        name: "User A Session"
      })
    ]);

    const chatKey = listBody.chats[0]?.chatKey;
    expect(chatKey).toBeDefined();
    const readResponse = await app.inject({
      method: "GET",
      url: `/api/session?chatKey=${encodeURIComponent(chatKey ?? "")}&sessionId=${encodeURIComponent(binding.sessionId)}`
    });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json<{ session: { messages: unknown[] } }>().session.messages).toHaveLength(1);
    await app.close();
  });

  it("reads group sessions through the query API without depending on path parameter matching", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    const binding = store.getOrCreate({
      botId: "bot-a",
      kind: "group",
      externalChatId: "group-chat-with-url-safe-key",
      displayName: "Group A"
    });
    store.close();

    await writeFile(
      path.join(binding.sessionDir, "group.jsonl"),
      [
        JSON.stringify({ type: "session", id: binding.sessionId, name: "Group Session" }),
        JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hello" } })
      ].join("\n"),
      "utf8"
    );

    const app = createApp(createConfig(dataDir));
    const readResponse = await app.inject({
      method: "GET",
      url: `/api/session?chatKey=${encodeURIComponent(encodeChatKey(binding))}&sessionId=${encodeURIComponent(binding.sessionId)}`
    });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json<{ session: { summary: { name: string | null } } }>().session.summary.name).toBe(
      "Group Session"
    );
    await app.close();
  });
});
