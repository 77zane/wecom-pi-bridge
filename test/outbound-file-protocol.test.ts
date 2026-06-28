import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addWeComFileProtocolInstruction,
  extractWeComFileDirectives,
  resolveOutboundFilePath
} from "../src/server/wecom/outbound-file-protocol.js";

describe("outbound file protocol", () => {
  it("adds the file protocol instruction before the first user message", () => {
    const prompt = addWeComFileProtocolInstruction("请生成报表");

    expect(prompt).toContain("平台能力说明");
    expect(prompt).toContain("不要在面向用户的回复里暴露 outbox、inbox 或本地文件路径");
    expect(prompt).toContain('{"wecom_files":[{"path":"outbox/文件名","type":"file"}]}');
    expect(prompt.endsWith("请生成报表")).toBe(true);
  });

  it("extracts a fenced file directive and removes it from reply text", () => {
    const reply = [
      "文件已发送，请查收。",
      "```json",
      '{"wecom_files":[{"path":"outbox/report.xlsx","type":"file"}]}',
      "```"
    ].join("\n");

    expect(extractWeComFileDirectives(reply)).toEqual({
      text: "文件已发送，请查收。",
      files: [
        {
          path: "outbox/report.xlsx",
          type: "file"
        }
      ]
    });
  });

  it("extracts an inline file directive", () => {
    const reply = '完成 {"wecom_files":[{"path":"outbox/chart.png","type":"image"}]}';

    expect(extractWeComFileDirectives(reply)).toEqual({
      text: "完成",
      files: [
        {
          path: "outbox/chart.png",
          type: "image"
        }
      ]
    });
  });

  it("leaves ordinary JSON in the reply text", () => {
    const reply = '结果是 {"ok":true}';

    expect(extractWeComFileDirectives(reply)).toEqual({
      text: reply,
      files: []
    });
  });

  it("resolves only files inside workspace outbox", () => {
    const workspacePath = path.resolve("C:\\workspaces\\user-a");

    expect(resolveOutboundFilePath(workspacePath, "outbox/report.xlsx")).toBe(
      path.resolve(workspacePath, "outbox", "report.xlsx")
    );
    expect(resolveOutboundFilePath(workspacePath, "inbox/report.xlsx")).toBeUndefined();
    expect(resolveOutboundFilePath(workspacePath, "outbox/../secret.txt")).toBeUndefined();
    expect(resolveOutboundFilePath(workspacePath, "C:\\outside\\secret.txt")).toBeUndefined();
  });
});
