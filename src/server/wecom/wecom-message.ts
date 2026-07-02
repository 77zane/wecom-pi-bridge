import type { BaseMessage } from "@wecom/aibot-node-sdk";
import type { ChatKind } from "../../shared/contracts.js";

export const DEFAULT_REPLY_MAX_BYTES = 1_800;

export interface WeComChatAddress {
  readonly botId: string;
  readonly kind: ChatKind;
  readonly externalChatId: string;
  readonly senderUserId?: string | undefined;
  readonly replyChatId: string;
}

export interface ReplyChunkOptions {
  readonly chatKind: ChatKind;
  readonly mentionUserId?: string | undefined;
  readonly text: string;
  readonly maxBytes?: number;
}

export interface AttachmentNotificationOptions {
  readonly label: string;
  readonly filename: string;
  readonly relativePath: string;
}

export function resolveChatAddress(message: BaseMessage): WeComChatAddress {
  if (message.chattype === "single") {
    return {
      botId: message.aibotid,
      kind: "single",
      externalChatId: message.from.userid,
      senderUserId: message.from.userid,
      replyChatId: message.from.userid
    };
  }

  if (message.chatid === undefined || message.chatid.length === 0) {
    throw new Error("Group message is missing chatid");
  }

  return {
    botId: message.aibotid,
    kind: "group",
    externalChatId: message.chatid,
    senderUserId: message.from.userid,
    replyChatId: message.chatid
  };
}

export function buildMarkdownReplyChunks(options: ReplyChunkOptions): string[] {
  const maxBytes = options.maxBytes ?? DEFAULT_REPLY_MAX_BYTES;
  const mentionPrefix = options.chatKind === "group" && options.mentionUserId !== undefined && options.mentionUserId.length > 0
    ? `<@${options.mentionUserId}>\n`
    : "";

  if (Buffer.byteLength(`${mentionPrefix}${options.text}`, "utf8") <= maxBytes) {
    return [`${mentionPrefix}${options.text}`];
  }

  let chunkCountGuess = 1;
  let contentChunks: string[] = [];

  while (true) {
    const segmentReserve = Buffer.byteLength(`${mentionPrefix}[${chunkCountGuess}/${chunkCountGuess}]\n`, "utf8");
    const bodyLimit = maxBytes - segmentReserve;
    if (bodyLimit < 8) {
      throw new Error("Reply byte limit is too small for segment headers");
    }

    contentChunks = splitUtf8(options.text, bodyLimit);
    if (contentChunks.length === chunkCountGuess) {
      break;
    }

    chunkCountGuess = contentChunks.length;
  }

  return contentChunks.map((chunk, index) => `${mentionPrefix}[${index + 1}/${contentChunks.length}]\n${chunk}`);
}

export function splitUtf8(text: string, maxBytes: number): string[] {
  if (maxBytes < 1) {
    throw new Error("maxBytes must be at least 1");
  }

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (characterBytes > maxBytes) {
      throw new Error("Single character exceeds maxBytes");
    }

    if (currentBytes + characterBytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }

    current += character;
    currentBytes += characterBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [""];
}

export function buildAttachmentNotification(options: AttachmentNotificationOptions): string {
  return `用户发送了${options.label}：${options.filename}\n文件路径：${options.relativePath}\n请根据用户之前的指令或者根据后续用户的指令做出行动。`;
}
