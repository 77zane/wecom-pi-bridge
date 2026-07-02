import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SendMsgBody, WeComMediaType } from "@wecom/aibot-node-sdk";
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
import { buildMarkdownReplyChunks, type WeComChatAddress } from "./wecom-message.js";

export interface PiRuntimeRunner {
  runMessage(binding: StoredChatBinding, message: string): Promise<string>;
}

export interface WeComSender {
  sendMessage(chatId: string, body: SendMsgBody): Promise<void>;
  uploadMedia(
    buffer: Buffer,
    options: { readonly type: WeComMediaType; readonly filename: string }
  ): Promise<{ readonly mediaId: string }>;
  sendMediaMessage(chatId: string, type: WeComMediaType, mediaId: string): Promise<void>;
}

export class ConversationDispatcher {
  constructor(
    private readonly bindingStore: BindingStore,
    private readonly queue: ChatMessageQueue,
    private readonly runtime: PiRuntimeRunner,
    private readonly sender: WeComSender
  ) {}

  async runPromptAndReply(address: WeComChatAddress, binding: StoredChatBinding, prompt: string): Promise<void> {
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
    const outboundMediaType: WeComMediaType = "file";
    const uploaded = await this.sender.uploadMedia(buffer, {
      type: outboundMediaType,
      filename: path.basename(filePath)
    });
    await this.sender.sendMediaMessage(chatId, outboundMediaType, uploaded.mediaId);
    logInfo("outbound_file.sent", {
      sessionId: binding.sessionId,
      type: outboundMediaType,
      requestedType: file.type
    });
  }
}
