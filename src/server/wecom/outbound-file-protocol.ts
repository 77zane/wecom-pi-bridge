import path from "node:path";
import { z } from "zod";
import type { WeComMediaType } from "@wecom/aibot-node-sdk";

export const WECOM_FILE_PROTOCOL_INSTRUCTION = [
  "平台能力说明：如果你需要让企业微信发送你生成的文件，请把文件写入当前 workspace 的 outbox/ 目录，并在回复中单独输出这个 JSON 指令：",
  '{"wecom_files":[{"path":"outbox/文件名","type":"file"}]}',
  "type 固定使用 file；path 必须是相对路径且位于 outbox/ 下。",
  "这段 JSON 由桥接服务从整段回复中读取，不要求必须是最后一行，不需要向用户解释。",
  "不要在面向用户的回复里暴露 outbox、inbox 或本地文件路径；如果需要提示用户，可以说“文件已发送，请查收。”"
].join("\n");

export interface WeComFileDirective {
  readonly path: string;
  readonly type: WeComMediaType;
}

export interface ExtractedWeComFileDirectives {
  readonly text: string;
  readonly files: WeComFileDirective[];
}

const mediaTypeSchema = z.union([
  z.literal("file"),
  z.literal("image"),
  z.literal("voice"),
  z.literal("video")
]);

const directiveSchema = z.object({
  wecom_files: z.array(
    z.object({
      path: z.string().min(1),
      type: mediaTypeSchema.default("file")
    })
  )
});

export function extractWeComFileDirectives(text: string): ExtractedWeComFileDirectives {
  const files: WeComFileDirective[] = [];
  const withoutFences = stripFencedDirectives(text, files);
  const withoutInlineDirectives = stripInlineDirectives(withoutFences, files);

  return {
    text: normalizeReplyText(withoutInlineDirectives),
    files
  };
}

export function resolveOutboundFilePath(workspacePath: string, relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }

  const normalizedRelativePath = relativePath.replace(/\\/g, "/");
  if (!normalizedRelativePath.startsWith("outbox/")) {
    return undefined;
  }

  const outboxRoot = path.resolve(workspacePath, "outbox");
  const resolvedPath = path.resolve(workspacePath, normalizedRelativePath);
  const relativeToOutbox = path.relative(outboxRoot, resolvedPath);
  if (relativeToOutbox.length === 0 || relativeToOutbox.startsWith("..") || path.isAbsolute(relativeToOutbox)) {
    return undefined;
  }

  return resolvedPath;
}

function stripFencedDirectives(text: string, files: WeComFileDirective[]): string {
  const fencePattern = /```(?:json|wecom|wecom-files|wecom_files)?\s*([\s\S]*?)```/gi;

  return text.replace(fencePattern, (block: string, body: string) => {
    const directives = parseDirectiveJson(body.trim());
    if (directives === undefined) {
      return block;
    }

    files.push(...directives);
    return "";
  });
}

function stripInlineDirectives(text: string, files: WeComFileDirective[]): string {
  let output = text;
  let cursor = 0;

  while (cursor < output.length) {
    const markerIndex = output.indexOf('"wecom_files"', cursor);
    if (markerIndex === -1) {
      break;
    }

    const objectStart = output.lastIndexOf("{", markerIndex);
    if (objectStart === -1) {
      cursor = markerIndex + 1;
      continue;
    }

    const objectEnd = findJsonObjectEnd(output, objectStart);
    if (objectEnd === undefined) {
      cursor = markerIndex + 1;
      continue;
    }

    const directives = parseDirectiveJson(output.slice(objectStart, objectEnd));
    if (directives === undefined) {
      cursor = markerIndex + 1;
      continue;
    }

    files.push(...directives);
    output = `${output.slice(0, objectStart)}${output.slice(objectEnd)}`;
    cursor = objectStart;
  }

  return output;
}

function parseDirectiveJson(jsonText: string): WeComFileDirective[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  const result = directiveSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }

  return result.data.wecom_files;
}

function findJsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index + 1;
    }
  }

  return undefined;
}

function normalizeReplyText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
