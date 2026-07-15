/**
 * 前端 API 层。
 *
 * 命名约定：服务端历史路由和字段里的 `sessionKey` 实际上是 chat 的稳定标识
 * （base64url 编码的 botId/kind/externalChatId 三元组）。前端统一改叫 `chatKey`，
 * 只在本文件的 DTO 映射处出现一次 `sessionKey`，其余代码不再接触这个歧义词。
 * 传输值本身保持不变，兼容线上数据和现有后端。
 */

export type ChatKind = "single" | "group";

export interface ChatBinding {
  readonly botId: string;
  readonly kind: ChatKind;
  readonly externalChatId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly protectedRuntime: boolean;
  readonly startupArgs: string[] | null;
}

export interface PiSessionSummary {
  readonly id: string;
  readonly name: string | null;
  readonly filePath: string;
  readonly updatedAt: string | null;
  readonly messageCount: number;
}

export interface PiModel {
  readonly id?: string;
  readonly provider?: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

export interface PiState {
  readonly model?: PiModel | null;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly autoCompactionEnabled?: boolean;
  readonly messageCount?: number;
  readonly pendingMessageCount?: number;
  readonly [key: string]: unknown;
}

export type RuntimeActivity = "idle" | "streaming" | "compacting" | "pending" | "unknown" | "stopped";

export interface RuntimeView {
  readonly status: "running" | "stopped";
  readonly activity: RuntimeActivity;
  readonly pid: number | null;
  readonly activeOperations: number;
  readonly lastUsedAt: string | null;
  readonly state: PiState | null;
  readonly stateError: string | null;
}

export interface StartupArgsState {
  readonly source: "none" | "global" | "workspace";
  readonly args: string[];
  readonly globalArgs: string[];
  readonly workspaceArgs: string[] | null;
}

export interface ChatAdminView {
  readonly chatKey: string;
  readonly binding: ChatBinding;
  readonly runtime: RuntimeView;
  readonly startup: StartupArgsState;
  readonly piSessions: PiSessionSummary[];
}

export interface RuntimePolicy {
  readonly idleReapingEnabled: boolean;
}

export interface AdminOverview {
  readonly runtimePolicy: RuntimePolicy;
  readonly globalStartupArgs: string[];
  readonly chats: ChatAdminView[];
}

export interface SessionRebindResult {
  readonly chatKey: string;
  readonly previousSessionId: string;
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly startedRuntime: boolean;
  readonly stoppedRuntime: boolean;
}

export interface RestartResult {
  readonly stoppedRuntime: boolean;
  readonly startedRuntime: boolean;
}

export interface ControlResult {
  readonly result?: unknown;
  readonly startedRuntime?: boolean;
  readonly stoppedRuntime?: boolean;
}

export interface BroadcastResult {
  readonly chatKey: string;
  readonly status: "ok" | "skipped" | "error";
  readonly result?: unknown;
  readonly startedRuntime?: boolean;
  readonly stoppedRuntime?: boolean;
  readonly error?: string;
}

export type ScheduledTaskSchedule =
  | { readonly type: "once"; readonly runAt: string; readonly timezone?: string }
  | { readonly type: "cron"; readonly expression: string; readonly timezone?: string };

export type ScheduledTaskStep =
  | { readonly type: "prompt"; readonly message: string }
  | { readonly type: "control"; readonly command: Record<string, unknown> };

export interface ScheduledTask {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly scope: "global" | "session";
  readonly chatKey?: string | undefined;
  readonly schedule: ScheduledTaskSchedule;
  readonly steps: ScheduledTaskStep[];
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: "idle" | "running" | "success" | "error";
  readonly lastError: string | null;
}

export interface ScheduledExecution {
  readonly id: string;
  readonly taskId: string;
  readonly trigger: "scheduled" | "manual";
  readonly status: "running" | "success" | "error";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly targetCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly error: string | null;
}

export interface ScheduledRunSummary {
  readonly targetCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly errors: string[];
}

export interface RawSessionEntry {
  readonly type: string;
  readonly id?: string;
  readonly parentId?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface PiSessionDocument {
  readonly summary: PiSessionSummary;
  readonly entries: RawSessionEntry[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // 非 JSON 响应时保留 null，走下面的状态码报错
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `请求失败：${response.status} ${path}`;
    throw new Error(message);
  }

  return body as T;
}

function postJson(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function putJson(payload: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

/** 服务端仍以 sessionKey 命名 chat 标识，这里做一次性映射。 */
interface RawChatAdminView {
  readonly sessionKey: string;
  readonly binding: ChatBinding;
  readonly runtime: RuntimeView;
  readonly startup: StartupArgsState;
  readonly sessions: PiSessionSummary[];
}

interface RawScheduledTask extends Omit<ScheduledTask, "chatKey"> {
  readonly sessionKey?: string;
}

function chatPath(chatKey: string, suffix = ""): string {
  return `/api/admin/sessions/${encodeURIComponent(chatKey)}${suffix}`;
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
  const body = await request<{
    runtimePolicy?: RuntimePolicy;
    startupArgs?: { args: string[] };
    sessions: RawChatAdminView[];
  }>("/api/admin/sessions");

  return {
    runtimePolicy: body.runtimePolicy ?? { idleReapingEnabled: true },
    globalStartupArgs: body.startupArgs?.args ?? [],
    chats: body.sessions.map((raw) => ({
      chatKey: raw.sessionKey,
      binding: raw.binding,
      runtime: raw.runtime,
      startup: raw.startup,
      piSessions: raw.sessions
    }))
  };
}

export async function fetchScheduledTasks(): Promise<{ tasks: ScheduledTask[]; executions: ScheduledExecution[] }> {
  const body = await request<{ tasks: RawScheduledTask[]; executions: ScheduledExecution[] }>(
    "/api/admin/scheduled-tasks"
  );
  return {
    tasks: body.tasks.map((raw) => {
      const { sessionKey, ...rest } = raw;
      return { ...rest, chatKey: sessionKey };
    }),
    executions: body.executions
  };
}

export async function fetchPiSessionDocument(chatKey: string, sessionId: string): Promise<PiSessionDocument> {
  const params = new URLSearchParams({ chatKey, sessionId });
  const body = await request<{ session: PiSessionDocument }>(`/api/session?${params.toString()}`);
  return body.session;
}

export async function saveGlobalStartupArgs(args: string[]): Promise<string[]> {
  const body = await request<{ startupArgs: { args: string[] } }>("/api/admin/startup-args", putJson({ args }));
  return body.startupArgs.args;
}

export async function saveWorkspaceStartupArgs(chatKey: string, args: string[]): Promise<ChatBinding> {
  const body = await request<{ binding: ChatBinding }>(chatPath(chatKey, "/startup-args"), putJson({ args }));
  return body.binding;
}

export async function clearWorkspaceStartupArgs(chatKey: string): Promise<ChatBinding> {
  const body = await request<{ binding: ChatBinding }>(chatPath(chatKey, "/startup-args"), { method: "DELETE" });
  return body.binding;
}

export async function setRuntimePolicy(idleReapingEnabled: boolean): Promise<RuntimePolicy> {
  const body = await request<{ runtimePolicy: RuntimePolicy }>(
    "/api/admin/runtime-policy",
    postJson({ idleReapingEnabled })
  );
  return body.runtimePolicy;
}

export async function restartRuntimes(scope: "running" | "all"): Promise<RestartResult[]> {
  const body = await request<{ results?: RestartResult[] }>("/api/admin/sessions/restart", postJson({ scope }));
  return body.results ?? [];
}

export async function restartChatRuntime(chatKey: string): Promise<RestartResult> {
  const body = await request<{ restart: RestartResult }>(chatPath(chatKey, "/restart"), { method: "POST" });
  return body.restart;
}

export async function stopChatRuntime(chatKey: string): Promise<{ stoppedRuntime: boolean; protectedRuntime: boolean }> {
  const body = await request<{ stop: { stoppedRuntime: boolean; protectedRuntime: boolean } }>(
    chatPath(chatKey, "/stop"),
    { method: "POST" }
  );
  return body.stop;
}

export async function setChatProtection(
  chatKey: string,
  protectedRuntime: boolean
): Promise<{ protectedRuntime: boolean; startedRuntime: boolean }> {
  const body = await request<{ protection: { protectedRuntime: boolean; startedRuntime: boolean } }>(
    chatPath(chatKey, "/protection"),
    postJson({ protectedRuntime })
  );
  return body.protection;
}

export async function runChatCommand(chatKey: string, command: Record<string, unknown>): Promise<ControlResult> {
  return request<ControlResult>(chatPath(chatKey, "/control"), postJson({ command }));
}

export async function runGlobalCommand(
  scope: "running" | "all",
  command: Record<string, unknown>
): Promise<BroadcastResult[]> {
  const body = await request<{ results?: Array<Omit<BroadcastResult, "chatKey"> & { sessionKey: string }> }>(
    "/api/admin/sessions/control",
    postJson({ scope, command })
  );
  return (body.results ?? []).map((raw) => {
    const { sessionKey, ...rest } = raw;
    return { ...rest, chatKey: sessionKey };
  });
}

export async function terminateChat(
  chatKey: string
): Promise<{ stoppedRuntime: boolean; deletedBinding: boolean; deletedWorkspace: boolean }> {
  const body = await request<{
    terminate: { stoppedRuntime: boolean; deletedBinding: boolean; deletedWorkspace: boolean };
  }>(chatPath(chatKey, "/terminate"), { method: "POST" });
  return body.terminate;
}

export async function terminateAllChats(): Promise<Array<{ status: string; stoppedRuntime: boolean }>> {
  const body = await request<{ results?: Array<{ status: string; stoppedRuntime: boolean }> }>(
    "/api/admin/sessions/terminate",
    postJson({ scope: "all" })
  );
  return body.results ?? [];
}

export async function createPiSession(chatKey: string): Promise<SessionRebindResult> {
  const body = await request<{ session: Omit<SessionRebindResult, "chatKey"> & { sessionKey: string } }>(
    chatPath(chatKey, "/new-session"),
    { method: "POST" }
  );
  const { sessionKey, ...rest } = body.session;
  return { ...rest, chatKey: sessionKey };
}

export async function switchPiSession(chatKey: string, sessionId: string): Promise<SessionRebindResult> {
  const body = await request<{ session: Omit<SessionRebindResult, "chatKey"> & { sessionKey: string } }>(
    chatPath(chatKey, "/switch-session"),
    postJson({ sessionId })
  );
  const { sessionKey, ...rest } = body.session;
  return { ...rest, chatKey: sessionKey };
}

export interface CreateScheduledTaskInput {
  readonly name: string;
  readonly scope: "global" | "session";
  readonly chatKey?: string | undefined;
  readonly schedule: ScheduledTaskSchedule;
  readonly steps: ScheduledTaskStep[];
}

export async function createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
  const body = await request<{ task: RawScheduledTask }>(
    "/api/admin/scheduled-tasks",
    postJson({
      name: input.name,
      enabled: true,
      scope: input.scope,
      sessionKey: input.chatKey,
      schedule: input.schedule,
      steps: input.steps
    })
  );
  const { sessionKey, ...rest } = body.task;
  return { ...rest, chatKey: sessionKey };
}

export async function deleteScheduledTask(taskId: string): Promise<void> {
  await request<{ deleted?: boolean }>(`/api/admin/scheduled-tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
}

export async function runScheduledTask(taskId: string): Promise<ScheduledRunSummary> {
  const body = await request<{ result: ScheduledRunSummary }>(
    `/api/admin/scheduled-tasks/${encodeURIComponent(taskId)}/run`,
    { method: "POST" }
  );
  return body.result;
}
