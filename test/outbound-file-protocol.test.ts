import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractWeComFileDirectives,
  resolveOutboundFilePath
} from "../src/server/wecom/outbound-file-protocol.js";

describe("outbound file protocol", () => {
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

  it("extracts a file directive even when it is not the last line", () => {
    const reply = [
      "文件已发送，请查收。",
      "```json",
      '{"wecom_files":[{"path":"outbox/report.xlsx","type":"file"}]}',
      "```",
      "后续补充说明。"
    ].join("\n");

    expect(extractWeComFileDirectives(reply)).toEqual({
      text: "文件已发送，请查收。\n\n后续补充说明。",
      files: [
        {
          path: "outbox/report.xlsx",
          type: "file"
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
