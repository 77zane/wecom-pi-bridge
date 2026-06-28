import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listSessionSummaries,
  readSessionFile
} from "../src/server/sessions/session-reader.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-pi-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("session reader", () => {
  it("reads a Pi JSONL session into raw entries and a summary", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "2026-06-27T01-02-03_s-abc.jsonl");
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: "session", id: "s-abc", name: "Test Session" }),
        JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "hi" } }),
        ""
      ].join("\n"),
      "utf8"
    );

    const session = await readSessionFile(filePath);

    expect(session.summary).toMatchObject({
      id: "s-abc",
      name: "Test Session",
      filePath,
      messageCount: 2
    });
    expect(session.entries).toHaveLength(3);
    expect(session.messages.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
  });

  it("lists session summaries from a session directory", async () => {
    const dir = await createTempDir();
    await writeFile(path.join(dir, "one.jsonl"), `${JSON.stringify({ type: "session", id: "one" })}\n`, "utf8");
    await writeFile(path.join(dir, "two.jsonl"), `${JSON.stringify({ type: "session", id: "two", name: "Two" })}\n`, "utf8");
    await writeFile(path.join(dir, "ignore.txt"), "ignored", "utf8");

    const summaries = await listSessionSummaries(dir);

    expect(summaries.map((summary) => summary.id).sort()).toEqual(["one", "two"]);
    expect(summaries.find((summary) => summary.id === "two")?.name).toBe("Two");
  });

  it("reports the line number for invalid JSONL", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "bad.jsonl");
    await writeFile(filePath, `${JSON.stringify({ type: "session", id: "bad" })}\n{bad json}\n`, "utf8");

    await expect(readSessionFile(filePath)).rejects.toThrow("Invalid session JSONL at line 2");
  });
});

