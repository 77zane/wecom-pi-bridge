import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatBinding, ChatKind } from "../../shared/contracts.js";
import {
  parseStoredStartupArgs,
  serializeStartupArgs,
  type ResolvedStartupArgs
} from "../startup/startup-args.js";

export interface BindingRequest {
  readonly botId: string;
  readonly kind: ChatKind;
  readonly externalChatId: string;
  readonly displayName: string;
}

export interface BindingIdentity {
  readonly botId: string;
  readonly kind: ChatKind;
  readonly externalChatId: string;
}

export interface StoredChatBinding extends ChatBinding {
  readonly sessionDir: string;
  readonly inboxDir: string;
  readonly protectedRuntime: boolean;
  readonly startupArgs: string[] | null;
}

interface BindingRow {
  readonly bot_id: string;
  readonly kind: ChatKind;
  readonly external_chat_id: string;
  readonly workspace_path: string;
  readonly session_id: string;
  readonly protected_runtime: number;
  readonly startup_args_json: string | null;
}

interface ProtocolVersionRow {
  readonly wecom_file_protocol_version: number;
}

export interface RuntimePolicy {
  readonly idleReapingEnabled: boolean;
}

interface SettingRow {
  readonly value: string;
}

interface TableColumnRow {
  readonly name: string;
}

export class BindingStore {
  private readonly db: DatabaseSync;
  private readonly dataDir: string;
  private static readonly GLOBAL_STARTUP_ARGS_KEY = "pi_startup_args_global";

  constructor(dbPath: string, dataDir: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.dataDir = dataDir;
    this.migrate();
  }

  getOrCreate(request: BindingRequest): StoredChatBinding {
    const existing = this.find(request.botId, request.kind, request.externalChatId);
    if (existing !== undefined) {
      this.ensureWorkspaceDirs(existing.workspace_path);
      return this.toStoredBinding(existing);
    }

    const workspacePath = this.resolveWorkspacePath(request);
    const sessionId = createStableSessionId(request.botId, request.kind, request.externalChatId);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO chat_bindings (
          bot_id,
          kind,
          external_chat_id,
          display_name,
          workspace_path,
          session_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        request.botId,
        request.kind,
        request.externalChatId,
        request.displayName,
        workspacePath,
        sessionId,
        now,
        now
      );

    this.ensureWorkspaceDirs(workspacePath);
    return this.toStoredBinding({
      bot_id: request.botId,
      kind: request.kind,
      external_chat_id: request.externalChatId,
      workspace_path: workspacePath,
      session_id: sessionId,
      protected_runtime: 0,
      startup_args_json: null
    });
  }

  getByIdentity(identity: BindingIdentity): StoredChatBinding | undefined {
    const row = this.find(identity.botId, identity.kind, identity.externalChatId);
    if (row === undefined) {
      return undefined;
    }

    this.ensureWorkspaceDirs(row.workspace_path);
    return this.toStoredBinding(row);
  }

  delete(identity: BindingIdentity): StoredChatBinding | undefined {
    const row = this.find(identity.botId, identity.kind, identity.externalChatId);
    if (row === undefined) {
      return undefined;
    }

    this.db
      .prepare(
        `DELETE FROM chat_bindings
        WHERE bot_id = ? AND kind = ? AND external_chat_id = ?`
      )
      .run(identity.botId, identity.kind, identity.externalChatId);

    return this.toStoredBinding(row);
  }

  listAll(): StoredChatBinding[] {
    const rows = this.db
      .prepare(
        `SELECT
          bot_id,
          kind,
          external_chat_id,
          workspace_path,
          session_id,
          protected_runtime,
          startup_args_json
        FROM chat_bindings
        ORDER BY bot_id, kind, external_chat_id`
      )
      .all() as unknown as BindingRow[];

    return rows.map((row) => this.toStoredBinding(row));
  }

  getRuntimePolicy(): RuntimePolicy {
    const row = this.db
      .prepare(
        `SELECT value
        FROM admin_settings
        WHERE key = 'idle_reaping_enabled'`
      )
      .get() as SettingRow | null | undefined;

    return {
      idleReapingEnabled: row?.value !== "false"
    };
  }

  setRuntimePolicy(policy: RuntimePolicy): RuntimePolicy {
    this.db
      .prepare(
        `INSERT INTO admin_settings (key, value, updated_at)
        VALUES ('idle_reaping_enabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at`
      )
      .run(policy.idleReapingEnabled ? "true" : "false", new Date().toISOString());

    return this.getRuntimePolicy();
  }

  getGlobalStartupArgs(): string[] {
    const row = this.db
      .prepare(
        `SELECT value
        FROM admin_settings
        WHERE key = ?`
      )
      .get(BindingStore.GLOBAL_STARTUP_ARGS_KEY) as SettingRow | null | undefined;

    return parseStoredStartupArgs(row?.value);
  }

  setGlobalStartupArgs(args: readonly string[]): string[] {
    const serialized = serializeStartupArgs(args);
    this.db
      .prepare(
        `INSERT INTO admin_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at`
      )
      .run(BindingStore.GLOBAL_STARTUP_ARGS_KEY, serialized, new Date().toISOString());

    return this.getGlobalStartupArgs();
  }

  setWorkspaceStartupArgs(identity: BindingIdentity, args: readonly string[]): StoredChatBinding | undefined {
    const row = this.find(identity.botId, identity.kind, identity.externalChatId);
    if (row === undefined) {
      return undefined;
    }

    this.db
      .prepare(
        `UPDATE chat_bindings
        SET startup_args_json = ?,
            updated_at = ?
        WHERE bot_id = ? AND kind = ? AND external_chat_id = ?`
      )
      .run(serializeStartupArgs(args), new Date().toISOString(), identity.botId, identity.kind, identity.externalChatId);

    return this.getByIdentity(identity);
  }

  clearWorkspaceStartupArgs(identity: BindingIdentity): StoredChatBinding | undefined {
    const row = this.find(identity.botId, identity.kind, identity.externalChatId);
    if (row === undefined) {
      return undefined;
    }

    this.db
      .prepare(
        `UPDATE chat_bindings
        SET startup_args_json = NULL,
            updated_at = ?
        WHERE bot_id = ? AND kind = ? AND external_chat_id = ?`
      )
      .run(new Date().toISOString(), identity.botId, identity.kind, identity.externalChatId);

    return this.getByIdentity(identity);
  }

  getResolvedStartupArgs(identity: BindingIdentity): ResolvedStartupArgs | undefined {
    const binding = this.getByIdentity(identity);
    if (binding === undefined) {
      return undefined;
    }

    const globalArgs = this.getGlobalStartupArgs();
    const workspaceArgs = binding.startupArgs;
    if (workspaceArgs !== null) {
      return {
        source: "workspace",
        args: workspaceArgs,
        globalArgs,
        workspaceArgs
      };
    }

    return {
      source: globalArgs.length > 0 ? "global" : "none",
      args: globalArgs,
      globalArgs,
      workspaceArgs
    };
  }

  isRuntimeProtected(identity: BindingIdentity): boolean {
    const row = this.find(identity.botId, identity.kind, identity.externalChatId);
    return row?.protected_runtime === 1;
  }

  setRuntimeProtection(identity: BindingIdentity, protectedRuntime: boolean): StoredChatBinding | undefined {
    const row = this.find(identity.botId, identity.kind, identity.externalChatId);
    if (row === undefined) {
      return undefined;
    }

    this.db
      .prepare(
        `UPDATE chat_bindings
        SET protected_runtime = ?,
            updated_at = ?
        WHERE bot_id = ? AND kind = ? AND external_chat_id = ?`
      )
      .run(
        protectedRuntime ? 1 : 0,
        new Date().toISOString(),
        identity.botId,
        identity.kind,
        identity.externalChatId
      );

    return this.getByIdentity(identity);
  }

  setSessionId(identity: BindingIdentity, sessionId: string): StoredChatBinding | undefined {
    const row = this.find(identity.botId, identity.kind, identity.externalChatId);
    if (row === undefined) {
      return undefined;
    }

    this.db
      .prepare(
        `UPDATE chat_bindings
        SET session_id = ?,
            wecom_file_protocol_version = 0,
            updated_at = ?
        WHERE bot_id = ? AND kind = ? AND external_chat_id = ?`
      )
      .run(sessionId, new Date().toISOString(), identity.botId, identity.kind, identity.externalChatId);

    return this.getByIdentity(identity);
  }

  hasWeComFileProtocol(identity: BindingIdentity, version: number): boolean {
    const row = this.db
      .prepare(
        `SELECT wecom_file_protocol_version
        FROM chat_bindings
        WHERE bot_id = ? AND kind = ? AND external_chat_id = ?`
      )
      .get(identity.botId, identity.kind, identity.externalChatId) as ProtocolVersionRow | null | undefined;

    return row !== null && row !== undefined && row.wecom_file_protocol_version >= version;
  }

  markWeComFileProtocol(identity: BindingIdentity, version: number): void {
    this.db
      .prepare(
        `UPDATE chat_bindings
        SET wecom_file_protocol_version = MAX(wecom_file_protocol_version, ?),
            updated_at = ?
        WHERE bot_id = ? AND kind = ? AND external_chat_id = ?`
      )
      .run(version, new Date().toISOString(), identity.botId, identity.kind, identity.externalChatId);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_bindings (
        bot_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('single', 'group')),
        external_chat_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        wecom_file_protocol_version INTEGER NOT NULL DEFAULT 0,
        protected_runtime INTEGER NOT NULL DEFAULT 0,
        startup_args_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, kind, external_chat_id)
      );

      CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("chat_bindings", "wecom_file_protocol_version", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("chat_bindings", "protected_runtime", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("chat_bindings", "startup_args_json", "TEXT");
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as TableColumnRow[];
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  private find(botId: string, kind: ChatKind, externalChatId: string): BindingRow | undefined {
    const row = this.db
      .prepare(
        `SELECT
          bot_id,
          kind,
          external_chat_id,
          workspace_path,
          session_id,
          protected_runtime,
          startup_args_json
        FROM chat_bindings
        WHERE bot_id = ? AND kind = ? AND external_chat_id = ?`
      )
      .get(botId, kind, externalChatId);

    if (row === null || row === undefined) {
      return undefined;
    }

    return row as unknown as BindingRow;
  }

  private resolveWorkspacePath(request: BindingRequest): string {
    return join(
      this.dataDir,
      "workspaces",
      "wecom",
      sanitizePathSegment(request.botId),
      request.kind,
      sanitizePathSegment(request.externalChatId)
    );
  }

  private ensureWorkspaceDirs(workspacePath: string): void {
    mkdirSync(join(workspacePath, ".pi-sessions"), { recursive: true });
    mkdirSync(join(workspacePath, "inbox"), { recursive: true });
  }

  private toStoredBinding(row: BindingRow): StoredChatBinding {
    return {
      botId: row.bot_id,
      kind: row.kind,
      externalChatId: row.external_chat_id,
      workspacePath: row.workspace_path,
      sessionId: row.session_id,
      sessionDir: join(row.workspace_path, ".pi-sessions"),
      inboxDir: join(row.workspace_path, "inbox"),
      protectedRuntime: row.protected_runtime === 1,
      startupArgs: row.startup_args_json === null ? null : parseStoredStartupArgs(row.startup_args_json)
    };
  }
}

export function createStableSessionId(botId: string, kind: ChatKind, externalChatId: string): string {
  const hash = createHash("sha256").update(`${botId}\0${kind}\0${externalChatId}`).digest("hex").slice(0, 32);
  return `s-${hash}`;
}

export function encodeChatKey(identity: BindingIdentity): string {
  return Buffer.from(JSON.stringify([identity.botId, identity.kind, identity.externalChatId]), "utf8").toString(
    "base64url"
  );
}

export function decodeChatKey(chatKey: string): BindingIdentity {
  const parsed = JSON.parse(Buffer.from(chatKey, "base64url").toString("utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error("Invalid chat key");
  }

  const [botId, kind, externalChatId] = parsed;
  if (typeof botId !== "string" || (kind !== "single" && kind !== "group") || typeof externalChatId !== "string") {
    throw new Error("Invalid chat key");
  }

  return {
    botId,
    kind,
    externalChatId
  };
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();

  return sanitized.length > 0 ? sanitized : "_";
}
