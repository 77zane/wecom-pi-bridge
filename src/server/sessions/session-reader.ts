import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface SessionSummaryView {
  readonly id: string;
  readonly name: string | null;
  readonly filePath: string;
  readonly updatedAt: string | null;
  readonly messageCount: number;
}

export interface RawSessionEntry {
  readonly type: string;
  readonly id?: string;
  readonly parentId?: string;
  readonly message?: {
    readonly role: string;
    readonly content?: unknown;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface RawMessageEntry extends RawSessionEntry {
  readonly type: "message";
  readonly message: {
    readonly role: string;
    readonly content?: unknown;
    readonly [key: string]: unknown;
  };
}

export interface SessionDocument {
  readonly summary: SessionSummaryView;
  readonly entries: RawSessionEntry[];
  readonly messages: RawMessageEntry[];
}

export async function listSessionSummaries(sessionDir: string): Promise<SessionSummaryView[]> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return [];
  }

  const files = names.filter((name) => name.endsWith(".jsonl"));
  const summaries = await Promise.all(files.map((name) => readSessionFile(path.join(sessionDir, name))));

  return summaries
    .map((session) => session.summary)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export async function readSessionFile(filePath: string): Promise<SessionDocument> {
  const [content, fileStat] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
  const entries = parseJsonlEntries(content, filePath);
  const header = entries.find((entry) => entry.type === "session");
  const messages = entries.filter(isRawMessageEntry);

  return {
    summary: {
      id: readString(header, "id") ?? path.basename(filePath, ".jsonl"),
      name: readString(header, "name") ?? readString(header, "sessionName"),
      filePath,
      updatedAt: fileStat.mtime.toISOString(),
      messageCount: messages.length
    },
    entries,
    messages
  };
}

function parseJsonlEntries(content: string, filePath: string): RawSessionEntry[] {
  const entries: RawSessionEntry[] = [];
  const lines = content.split(/\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRawSessionEntry(parsed)) {
        entries.push(parsed);
      }
    } catch (error: unknown) {
      const lineNumber = index + 1;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid session JSONL at line ${lineNumber} in ${filePath}: ${message}`);
    }
  }

  return entries;
}

function isRawSessionEntry(value: unknown): value is RawSessionEntry {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function isRawMessageEntry(entry: RawSessionEntry): entry is RawMessageEntry {
  return (
    entry.type === "message" &&
    typeof entry.message === "object" &&
    entry.message !== null &&
    "role" in entry.message &&
    typeof entry.message.role === "string"
  );
}

function readString(entry: RawSessionEntry | undefined, key: string): string | null {
  if (entry === undefined) {
    return null;
  }

  const value = entry[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

