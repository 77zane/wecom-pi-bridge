import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PiRpcControlCommand } from "../pi/pi-rpc-client.js";
import { nextCronDate } from "./cron.js";

export type ScheduledTaskScope = "global" | "session";
export type ScheduledTaskStatus = "idle" | "running" | "success" | "error";
export type ScheduledExecutionTrigger = "scheduled" | "manual";

export type ScheduledTaskSchedule =
  | { readonly type: "once"; readonly runAt: string; readonly timezone?: string | undefined }
  | { readonly type: "cron"; readonly expression: string; readonly timezone?: string | undefined };

export type ScheduledTaskStep =
  | { readonly type: "prompt"; readonly message: string }
  | { readonly type: "control"; readonly command: PiRpcControlCommand };

export interface ScheduledTask {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly scope: ScheduledTaskScope;
  readonly sessionKey?: string | undefined;
  readonly schedule: ScheduledTaskSchedule;
  readonly steps: ScheduledTaskStep[];
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: ScheduledTaskStatus;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduledTaskInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly scope: ScheduledTaskScope;
  readonly sessionKey?: string | undefined;
  readonly schedule: ScheduledTaskSchedule;
  readonly steps: ScheduledTaskStep[];
}

export interface ScheduledTaskExecution {
  readonly id: string;
  readonly taskId: string;
  readonly trigger: ScheduledExecutionTrigger;
  readonly status: "running" | "success" | "error";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly targetCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly error: string | null;
}

interface TaskRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: number;
  readonly scope: ScheduledTaskScope;
  readonly session_key: string | null;
  readonly schedule_json: string;
  readonly steps_json: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_status: ScheduledTaskStatus;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ExecutionRow {
  readonly id: string;
  readonly task_id: string;
  readonly trigger: ScheduledExecutionTrigger;
  readonly status: "running" | "success" | "error";
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly target_count: number;
  readonly success_count: number;
  readonly error_count: number;
  readonly error: string | null;
}

export class ScheduledTaskStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  listTasks(): ScheduledTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_tasks
        ORDER BY created_at DESC`
      )
      .all() as unknown as TaskRow[];
    return rows.map(toTask);
  }

  listDueTasks(now = new Date()): ScheduledTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC`
      )
      .all(now.toISOString()) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  getTask(id: string): ScheduledTask | undefined {
    const row = this.db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as TaskRow | null | undefined;
    return row === null || row === undefined ? undefined : toTask(row);
  }

  createTask(input: ScheduledTaskInput, now = new Date()): ScheduledTask {
    const id = randomUUID();
    const timestamp = now.toISOString();
    const nextRunAt = computeInitialNextRunAt(input.schedule, now);
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (
          id, name, enabled, scope, session_key, schedule_json, steps_json,
          next_run_at, last_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`
      )
      .run(
        id,
        input.name,
        input.enabled ? 1 : 0,
        input.scope,
        input.sessionKey ?? null,
        JSON.stringify(input.schedule),
        JSON.stringify(input.steps),
        input.enabled ? nextRunAt : null,
        timestamp,
        timestamp
      );

    return this.getTask(id)!;
  }

  updateTask(id: string, input: ScheduledTaskInput, now = new Date()): ScheduledTask | undefined {
    const existing = this.getTask(id);
    if (existing === undefined) {
      return undefined;
    }

    const nextRunAt = computeInitialNextRunAt(input.schedule, now);
    this.db
      .prepare(
        `UPDATE scheduled_tasks
        SET name = ?,
            enabled = ?,
            scope = ?,
            session_key = ?,
            schedule_json = ?,
            steps_json = ?,
            next_run_at = ?,
            updated_at = ?
        WHERE id = ?`
      )
      .run(
        input.name,
        input.enabled ? 1 : 0,
        input.scope,
        input.sessionKey ?? null,
        JSON.stringify(input.schedule),
        JSON.stringify(input.steps),
        input.enabled ? nextRunAt : null,
        now.toISOString(),
        id
      );

    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  markTaskStarted(task: ScheduledTask, now = new Date()): void {
    this.db
      .prepare(
        `UPDATE scheduled_tasks
        SET last_run_at = ?,
            last_status = 'running',
            last_error = NULL,
            updated_at = ?
        WHERE id = ?`
      )
      .run(now.toISOString(), now.toISOString(), task.id);
  }

  markTaskFinished(task: ScheduledTask, status: "success" | "error", error: string | null, now = new Date()): void {
    const nextRunAt = status === "success" || task.schedule.type === "cron"
      ? computeNextRunAt(task.schedule, now)
      : task.nextRunAt;
    const enabled = task.schedule.type === "once" && status === "success" ? 0 : task.enabled ? 1 : 0;
    this.db
      .prepare(
        `UPDATE scheduled_tasks
        SET enabled = ?,
            next_run_at = ?,
            last_status = ?,
            last_error = ?,
            updated_at = ?
        WHERE id = ?`
      )
      .run(enabled, enabled === 1 ? nextRunAt : null, status, error, now.toISOString(), task.id);
  }

  startExecution(taskId: string, trigger: ScheduledExecutionTrigger, now = new Date()): ScheduledTaskExecution {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO scheduled_task_executions (
          id, task_id, trigger, status, started_at, target_count, success_count, error_count
        ) VALUES (?, ?, ?, 'running', ?, 0, 0, 0)`
      )
      .run(id, taskId, trigger, now.toISOString());
    return this.getExecution(id)!;
  }

  finishExecution(
    id: string,
    result: { readonly status: "success" | "error"; readonly targetCount: number; readonly successCount: number; readonly errorCount: number; readonly error: string | null },
    now = new Date()
  ): void {
    this.db
      .prepare(
        `UPDATE scheduled_task_executions
        SET status = ?,
            finished_at = ?,
            target_count = ?,
            success_count = ?,
            error_count = ?,
            error = ?
        WHERE id = ?`
      )
      .run(result.status, now.toISOString(), result.targetCount, result.successCount, result.errorCount, result.error, id);
  }

  listExecutions(taskId?: string | undefined): ScheduledTaskExecution[] {
    const rows = taskId === undefined
      ? (this.db.prepare(`SELECT * FROM scheduled_task_executions ORDER BY started_at DESC LIMIT 50`).all() as unknown as ExecutionRow[])
      : (this.db
          .prepare(`SELECT * FROM scheduled_task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 20`)
          .all(taskId) as unknown as ExecutionRow[]);
    return rows.map(toExecution);
  }

  getExecution(id: string): ScheduledTaskExecution | undefined {
    const row = this.db.prepare(`SELECT * FROM scheduled_task_executions WHERE id = ?`).get(id) as ExecutionRow | null | undefined;
    return row === null || row === undefined ? undefined : toExecution(row);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'session')),
        session_key TEXT,
        schedule_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_task_executions (
        id TEXT NOT NULL PRIMARY KEY,
        task_id TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        target_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
    `);
  }
}

function computeInitialNextRunAt(schedule: ScheduledTaskSchedule, now: Date): string | null {
  return computeNextRunAt(schedule, now);
}

function computeNextRunAt(schedule: ScheduledTaskSchedule, now: Date): string | null {
  if (schedule.type === "once") {
    return new Date(schedule.runAt).toISOString();
  }

  return nextCronDate(schedule.expression, now, schedule.timezone)?.toISOString() ?? null;
}

function toTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    scope: row.scope,
    sessionKey: row.session_key ?? undefined,
    schedule: JSON.parse(row.schedule_json) as ScheduledTaskSchedule,
    steps: JSON.parse(row.steps_json) as ScheduledTaskStep[],
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toExecution(row: ExecutionRow): ScheduledTaskExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    targetCount: row.target_count,
    successCount: row.success_count,
    errorCount: row.error_count,
    error: row.error
  };
}
