import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  FileMessage,
  ImageMessage,
  MixedMessage,
  SendMsgBody,
  TextMessage,
  VideoMessage,
  VoiceMessage,
  WeComMediaType
} from "@wecom/aibot-node-sdk";
import { saveAttachment } from "../attachments/attachment-store.js";
import type { BindingStore, StoredChatBinding } from "../bindings/binding-store.js";
import { logInfo, logWarn } from "../logging.js";
import type { ChatMessageQueue } from "../runtime/chat-message-queue.js";
import {
  addWeComFileProtocolInstruction,
  extractWeComFileDirectives,
  resolveOutboundFilePath,
  WECOM_FILE_PROTOCOL_VERSION,
  type WeComFileDirective
} from "./outbound-file-protocol.js";
import {
  buildAttachmentNotification,
  buildMarkdownReplyChunks,
  resolveChatAddress,
  type WeComChatAddress
} from "./wecom-message.js";

export interface WeComSender {
  sendMessage(chatId: string, body: SendMsgBody): Promise<void>;
  uploadMedia(
    buffer: Buffer,
    options: { readonly type: WeComMediaType; readonly filename: string }
  ): Promise<{ readonly mediaId: string }>;
  sendMediaMessage(chatId: string, type: WeComMediaType, mediaId: string): Promise<void>;
}

export interface WeComDownloader {
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

export interface PiRuntimeRunner {
  runMessage(binding: StoredChatBinding, message: string): Promise<string>;
}

export interface WeComBridgeOptions {
  readonly bindingStore: BindingStore;
  readonly queue: ChatMessageQueue;
  readonly runtime: PiRuntimeRunner;
  readonly sender: WeComSender;
  readonly downloader?: WeComDownloader;
  readonly createAttachmentSuffix?: () => string;
}

export class WeComBridge {
  private readonly bindingStore: BindingStore;
  private readonly queue: ChatMessageQueue;
  private readonly runtime: PiRuntimeRunner;
  private readonly sender: WeComSender;
  private readonly downloader: WeComDownloader | undefined;
  private readonly createAttachmentSuffix: () => string;

  constructor(options: WeComBridgeOptions) {
    this.bindingStore = options.bindingStore;
    this.queue = options.queue;
    this.runtime = options.runtime;
    this.sender = options.sender;
    this.downloader = options.downloader;
    this.createAttachmentSuffix = options.createAttachmentSuffix ?? (() => randomUUID().slice(0, 8));
  }

  async handleTextMessage(message: TextMessage): Promise<void> {
    const address = resolveChatAddress(message);
    const binding = this.getBinding(address);

    await this.runAndReply(address, binding, message.text.content);
  }

  async handleFileMessage(message: FileMessage): Promise<void> {
    const address = resolveChatAddress(message);
    const binding = this.getBinding(address);
    const notification = await this.createAttachmentNotification({
      binding,
      messageId: message.msgid,
      url: message.file.url,
      aesKey: message.file.aeskey,
      label: "文件",
      fallbackFilename: "file"
    });

    await this.runAndReply(address, binding, notification);
  }

  async handleImageMessage(message: ImageMessage): Promise<void> {
    const address = resolveChatAddress(message);
    const binding = this.getBinding(address);
    const notification = await this.createAttachmentNotification({
      binding,
      messageId: message.msgid,
      url: message.image.url,
      aesKey: message.image.aeskey,
      label: "图片",
      fallbackFilename: "image"
    });

    await this.runAndReply(address, binding, notification);
  }

  async handleVideoMessage(message: VideoMessage): Promise<void> {
    const address = resolveChatAddress(message);
    const binding = this.getBinding(address);
    const notification = await this.createAttachmentNotification({
      binding,
      messageId: message.msgid,
      url: message.video.url,
      aesKey: message.video.aeskey,
      label: "视频",
      fallbackFilename: "video"
    });

    await this.runAndReply(address, binding, notification);
  }

  async handleVoiceMessage(message: VoiceMessage): Promise<void> {
    const address = resolveChatAddress(message);
    const binding = this.getBinding(address);
    await this.runAndReply(address, binding, message.voice.content);
  }

  async handleMixedMessage(message: MixedMessage): Promise<void> {
    const address = resolveChatAddress(message);
    const binding = this.getBinding(address);
    const prompts: string[] = [];

    for (const item of message.mixed.msg_item) {
      if (item.msgtype === "text" && item.text?.content !== undefined) {
        prompts.push(item.text.content);
      }
      if (item.msgtype === "image" && item.image !== undefined) {
        prompts.push(
          await this.createAttachmentNotification({
            binding,
            messageId: message.msgid,
            url: item.image.url,
            aesKey: item.image.aeskey,
            label: "图片",
            fallbackFilename: "image"
          })
        );
      }
    }

    if (prompts.length === 0) {
      return;
    }

    await this.runAndReply(address, binding, prompts.join("\n\n"));
  }

  private getBinding(address: WeComChatAddress): StoredChatBinding {
    return this.bindingStore.getOrCreate({
      botId: address.botId,
      kind: address.kind,
      externalChatId: address.externalChatId,
      displayName: address.externalChatId
    });
  }

  private async runAndReply(address: WeComChatAddress, binding: StoredChatBinding, prompt: string): Promise<void> {
    logInfo("message.received", {
      chatKind: address.kind,
      sessionId: binding.sessionId
    });

    const replyText = await this.queue.run(binding, async () => {
      const shouldInjectProtocol = !this.bindingStore.hasWeComFileProtocol(binding, WECOM_FILE_PROTOCOL_VERSION);
      const runtimePrompt = shouldInjectProtocol ? addWeComFileProtocolInstruction(prompt) : prompt;
      const reply = await this.runtime.runMessage(binding, runtimePrompt);

      if (shouldInjectProtocol) {
        this.bindingStore.markWeComFileProtocol(binding, WECOM_FILE_PROTOCOL_VERSION);
      }

      return reply;
    });
    const extractedReply = extractWeComFileDirectives(replyText);

    logInfo("pi.reply", {
      chatKind: address.kind,
      sessionId: binding.sessionId,
      outboundFileCount: extractedReply.files.length
    });

    if (extractedReply.text.length > 0) {
      await this.sendMarkdownReply(address, extractedReply.text);
    }

    for (const file of extractedReply.files) {
      await this.sendOutboundFile(address.replyChatId, binding, file);
    }
  }

  private async sendMarkdownReply(address: WeComChatAddress, text: string): Promise<void> {
    const chunks = buildMarkdownReplyChunks({
      chatKind: address.kind,
      mentionUserId: address.senderUserId,
      text
    });

    for (const chunk of chunks) {
      await this.sender.sendMessage(address.replyChatId, {
        msgtype: "markdown",
        markdown: {
          content: chunk
        }
      });
    }
  }

  private async sendOutboundFile(chatId: string, binding: StoredChatBinding, file: WeComFileDirective): Promise<void> {
    const filePath = resolveOutboundFilePath(binding.workspacePath, file.path);
    if (filePath === undefined) {
      logWarn("outbound_file.ignored", {
        sessionId: binding.sessionId,
        reason: "outside_outbox"
      });
      return;
    }

    const buffer = await readFile(filePath);
    const uploaded = await this.sender.uploadMedia(buffer, {
      type: file.type,
      filename: path.basename(filePath)
    });
    await this.sender.sendMediaMessage(chatId, file.type, uploaded.mediaId);
    logInfo("outbound_file.sent", {
      sessionId: binding.sessionId,
      type: file.type
    });
  }

  private async createAttachmentNotification(options: {
    readonly binding: StoredChatBinding;
    readonly messageId: string;
    readonly url: string;
    readonly aesKey?: string | undefined;
    readonly label: string;
    readonly fallbackFilename: string;
  }): Promise<string> {
    if (this.downloader === undefined) {
      throw new Error("WeCom downloader is required to handle attachment messages");
    }

    const downloaded = await this.downloader.downloadFile(options.url, options.aesKey);
    const originalFilename = downloaded.filename ?? options.fallbackFilename;
    const saved = await saveAttachment({
      inboxDir: options.binding.inboxDir,
      messageId: options.messageId,
      originalFilename,
      fallbackFilename: options.fallbackFilename,
      buffer: downloaded.buffer,
      suffix: this.createAttachmentSuffix()
    });

    logInfo("attachment.saved", {
      sessionId: options.binding.sessionId,
      messageId: options.messageId
    });

    return buildAttachmentNotification({
      label: options.label,
      filename: originalFilename,
      relativePath: saved.relativePath
    });
  }
}
