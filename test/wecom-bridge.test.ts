import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MessageType,
  type FileMessage,
  type ImageMessage,
  type MixedMessage,
  type SendMsgBody,
  type TextMessage,
  type WeComMediaType
} from "@wecom/aibot-node-sdk";
import { BindingStore, type StoredChatBinding } from "../src/server/bindings/binding-store.js";
import { ChatMessageQueue } from "../src/server/runtime/chat-message-queue.js";
import {
  WeComBridge,
  type PiRuntimeRunner,
  type WeComDownloader,
  type WeComSender
} from "../src/server/wecom/wecom-bridge.js";

const tempDirs: string[] = [];
const stores: BindingStore[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-pi-bridge-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

class FakeRuntime implements PiRuntimeRunner {
  readonly messages: Array<{ binding: StoredChatBinding; message: string }> = [];
  reply = "Pi reply";

  async runMessage(binding: StoredChatBinding, message: string): Promise<string> {
    this.messages.push({ binding, message });
    return this.reply;
  }
}

class FakeSender implements WeComSender {
  readonly sent: Array<{ chatId: string; body: SendMsgBody }> = [];
  readonly uploads: Array<{ buffer: Buffer; type: WeComMediaType; filename: string }> = [];
  readonly mediaMessages: Array<{ chatId: string; type: WeComMediaType; mediaId: string }> = [];

  async sendMessage(chatId: string, body: SendMsgBody): Promise<void> {
    this.sent.push({ chatId, body });
  }

  async uploadMedia(
    buffer: Buffer,
    options: { readonly type: WeComMediaType; readonly filename: string }
  ): Promise<{ readonly mediaId: string }> {
    this.uploads.push({
      buffer,
      type: options.type,
      filename: options.filename
    });
    return { mediaId: `media-${this.uploads.length}` };
  }

  async sendMediaMessage(chatId: string, type: WeComMediaType, mediaId: string): Promise<void> {
    this.mediaMessages.push({ chatId, type, mediaId });
  }
}

class FakeDownloader implements WeComDownloader {
  async downloadFile(): Promise<{ buffer: Buffer; filename?: string }> {
    return {
      buffer: Buffer.from("file content"),
      filename: "report.pdf"
    };
  }
}

function createTextMessage(overrides: Partial<TextMessage> = {}): TextMessage {
  return {
    msgid: "msg-1",
    aibotid: "bot-a",
    chattype: "single",
    from: {
      userid: "user-a"
    },
    msgtype: MessageType.Text,
    text: {
      content: "hello"
    },
    ...overrides
  };
}

function createFileMessage(overrides: Partial<FileMessage> = {}): FileMessage {
  return {
    msgid: "msg-file",
    aibotid: "bot-a",
    chattype: "single",
    from: {
      userid: "user-a"
    },
    msgtype: MessageType.File,
    file: {
      url: "https://example.test/file",
      aeskey: "secret"
    },
    ...overrides
  };
}

function createImageMessage(overrides: Partial<ImageMessage> = {}): ImageMessage {
  return {
    msgid: "msg-image",
    aibotid: "bot-a",
    chattype: "single",
    from: {
      userid: "user-a"
    },
    msgtype: MessageType.Image,
    image: {
      url: "https://example.test/image",
      aeskey: "secret"
    },
    ...overrides
  };
}

function createMixedMessage(overrides: Partial<MixedMessage> = {}): MixedMessage {
  return {
    msgid: "msg-mixed",
    aibotid: "bot-a",
    chattype: "single",
    from: {
      userid: "user-a"
    },
    msgtype: MessageType.Mixed,
    mixed: {
      msg_item: [
        {
          msgtype: "text",
          text: {
            content: "please inspect"
          }
        },
        {
          msgtype: "image",
          image: {
            url: "https://example.test/image",
            aeskey: "secret"
          }
        }
      ]
    },
    ...overrides
  };
}

function createBridge(options: {
  readonly store: BindingStore;
  readonly runtime: FakeRuntime;
  readonly sender: FakeSender;
  readonly downloader?: WeComDownloader;
  readonly createAttachmentSuffix?: () => string;
}): WeComBridge {
  const bridgeOptions = {
    bindingStore: options.store,
    queue: new ChatMessageQueue(),
    runtime: options.runtime,
    sender: options.sender,
    downloader: options.downloader ?? new FakeDownloader()
  };

  if (options.createAttachmentSuffix === undefined) {
    return new WeComBridge(bridgeOptions);
  }

  return new WeComBridge({
    ...bridgeOptions,
    createAttachmentSuffix: options.createAttachmentSuffix
  });
}

describe("WeComBridge", () => {
  it("runs single-chat text through Pi and sends markdown back to the sender", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);
    const runtime = new FakeRuntime();
    const sender = new FakeSender();
    const bridge = createBridge({ store, runtime, sender });

    await bridge.handleTextMessage(createTextMessage());

    expect(runtime.messages[0]?.message).toBe("hello");
    expect(runtime.messages[0]?.binding.workspacePath).toContain(path.join("single", "user-a"));
    expect(sender.sent).toEqual([
      {
        chatId: "user-a",
        body: {
          msgtype: "markdown",
          markdown: {
            content: "Pi reply"
          }
        }
      }
    ]);
  });

  it("forwards text prompts without injecting the file protocol", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);
    const runtime = new FakeRuntime();
    const sender = new FakeSender();
    const bridge = createBridge({ store, runtime, sender });

    await bridge.handleTextMessage(createTextMessage({ text: { content: "first" } }));
    await bridge.handleTextMessage(createTextMessage({ text: { content: "second" } }));

    expect(runtime.messages[0]?.message).toBe("first");
    expect(runtime.messages[1]?.message).toBe("second");
  });

  it("mentions the original sender when replying in a group", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);
    const runtime = new FakeRuntime();
    const sender = new FakeSender();
    const bridge = createBridge({ store, runtime, sender });

    await bridge.handleTextMessage(
      createTextMessage({
        chattype: "group",
        chatid: "group-a",
        from: {
          userid: "user-b"
        }
      })
    );

    expect(runtime.messages[0]?.binding.workspacePath).toContain(path.join("group", "group-a"));
    expect(sender.sent[0]?.chatId).toBe("group-a");
    expect(sender.sent[0]?.body).toEqual({
      msgtype: "markdown",
      markdown: {
        content: "<@user-b>\nPi reply"
      }
    });
  });

  it("stores incoming files in the binding inbox and forwards only a path notification to Pi", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);
    const runtime = new FakeRuntime();
    const sender = new FakeSender();
    const bridge = createBridge({
      store,
      runtime,
      sender,
      createAttachmentSuffix: () => "abc"
    });

    await bridge.handleFileMessage(createFileMessage());

    expect(runtime.messages[0]?.message).toContain(
      "用户发送了文件：report.pdf\n文件路径：inbox/msg-file/report-abc.pdf\n请根据用户之前的指令或者根据后续用户的指令做出行动。"
    );
    expect(sender.sent[0]?.body).toEqual({
      msgtype: "markdown",
      markdown: {
        content: "Pi reply"
      }
    });
  });

  it("stores incoming images with an image fallback filename", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);
    const runtime = new FakeRuntime();
    const sender = new FakeSender();
    const bridge = createBridge({
      store,
      runtime,
      sender,
      downloader: {
        async downloadFile() {
          return {
            buffer: Buffer.from("image")
          };
        }
      },
      createAttachmentSuffix: () => "img"
    });

    await bridge.handleImageMessage(createImageMessage());

    expect(runtime.messages[0]?.message).toContain(
      "用户发送了图片：image\n文件路径：inbox/msg-image/image-img\n请根据用户之前的指令或者根据后续用户的指令做出行动。"
    );
  });

  it("combines mixed text and image items into one Pi input", async () => {
    const dataDir = await createTempDir();
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);
    const runtime = new FakeRuntime();
    const sender = new FakeSender();
    const bridge = createBridge({
      store,
      runtime,
      sender,
      createAttachmentSuffix: () => "abc"
    });

    await bridge.handleMixedMessage(createMixedMessage());

    expect(runtime.messages[0]?.message).toContain(
      "please inspect\n\n用户发送了图片：report.pdf\n文件路径：inbox/msg-mixed/report-abc.pdf\n请根据用户之前的指令或者根据后续用户的指令做出行动。"
    );
  });

  it("uploads files requested by Pi and forwards Pi user-facing text without the machine directive", async () => {
    const dataDir = await createTempDir();
    const workspacePath = path.join(dataDir, "workspaces", "wecom", "bot-a", "single", "user-a");
    const outboxPath = path.join(workspacePath, "outbox");
    const filePath = path.join(outboxPath, "report.txt");
    await mkdir(outboxPath, { recursive: true });
    await writeFile(filePath, "report content", "utf8");
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);
    const runtime = new FakeRuntime();
    runtime.reply = [
      "文件已发送，请查收。",
      "```json",
      '{"wecom_files":[{"path":"outbox/report.txt","type":"file"}]}',
      "```"
    ].join("\n");
    const sender = new FakeSender();
    const bridge = createBridge({ store, runtime, sender });

    await bridge.handleTextMessage(createTextMessage());

    expect(sender.sent).toEqual([
      {
        chatId: "user-a",
        body: {
          msgtype: "markdown",
          markdown: {
            content: "文件已发送，请查收。"
          }
        }
      }
    ]);
    expect(sender.uploads).toHaveLength(1);
    expect(sender.uploads[0]?.buffer.toString("utf8")).toBe("report content");
    expect(sender.uploads[0]?.type).toBe("file");
    expect(sender.uploads[0]?.filename).toBe("report.txt");
    expect(sender.mediaMessages).toEqual([
      {
        chatId: "user-a",
        type: "file",
        mediaId: "media-1"
      }
    ]);
  });

  it("sends legacy non-file Pi directives as ordinary files", async () => {
    const dataDir = await createTempDir();
    const workspacePath = path.join(dataDir, "workspaces", "wecom", "bot-a", "single", "user-a");
    const outboxPath = path.join(workspacePath, "outbox");
    const filePath = path.join(outboxPath, "clip.mp4");
    await mkdir(outboxPath, { recursive: true });
    await writeFile(filePath, "video content", "utf8");
    const store = new BindingStore(path.join(dataDir, "app.db"), dataDir);
    stores.push(store);
    const runtime = new FakeRuntime();
    runtime.reply = '视频已发送，请查收。 {"wecom_files":[{"path":"outbox/clip.mp4","type":"video"}]}';
    const sender = new FakeSender();
    const bridge = createBridge({ store, runtime, sender });

    await bridge.handleTextMessage(createTextMessage());

    expect(sender.uploads).toHaveLength(1);
    expect(sender.uploads[0]?.type).toBe("file");
    expect(sender.uploads[0]?.filename).toBe("clip.mp4");
    expect(sender.mediaMessages).toEqual([
      {
        chatId: "user-a",
        type: "file",
        mediaId: "media-1"
      }
    ]);
  });
});
