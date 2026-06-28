import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  saveAttachment,
  sanitizeOriginalFilename
} from "../src/server/attachments/attachment-store.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-pi-attachment-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("attachment store", () => {
  it("preserves the original filename and appends a suffix before the extension", async () => {
    const dir = await createTempDir();

    const saved = await saveAttachment({
      inboxDir: path.join(dir, "inbox"),
      messageId: "msg-1",
      originalFilename: "report.pdf",
      buffer: Buffer.from("pdf"),
      suffix: "abc"
    });

    expect(saved.absolutePath).toBe(path.join(dir, "inbox", "msg-1", "report-abc.pdf"));
    expect(saved.relativePath).toBe("inbox/msg-1/report-abc.pdf");
    await expect(readFile(saved.absolutePath, "utf8")).resolves.toBe("pdf");
  });

  it("sanitizes path separators and reserved filename characters", () => {
    expect(sanitizeOriginalFilename("../unsafe:name?.pdf")).toBe("unsafe_name_.pdf");
    expect(sanitizeOriginalFilename("..\\nested\\image.png")).toBe("image.png");
  });

  it("uses a fallback filename when WeCom does not provide one", async () => {
    const dir = await createTempDir();

    const saved = await saveAttachment({
      inboxDir: path.join(dir, "inbox"),
      messageId: "msg-2",
      originalFilename: undefined,
      fallbackFilename: "image.jpg",
      buffer: Buffer.from("image"),
      suffix: "xyz"
    });

    expect(saved.relativePath).toBe("inbox/msg-2/image-xyz.jpg");
  });
});

