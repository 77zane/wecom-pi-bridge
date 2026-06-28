import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SaveAttachmentOptions {
  readonly inboxDir: string;
  readonly messageId: string;
  readonly originalFilename: string | undefined;
  readonly fallbackFilename?: string;
  readonly buffer: Buffer;
  readonly suffix: string;
}

export interface SavedAttachment {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly filename: string;
}

export async function saveAttachment(options: SaveAttachmentOptions): Promise<SavedAttachment> {
  const baseFilename = sanitizeOriginalFilename(options.originalFilename ?? options.fallbackFilename ?? "file");
  const filename = appendSuffix(baseFilename, options.suffix);
  const safeMessageId = sanitizePathPart(options.messageId);
  const targetDir = path.join(options.inboxDir, safeMessageId);
  const absolutePath = path.join(targetDir, filename);

  await mkdir(targetDir, { recursive: true });
  await writeFile(absolutePath, options.buffer);

  return {
    absolutePath,
    relativePath: path.posix.join("inbox", safeMessageId, filename),
    filename
  };
}

export function sanitizeOriginalFilename(filename: string): string {
  const rawBaseName = filename.split(/[\\/]/).filter((part) => part.length > 0).at(-1) ?? "file";
  const sanitized = rawBaseName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();

  return sanitized.length > 0 ? sanitized : "file";
}

function sanitizePathPart(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();

  return sanitized.length > 0 ? sanitized : "message";
}

function appendSuffix(filename: string, suffix: string): string {
  const parsed = path.parse(filename);
  const name = parsed.name.length > 0 ? parsed.name : "file";
  return `${name}-${sanitizePathPart(suffix)}${parsed.ext}`;
}
