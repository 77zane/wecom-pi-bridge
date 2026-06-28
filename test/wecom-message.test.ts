import { describe, expect, it } from "vitest";
import { MessageType, type BaseMessage, type TextMessage } from "@wecom/aibot-node-sdk";
import {
  buildAttachmentNotification,
  buildMarkdownReplyChunks,
  resolveChatAddress,
  splitUtf8
} from "../src/server/wecom/wecom-message.js";

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

describe("wecom message helpers", () => {
  it("maps single chats to the sender workspace and reply target", () => {
    const address = resolveChatAddress(createTextMessage());

    expect(address).toEqual({
      botId: "bot-a",
      kind: "single",
      externalChatId: "user-a",
      senderUserId: "user-a",
      replyChatId: "user-a"
    });
  });

  it("maps group chats to the group workspace and keeps original sender for mentions", () => {
    const address = resolveChatAddress(
      createTextMessage({
        chattype: "group",
        chatid: "group-a",
        from: {
          userid: "user-b"
        }
      })
    );

    expect(address).toEqual({
      botId: "bot-a",
      kind: "group",
      externalChatId: "group-a",
      senderUserId: "user-b",
      replyChatId: "group-a"
    });
  });

  it("rejects group messages without chatid", () => {
    const message: BaseMessage = {
      msgid: "msg-1",
      aibotid: "bot-a",
      chattype: "group",
      from: {
        userid: "user-a"
      },
      msgtype: "text"
    };

    expect(() => resolveChatAddress(message)).toThrow("Group message is missing chatid");
  });

  it("splits utf8 text by byte length without breaking multibyte characters", () => {
    expect(splitUtf8("你好abc", 6)).toEqual(["你好", "abc"]);
  });

  it("adds group mentions and segment markers when replies are split", () => {
    const chunks = buildMarkdownReplyChunks({
      chatKind: "group",
      mentionUserId: "user-a",
      text: "字".repeat(40),
      maxBytes: 80
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("<@user-a>");
    expect(chunks[0]).toContain("[1/");
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 80)).toBe(true);
  });

  it("keeps short single-chat replies unchanged", () => {
    expect(
      buildMarkdownReplyChunks({
        chatKind: "single",
        mentionUserId: "user-a",
        text: "short reply",
        maxBytes: 80
      })
    ).toEqual(["short reply"]);
  });

  it("builds the exact attachment notification sent to Pi", () => {
    expect(
      buildAttachmentNotification({
        label: "文件",
        filename: "report.pdf",
        relativePath: "inbox/msg-1/report-abc.pdf"
      })
    ).toBe(
      "用户发送了文件：report.pdf\n文件路径：inbox/msg-1/report-abc.pdf\n请根据用户之前的指令或者根据后续用户的指令做出行动。"
    );
  });
});
