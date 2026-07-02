import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  MessageSquare,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Trash2,
  User,
  Users
} from "lucide-react";
import "./styles.css";

interface ChatBinding {
  readonly botId: string;
  readonly kind: "single" | "group";
  readonly externalChatId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly protectedRuntime: boolean;
}

interface SessionSummary {
  readonly id: string;
  readonly name: string | null;
  readonly filePath: string;
  readonly updatedAt: string | null;
  readonly messageCount: number;
}

interface PiModel {
  readonly id?: string;
  readonly provider?: string;
  readonly name?: string;
  readonly api?: string;
  readonly [key: string]: unknown;
}

interface PiState {
  readonly model?: PiModel | null;
  readonly thinkingLevel: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly steeringMode: "all" | "one-at-a-time";
  readonly followUpMode: "all" | "one-at-a-time";
  readonly sessionFile?: string;
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly autoCompactionEnabled: boolean;
  readonly messageCount: number;
  readonly pendingMessageCount: number;
}

interface AdminRuntime {
  readonly status: "running" | "stopped";
  readonly activity: "idle" | "streaming" | "compacting" | "pending" | "unknown" | "stopped";
  readonly pid: number | null;
  readonly activeOperations: number;
  readonly lastUsedAt: string | null;
  readonly state: PiState | null;
  readonly stateError: string | null;
}

interface AdminSession {
  readonly sessionKey: string;
  readonly binding: ChatBinding;
  readonly runtime: AdminRuntime;
  readonly sessions: SessionSummary[];
}

interface RuntimePolicy {
  readonly idleReapingEnabled: boolean;
}

type ScheduledTaskSchedule =
  | { readonly type: "once"; readonly runAt: string; readonly timezone?: string }
  | { readonly type: "cron"; readonly expression: string; readonly timezone?: string };

type ScheduledTaskStep =
  | { readonly type: "prompt"; readonly message: string }
  | { readonly type: "control"; readonly command: Record<string, unknown> };

interface ScheduledTask {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly scope: "global" | "session";
  readonly sessionKey?: string;
  readonly schedule: ScheduledTaskSchedule;
  readonly steps: ScheduledTaskStep[];
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: "idle" | "running" | "success" | "error";
  readonly lastError: string | null;
}

interface ScheduledExecution {
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

interface SessionDocument {
  readonly summary: SessionSummary;
  readonly entries: RawSessionEntry[];
  readonly messages: RawSessionEntry[];
}

interface RawSessionEntry {
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

type DetailTab = "overview" | "control" | "tree";
type GlobalControlScope = "running" | "all";

interface CommandTemplate {
  readonly label: string;
  readonly command: Record<string, unknown>;
}

const commandTemplates: CommandTemplate[] = [
  {
    label: "get_state",
    command: { type: "get_state" }
  },
  {
    label: "get_messages",
    command: { type: "get_messages" }
  },
  {
    label: "get_available_models",
    command: { type: "get_available_models" }
  },
  {
    label: "set_model",
    command: {
      type: "set_model",
      provider: "doubao",
      modelId: "doubao-seed-2-0-lite-260428"
    }
  },
  {
    label: "cycle_model",
    command: { type: "cycle_model" }
  },
  {
    label: "set_thinking_level",
    command: { type: "set_thinking_level", level: "medium" }
  },
  {
    label: "cycle_thinking_level",
    command: { type: "cycle_thinking_level" }
  },
  {
    label: "set_steering_mode",
    command: { type: "set_steering_mode", mode: "one-at-a-time" }
  },
  {
    label: "set_follow_up_mode",
    command: { type: "set_follow_up_mode", mode: "one-at-a-time" }
  },
  {
    label: "compact",
    command: { type: "compact" }
  },
  {
    label: "set_auto_compaction",
    command: { type: "set_auto_compaction", enabled: true }
  },
  {
    label: "set_auto_retry",
    command: { type: "set_auto_retry", enabled: true }
  },
  {
    label: "abort_retry",
    command: { type: "abort_retry" }
  },
  {
    label: "abort",
    command: { type: "abort" }
  },
  {
    label: "new_session",
    command: { type: "new_session" }
  },
  {
    label: "get_session_stats",
    command: { type: "get_session_stats" }
  },
  {
    label: "bash",
    command: { type: "bash", command: "pwd" }
  },
  {
    label: "abort_bash",
    command: { type: "abort_bash" }
  },
  {
    label: "export_html",
    command: { type: "export_html" }
  },
  {
    label: "switch_session",
    command: { type: "switch_session", sessionPath: "/app/data/workspaces/<bot>/<kind>/<chat>/.pi-sessions/session.jsonl" }
  },
  {
    label: "fork",
    command: { type: "fork", entryId: "entry-id" }
  },
  {
    label: "clone",
    command: { type: "clone" }
  },
  {
    label: "get_commands",
    command: { type: "get_commands" }
  },
  {
    label: "set_session_name",
    command: { type: "set_session_name", name: "" }
  }
];

const defaultCommandText = JSON.stringify(commandTemplates[0]!.command, null, 2);
const defaultScheduleText = JSON.stringify({ type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" }, null, 2);
const defaultStepsText = JSON.stringify([{ type: "prompt", message: "请执行这条定时任务。" }], null, 2);

function App() {
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [sessionDoc, setSessionDoc] = useState<SessionDocument | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [globalCommandText, setGlobalCommandText] = useState(defaultCommandText);
  const [globalControlScope, setGlobalControlScope] = useState<GlobalControlScope>("all");
  const [sessionCommandText, setSessionCommandText] = useState(defaultCommandText);
  const [sessionCommandResultText, setSessionCommandResultText] = useState("");
  const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicy>({ idleReapingEnabled: true });
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [scheduledExecutions, setScheduledExecutions] = useState<ScheduledExecution[]>([]);
  const [globalTaskName, setGlobalTaskName] = useState("全局定时任务");
  const [globalScheduleText, setGlobalScheduleText] = useState(defaultScheduleText);
  const [globalStepsText, setGlobalStepsText] = useState(defaultStepsText);
  const [sessionTaskName, setSessionTaskName] = useState("Session 定时任务");
  const [sessionScheduleText, setSessionScheduleText] = useState(defaultScheduleText);
  const [sessionStepsText, setSessionStepsText] = useState(defaultStepsText);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((item) => item.sessionKey === selectedKey) ?? null,
    [selectedKey, sessions]
  );
  const runningCount = sessions.filter((item) => item.runtime.status === "running").length;

  async function loadSessions(options: { keepSelection?: boolean } = {}): Promise<void> {
    setLoadingList(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/sessions");
      if (!response.ok) {
        throw new Error(`加载会话失败：${response.status}`);
      }
      const body = (await response.json()) as { runtimePolicy?: RuntimePolicy; sessions: AdminSession[] };
      if (body.runtimePolicy !== undefined) {
        setRuntimePolicy(body.runtimePolicy);
      }
      setSessions(body.sessions);
      if (!options.keepSelection || selectedKey === null || !body.sessions.some((item) => item.sessionKey === selectedKey)) {
        setSelectedKey(body.sessions[0]?.sessionKey ?? null);
      }
    } catch (loadError: unknown) {
      setError(formatError(loadError));
    } finally {
      setLoadingList(false);
    }
  }

  async function loadScheduledTasks(): Promise<void> {
    try {
      const response = await fetch("/api/admin/scheduled-tasks");
      if (!response.ok) {
        throw new Error(`加载定时任务失败：${response.status}`);
      }
      const body = (await response.json()) as { tasks: ScheduledTask[]; executions: ScheduledExecution[] };
      setScheduledTasks(body.tasks);
      setScheduledExecutions(body.executions);
    } catch (loadError: unknown) {
      setError(formatError(loadError));
    }
  }

  async function loadSessionTree(summary: SessionSummary): Promise<void> {
    if (selectedSession === null) return;
    setLoadingAction("tree");
    setError(null);
    try {
      const params = new URLSearchParams({
        chatKey: selectedSession.sessionKey,
        sessionId: summary.id
      });
      const response = await fetch(`/api/session?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`加载会话树失败：${response.status}`);
      }
      const body = (await response.json()) as { session: SessionDocument };
      setSelectedSessionId(summary.id);
      setSessionDoc(body.session);
    } catch (loadError: unknown) {
      setError(formatError(loadError));
    } finally {
      setLoadingAction(null);
    }
  }

  async function executeGlobalCommand(): Promise<void> {
    setLoadingAction("全局执行指令");
    setError(null);
    setNotice(null);
    try {
      const command = parseCommand(globalCommandText);
      const response = await fetch("/api/admin/sessions/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: globalControlScope, command })
      });
      const body = (await response.json()) as {
        results?: Array<{ status: string; startedRuntime?: boolean; stoppedRuntime?: boolean }>;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `全局指令失败：${response.status}`);
      }
      const results = body.results ?? [];
      const okCount = results.filter((item) => item.status === "ok").length;
      const startedCount = results.filter((item) => item.startedRuntime === true).length;
      const stoppedCount = results.filter((item) => item.stoppedRuntime === true).length;
      const scopeText = globalControlScope === "all" ? "全部 Session" : "当前活跃 Session";
      setNotice(`${scopeText} 指令完成：${okCount}/${results.length} 成功，临时拉起 ${startedCount} 个，关闭 ${stoppedCount} 个`);
      await loadSessions({ keepSelection: true });
    } catch (controlError: unknown) {
      setError(formatError(controlError));
    } finally {
      setLoadingAction(null);
    }
  }

  async function executeSessionCommand(): Promise<void> {
    if (selectedSession === null) return;
    setLoadingAction("Session 执行指令");
    setError(null);
    setNotice(null);
    setSessionCommandResultText("执行中...");
    try {
      const command = parseCommand(sessionCommandText);
      const response = await fetch(`/api/admin/sessions/${encodeURIComponent(selectedSession.sessionKey)}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command })
      });
      const body = (await response.json()) as {
        error?: string;
        result?: unknown;
        startedRuntime?: boolean;
        stoppedRuntime?: boolean;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `Session 指令失败：${response.status}`);
      }
      setSessionCommandResultText(formatCommandResult(body.result));
      const transientText =
        body.startedRuntime === true && body.stoppedRuntime === true ? "，已临时拉起并关闭进程" : "";
      setNotice(`Session 指令已执行${transientText}`);
      await loadSessions({ keepSelection: true });
    } catch (controlError: unknown) {
      const message = formatError(controlError);
      setError(message);
      setSessionCommandResultText(`错误：${message}`);
    } finally {
      setLoadingAction(null);
    }
  }

  async function toggleIdleReaping(): Promise<void> {
    const nextEnabled = !runtimePolicy.idleReapingEnabled;
    setLoadingAction("切换闲置回收");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/runtime-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idleReapingEnabled: nextEnabled })
      });
      const body = (await response.json()) as { runtimePolicy?: RuntimePolicy; error?: string };
      if (!response.ok || body.runtimePolicy === undefined) {
        throw new Error(body.error ?? `切换闲置回收失败：${response.status}`);
      }
      setRuntimePolicy(body.runtimePolicy);
      setNotice(body.runtimePolicy.idleReapingEnabled ? "已开启杀闲置进程" : "已关闭杀闲置进程");
    } catch (policyError: unknown) {
      setError(formatError(policyError));
    } finally {
      setLoadingAction(null);
    }
  }

  async function toggleSessionProtection(): Promise<void> {
    if (selectedSession === null) return;
    const nextProtected = !selectedSession.binding.protectedRuntime;
    setLoadingAction("保护进程");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/sessions/${encodeURIComponent(selectedSession.sessionKey)}/protection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protectedRuntime: nextProtected })
      });
      const body = (await response.json()) as {
        protection?: { protectedRuntime: boolean; startedRuntime: boolean };
        error?: string;
      };
      if (!response.ok || body.protection === undefined) {
        throw new Error(body.error ?? `切换保护失败：${response.status}`);
      }
      const startedText = body.protection.startedRuntime ? "，已拉起进程" : "";
      setNotice(body.protection.protectedRuntime ? `已开启进程保护${startedText}` : "已关闭进程保护");
      await loadSessions({ keepSelection: true });
    } catch (protectionError: unknown) {
      setError(formatError(protectionError));
    } finally {
      setLoadingAction(null);
    }
  }

  async function killSelectedProcess(): Promise<void> {
    if (selectedSession === null) return;
    if (!window.confirm(`确认杀掉 ${selectedSession.binding.externalChatId} 的 Pi 进程？会话数据会保留。`)) {
      return;
    }

    setLoadingAction("杀进程");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/sessions/${encodeURIComponent(selectedSession.sessionKey)}/stop`, {
        method: "POST"
      });
      const body = (await response.json()) as {
        stop?: { stoppedRuntime: boolean; protectedRuntime: boolean };
        error?: string;
      };
      if (!response.ok || body.stop === undefined) {
        throw new Error(body.error ?? `杀进程失败：${response.status}`);
      }
      const stoppedText = body.stop.stoppedRuntime ? "进程已关闭" : "当前没有运行中的进程";
      const protectionText = body.stop.protectedRuntime ? "" : "，进程保护已关闭";
      setNotice(`${stoppedText}${protectionText}`);
      await loadSessions({ keepSelection: true });
    } catch (killError: unknown) {
      setError(formatError(killError));
    } finally {
      setLoadingAction(null);
    }
  }

  async function terminateSelectedSession(): Promise<void> {
    if (selectedSession === null) return;
    if (!window.confirm(`确认终结并清空 ${selectedSession.binding.externalChatId} 的绑定、workspace 和 session 数据？`)) {
      return;
    }

    setLoadingAction("终结 Session");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/sessions/${encodeURIComponent(selectedSession.sessionKey)}/terminate`, {
        method: "POST"
      });
      const body = (await response.json()) as {
        terminate?: { stoppedRuntime: boolean; deletedBinding: boolean; deletedWorkspace: boolean };
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `终结失败：${response.status}`);
      }
      const stoppedText = body.terminate?.stoppedRuntime === true ? "，运行中进程已关闭" : "，当前没有运行中的进程";
      setNotice(`Session 已终结并清空${stoppedText}`);
      await loadSessions({ keepSelection: false });
    } catch (terminateError: unknown) {
      setError(formatError(terminateError));
    } finally {
      setLoadingAction(null);
    }
  }

  async function terminateAllSessions(): Promise<void> {
    if (!window.confirm("确认终结并清空全部 Session 的绑定、workspace 和 session 数据？")) {
      return;
    }

    setLoadingAction("全局终结会话");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/sessions/terminate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" })
      });
      const body = (await response.json()) as {
        results?: Array<{
          status: string;
          stoppedRuntime: boolean;
          deletedBinding?: boolean;
          deletedWorkspace?: boolean;
        }>;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `全局终结失败：${response.status}`);
      }
      const results = body.results ?? [];
      const stoppedCount = results.filter((item) => item.stoppedRuntime).length;
      const clearedCount = results.filter((item) => item.status === "ok" && item.deletedBinding === true && item.deletedWorkspace === true).length;
      setNotice(`全局终结完成：已清空 ${clearedCount}/${results.length} 个 Session，关闭 ${stoppedCount} 个运行中进程`);
      await loadSessions({ keepSelection: false });
    } catch (terminateError: unknown) {
      setError(formatError(terminateError));
    } finally {
      setLoadingAction(null);
    }
  }

  async function createScheduledTask(scope: "global" | "session"): Promise<void> {
    if (scope === "session" && selectedSession === null) return;
    setLoadingAction(scope === "global" ? "创建全局定时任务" : "创建Session定时任务");
    setError(null);
    setNotice(null);
    try {
      const taskName = scope === "global" ? globalTaskName : sessionTaskName;
      const scheduleText = scope === "global" ? globalScheduleText : sessionScheduleText;
      const stepsText = scope === "global" ? globalStepsText : sessionStepsText;
      const response = await fetch("/api/admin/scheduled-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: taskName,
          enabled: true,
          scope,
          sessionKey: scope === "session" ? selectedSession?.sessionKey : undefined,
          schedule: parseJsonObject<ScheduledTaskSchedule>(scheduleText, "schedule"),
          steps: parseJsonArray<ScheduledTaskStep>(stepsText, "steps")
        })
      });
      const body = (await response.json()) as { task?: ScheduledTask; error?: string };
      if (!response.ok || body.task === undefined) {
        throw new Error(body.error ?? `创建定时任务失败：${response.status}`);
      }
      setNotice(`定时任务已创建：${body.task.name}`);
      await loadScheduledTasks();
    } catch (taskError: unknown) {
      setError(formatError(taskError));
    } finally {
      setLoadingAction(null);
    }
  }

  async function runScheduledTask(task: ScheduledTask): Promise<void> {
    setLoadingAction(`立即执行:${task.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}/run`, {
        method: "POST"
      });
      const body = (await response.json()) as {
        result?: { targetCount: number; successCount: number; errorCount: number; errors: string[] };
        error?: string;
      };
      if (!response.ok || body.result === undefined) {
        throw new Error(body.error ?? `立即执行失败：${response.status}`);
      }
      setNotice(`立即执行完成：${body.result.successCount}/${body.result.targetCount} 成功，失败 ${body.result.errorCount}`);
      await Promise.all([loadScheduledTasks(), loadSessions({ keepSelection: true })]);
    } catch (runError: unknown) {
      setError(formatError(runError));
    } finally {
      setLoadingAction(null);
    }
  }

  async function deleteScheduledTask(task: ScheduledTask): Promise<void> {
    if (!window.confirm(`确认删除定时任务「${task.name}」？`)) {
      return;
    }
    setLoadingAction(`删除任务:${task.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}`, {
        method: "DELETE"
      });
      const body = (await response.json()) as { deleted?: boolean; error?: string };
      if (!response.ok || body.deleted !== true) {
        throw new Error(body.error ?? `删除定时任务失败：${response.status}`);
      }
      setNotice("定时任务已删除");
      await loadScheduledTasks();
    } catch (deleteError: unknown) {
      setError(formatError(deleteError));
    } finally {
      setLoadingAction(null);
    }
  }

  useEffect(() => {
    void loadSessions();
    void loadScheduledTasks();
  }, []);

  useEffect(() => {
    setSessionDoc(null);
    setSelectedSessionId(null);
    setSessionCommandText(defaultCommandText);
    setSessionCommandResultText("");
  }, [selectedSession?.sessionKey]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>WeCom Pi Bridge 运维控制台</h1>
          <p>以会话为中心管理 Pi RPC 进程、workspace 和 session 数据</p>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => void loadSessions({ keepSelection: true })} disabled={loadingList}>
            {loadingList ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            刷新
          </button>
        </div>
      </header>

      {error !== null ? <Notice kind="error" text={error} /> : null}
      {notice !== null ? <Notice kind="success" text={notice} /> : null}

      <CommandControlPanel
        commandText={globalCommandText}
        executeLabel={globalControlScope === "all" ? "执行到全部 Session" : "执行到活跃 Session"}
        globalScope={globalControlScope}
        loadingExecute={loadingAction === "全局执行指令"}
        loadingTerminate={loadingAction === "全局终结会话"}
        idleReapingEnabled={runtimePolicy.idleReapingEnabled}
        loadingIdleReaping={loadingAction === "切换闲置回收"}
        scopeText={`${globalControlScope === "all" ? "全部 Session" : "当前活跃 Session"} · ${sessions.length} 个会话 · ${runningCount} 个运行中`}
        terminateLabel="终结全部 Session"
        title="全局控制区"
        onCommandChange={setGlobalCommandText}
        onExecute={() => void executeGlobalCommand()}
        onGlobalScopeChange={setGlobalControlScope}
        onIdleReapingToggle={() => void toggleIdleReaping()}
        onTemplateSelect={(template) => setGlobalCommandText(formatCommand(template.command))}
        onTerminate={() => void terminateAllSessions()}
      />

      <ScheduledTaskPanel
        executions={scheduledExecutions}
        loadingAction={loadingAction}
        name={globalTaskName}
        scheduleText={globalScheduleText}
        scopeText={`全部 Session · ${sessions.length} 个会话`}
        stepsText={globalStepsText}
        tasks={scheduledTasks.filter((task) => task.scope === "global")}
        title="全局定时任务"
        onCreate={() => void createScheduledTask("global")}
        onDelete={(task) => void deleteScheduledTask(task)}
        onNameChange={setGlobalTaskName}
        onRun={(task) => void runScheduledTask(task)}
        onScheduleChange={setGlobalScheduleText}
        onStepsChange={setGlobalStepsText}
      />

      <section className="workspace">
        <aside className="session-sidebar" aria-label="会话列表">
          <div className="sidebar-summary">
            <span>{sessions.length} 个会话</span>
            <span>{runningCount} 个运行中</span>
          </div>
          {sessions.length === 0 ? <EmptyState text="暂无会话。用户发来第一条消息后会自动创建。" /> : null}
          <div className="session-list">
            {sessions.map((item) => (
              <button
                className={item.sessionKey === selectedKey ? "session-item active" : "session-item"}
                key={item.sessionKey}
                type="button"
                onClick={() => setSelectedKey(item.sessionKey)}
              >
                <span className="session-kind">{item.binding.kind === "single" ? <User size={15} /> : <Users size={15} />}</span>
                <span className="session-main">
                  <strong>{item.binding.externalChatId}</strong>
                  <small>{item.binding.kind === "single" ? "单聊" : "群聊"} · {item.sessions.length} 个 session 文件</small>
                </span>
                <StatusBadge runtime={item.runtime} />
              </button>
            ))}
          </div>
        </aside>

        <section className="session-detail">
          {selectedSession === null ? (
            <EmptyState text="选择一个会话查看状态和控制项。" />
          ) : (
            <>
              <SessionHeader session={selectedSession} />
              <nav className="tabs" aria-label="会话详情">
                <TabButton active={activeTab === "overview"} icon={<Bot size={16} />} label="概览" onClick={() => setActiveTab("overview")} />
                <TabButton active={activeTab === "control"} icon={<Settings2 size={16} />} label="控制" onClick={() => setActiveTab("control")} />
                <TabButton active={activeTab === "tree"} icon={<MessageSquare size={16} />} label="会话树" onClick={() => setActiveTab("tree")} />
              </nav>

              {activeTab === "overview" ? <OverviewTab session={selectedSession} /> : null}
              {activeTab === "control" ? (
                <ControlTab
                  commandText={sessionCommandText}
                  resultText={sessionCommandResultText}
                  loadingAction={loadingAction}
                  selectedSession={selectedSession}
                  onCommandChange={setSessionCommandText}
                  onExecute={() => void executeSessionCommand()}
                  onKillProcess={() => void killSelectedProcess()}
                  onProtectionToggle={() => void toggleSessionProtection()}
                  onTemplateSelect={(template) => setSessionCommandText(formatCommand(template.command))}
                  onTerminate={() => void terminateSelectedSession()}
                  scheduledExecutions={scheduledExecutions}
                  scheduledTasks={scheduledTasks.filter((task) => task.sessionKey === selectedSession.sessionKey)}
                  taskName={sessionTaskName}
                  taskScheduleText={sessionScheduleText}
                  taskStepsText={sessionStepsText}
                  onCreateTask={() => void createScheduledTask("session")}
                  onDeleteTask={(task) => void deleteScheduledTask(task)}
                  onRunTask={(task) => void runScheduledTask(task)}
                  onTaskNameChange={setSessionTaskName}
                  onTaskScheduleChange={setSessionScheduleText}
                  onTaskStepsChange={setSessionStepsText}
                />
              ) : null}
              {activeTab === "tree" ? (
                <TreeTab
                  loading={loadingAction === "tree"}
                  selectedSessionId={selectedSessionId}
                  session={selectedSession}
                  sessionDoc={sessionDoc}
                  onLoad={loadSessionTree}
                />
              ) : null}
            </>
          )}
        </section>
      </section>
    </main>
  );
}

function SessionHeader({ session }: { readonly session: AdminSession }) {
  return (
    <header className="detail-heading">
      <div>
        <h2>{session.binding.externalChatId}</h2>
        <p>{session.binding.workspacePath}</p>
      </div>
      <div className="heading-badges">
        <StatusBadge runtime={session.runtime} />
        <span className="metric-pill">{session.sessions.length} files</span>
      </div>
    </header>
  );
}

function OverviewTab({ session }: { readonly session: AdminSession }) {
  const state = session.runtime.state;
  const modelText = formatModel(state?.model ?? null);

  return (
    <div className="panel-grid">
      <InfoPanel title="运行状态" icon={<Bot size={18} />}>
        <KeyValue label="进程" value={session.runtime.pid === null ? "未运行" : `pid ${session.runtime.pid}`} />
        <KeyValue label="活动" value={session.runtime.activity} />
        <KeyValue label="活跃操作" value={String(session.runtime.activeOperations)} />
        <KeyValue label="最后使用" value={formatDate(session.runtime.lastUsedAt)} />
      </InfoPanel>
      <InfoPanel title="模型状态" icon={<Settings2 size={18} />}>
        <KeyValue label="模型" value={modelText} />
        <KeyValue label="thinking" value={state?.thinkingLevel ?? "-"} />
        <KeyValue label="自动压缩" value={state?.autoCompactionEnabled === undefined ? "-" : state.autoCompactionEnabled ? "开启" : "关闭"} />
        <KeyValue label="pending" value={String(state?.pendingMessageCount ?? 0)} />
      </InfoPanel>
      <InfoPanel title="会话数据" icon={<Database size={18} />}>
        <KeyValue label="sessionId" value={session.binding.sessionId} />
        <KeyValue label="session 文件" value={String(session.sessions.length)} />
        <KeyValue label="消息数" value={String(state?.messageCount ?? latestMessageCount(session.sessions))} />
        <KeyValue label="类型" value={session.binding.kind === "single" ? "单聊" : "群聊"} />
      </InfoPanel>
    </div>
  );
}

function ControlTab(props: {
  readonly selectedSession: AdminSession;
  readonly commandText: string;
  readonly resultText: string;
  readonly loadingAction: string | null;
  readonly scheduledTasks: ScheduledTask[];
  readonly scheduledExecutions: ScheduledExecution[];
  readonly taskName: string;
  readonly taskScheduleText: string;
  readonly taskStepsText: string;
  readonly onCommandChange: (value: string) => void;
  readonly onTemplateSelect: (template: CommandTemplate) => void;
  readonly onExecute: () => void;
  readonly onProtectionToggle: () => void;
  readonly onKillProcess: () => void;
  readonly onTerminate: () => void;
  readonly onTaskNameChange: (value: string) => void;
  readonly onTaskScheduleChange: (value: string) => void;
  readonly onTaskStepsChange: (value: string) => void;
  readonly onCreateTask: () => void;
  readonly onRunTask: (task: ScheduledTask) => void;
  readonly onDeleteTask: (task: ScheduledTask) => void;
}) {
  return (
    <>
      <SessionRuntimeControls
        protectedRuntime={props.selectedSession.binding.protectedRuntime}
        runtimeStatus={props.selectedSession.runtime.status}
        loadingKill={props.loadingAction === "杀进程"}
        loadingProtection={props.loadingAction === "保护进程"}
        onKillProcess={props.onKillProcess}
        onProtectionToggle={props.onProtectionToggle}
      />
      <CommandControlPanel
        commandText={props.commandText}
        executeLabel="执行到当前 Session"
        loadingExecute={props.loadingAction === "Session 执行指令"}
        loadingTerminate={props.loadingAction === "终结 Session"}
        scopeText={`${props.selectedSession.binding.kind === "single" ? "单聊" : "群聊"} · ${props.selectedSession.binding.externalChatId}`}
        terminateLabel="终结当前 Session"
        title="Session 控制区"
        resultText={props.resultText}
        onCommandChange={props.onCommandChange}
        onExecute={props.onExecute}
        onTemplateSelect={props.onTemplateSelect}
        onTerminate={props.onTerminate}
      />
      <ScheduledTaskPanel
        executions={props.scheduledExecutions}
        loadingAction={props.loadingAction}
        name={props.taskName}
        scheduleText={props.taskScheduleText}
        scopeText={`${props.selectedSession.binding.kind === "single" ? "单聊" : "群聊"} · ${props.selectedSession.binding.externalChatId}`}
        stepsText={props.taskStepsText}
        tasks={props.scheduledTasks}
        title="Session 定时任务"
        onCreate={props.onCreateTask}
        onDelete={props.onDeleteTask}
        onNameChange={props.onTaskNameChange}
        onRun={props.onRunTask}
        onScheduleChange={props.onTaskScheduleChange}
        onStepsChange={props.onTaskStepsChange}
      />
    </>
  );
}

function ScheduledTaskPanel(props: {
  readonly title: string;
  readonly scopeText: string;
  readonly name: string;
  readonly scheduleText: string;
  readonly stepsText: string;
  readonly tasks: ScheduledTask[];
  readonly executions: ScheduledExecution[];
  readonly loadingAction: string | null;
  readonly onNameChange: (value: string) => void;
  readonly onScheduleChange: (value: string) => void;
  readonly onStepsChange: (value: string) => void;
  readonly onCreate: () => void;
  readonly onRun: (task: ScheduledTask) => void;
  readonly onDelete: (task: ScheduledTask) => void;
}) {
  return (
    <section className="scheduled-panel">
      <header>
        <div>
          <h3>
            <CalendarClock size={18} />
            {props.title}
          </h3>
          <p>{props.scopeText}</p>
        </div>
      </header>
      <div className="scheduled-form">
        <label className="scheduled-name">
          <span>任务名称</span>
          <input value={props.name} onChange={(event) => props.onNameChange(event.target.value)} />
        </label>
        <label className="scheduled-json">
          <span>计划 JSON</span>
          <textarea
            className="command-input"
            value={props.scheduleText}
            onChange={(event) => props.onScheduleChange(event.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="scheduled-json">
          <span>步骤 JSON</span>
          <textarea
            className="command-input"
            value={props.stepsText}
            onChange={(event) => props.onStepsChange(event.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="scheduled-actions">
          <button type="button" onClick={props.onCreate} disabled={props.loadingAction?.startsWith("创建") === true}>
            {props.loadingAction?.startsWith("创建") === true ? <Loader2 className="spin" size={16} /> : <CalendarClock size={16} />}
            创建任务
          </button>
        </div>
      </div>
      <div className="scheduled-list">
        {props.tasks.length === 0 ? <EmptyState text="暂无定时任务。" /> : null}
        {props.tasks.map((task) => (
          <article className="scheduled-item" key={task.id}>
            <div>
              <strong>{task.name}</strong>
              <small>
                {formatSchedule(task.schedule)} · 下次 {formatDate(task.nextRunAt)} · 上次 {task.lastStatus}
              </small>
              <pre className="scheduled-steps">{formatTaskSteps(task.steps)}</pre>
              {task.lastError !== null ? <small className="error-text">{task.lastError}</small> : null}
              {latestExecutionForTask(props.executions, task.id) !== undefined ? (
                <small>{formatExecution(latestExecutionForTask(props.executions, task.id)!)}</small>
              ) : null}
            </div>
            <div className="scheduled-item-actions">
              <button
                type="button"
                onClick={() => props.onRun(task)}
                disabled={props.loadingAction === `立即执行:${task.id}`}
              >
                {props.loadingAction === `立即执行:${task.id}` ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                立即执行
              </button>
              <button
                className="warning-button"
                type="button"
                onClick={() => props.onDelete(task)}
                disabled={props.loadingAction === `删除任务:${task.id}`}
              >
                {props.loadingAction === `删除任务:${task.id}` ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SessionRuntimeControls(props: {
  readonly protectedRuntime: boolean;
  readonly runtimeStatus: AdminRuntime["status"];
  readonly loadingProtection: boolean;
  readonly loadingKill: boolean;
  readonly onProtectionToggle: () => void;
  readonly onKillProcess: () => void;
}) {
  return (
    <section className="runtime-controls">
      <div className="runtime-control-status">
        <span>进程控制</span>
        <strong>{props.runtimeStatus === "running" ? "运行中" : "未运行"}</strong>
      </div>
      <div className="runtime-control-actions">
        <button
          className={props.protectedRuntime ? "toggle-button enabled" : "toggle-button"}
          type="button"
          onClick={props.onProtectionToggle}
          disabled={props.loadingProtection || props.loadingKill}
        >
          {props.loadingProtection ? (
            <Loader2 className="spin" size={16} />
          ) : props.protectedRuntime ? (
            <ShieldCheck size={16} />
          ) : (
            <ShieldOff size={16} />
          )}
          {props.protectedRuntime ? "保护进程已开" : "保护进程已关"}
        </button>
        <button
          className="warning-button"
          type="button"
          onClick={props.onKillProcess}
          disabled={props.loadingProtection || props.loadingKill}
        >
          {props.loadingKill ? <Loader2 className="spin" size={16} /> : <PowerOff size={16} />}
          杀进程
        </button>
      </div>
    </section>
  );
}

function CommandControlPanel(props: {
  readonly title: string;
  readonly scopeText: string;
  readonly commandText: string;
  readonly resultText?: string | undefined;
  readonly executeLabel: string;
  readonly terminateLabel: string;
  readonly globalScope?: GlobalControlScope | undefined;
  readonly idleReapingEnabled?: boolean | undefined;
  readonly loadingExecute: boolean;
  readonly loadingTerminate: boolean;
  readonly loadingIdleReaping?: boolean | undefined;
  readonly onCommandChange: (value: string) => void;
  readonly onGlobalScopeChange?: ((value: GlobalControlScope) => void) | undefined;
  readonly onIdleReapingToggle?: (() => void) | undefined;
  readonly onTemplateSelect: (template: CommandTemplate) => void;
  readonly onExecute: () => void;
  readonly onTerminate: () => void;
}) {
  return (
    <section className="command-panel">
      <header>
        <div>
          <h3>
            <Settings2 size={18} />
            {props.title}
          </h3>
          <p>{props.scopeText}</p>
        </div>
        {props.idleReapingEnabled !== undefined && props.onIdleReapingToggle !== undefined ? (
          <button
            className={props.idleReapingEnabled ? "toggle-button enabled" : "toggle-button"}
            type="button"
            onClick={props.onIdleReapingToggle}
            disabled={props.loadingIdleReaping === true || props.loadingExecute || props.loadingTerminate}
          >
            {props.loadingIdleReaping === true ? <Loader2 className="spin" size={16} /> : <Clock size={16} />}
            {props.idleReapingEnabled ? "杀闲置进程已开" : "杀闲置进程已关"}
          </button>
        ) : null}
      </header>
      <div className={props.globalScope !== undefined ? "command-grid with-scope" : "command-grid"}>
        {props.globalScope !== undefined && props.onGlobalScopeChange !== undefined ? (
          <label className="command-scope">
            <span>执行范围</span>
            <select
              aria-label="全局执行范围"
              value={props.globalScope}
              onChange={(event) => props.onGlobalScopeChange?.(event.target.value as GlobalControlScope)}
            >
              <option value="running">当前活跃 Session</option>
              <option value="all">全部 Session</option>
            </select>
          </label>
        ) : null}
        <label className="command-template">
          <span>指令模板</span>
          <select
            aria-label={`${props.title} 指令模板`}
            value={templateLabelForCommand(props.commandText)}
            onChange={(event) => {
              const template = commandTemplates.find((item) => item.label === event.target.value);
              if (template !== undefined) {
                props.onTemplateSelect(template);
              }
            }}
          >
            <option value="">自定义指令</option>
            {commandTemplates.map((template) => (
              <option key={template.label} value={template.label}>
                {template.label}
              </option>
            ))}
          </select>
        </label>
        <label className="command-input-group">
          <span>指令 JSON</span>
          <textarea
            className="command-input"
            value={props.commandText}
            onChange={(event) => props.onCommandChange(event.target.value)}
            spellCheck={false}
          />
        </label>
        {props.resultText !== undefined ? (
          <label className="command-result-group">
            <span>执行结果</span>
            <textarea className="command-result" value={props.resultText} readOnly spellCheck={false} />
          </label>
        ) : null}
        <div className="command-actions">
          <button type="button" onClick={props.onExecute} disabled={props.loadingExecute || props.loadingTerminate}>
            {props.loadingExecute ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
            {props.executeLabel}
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={props.onTerminate}
            disabled={props.loadingExecute || props.loadingTerminate}
          >
            {props.loadingTerminate ? <Loader2 className="spin" size={16} /> : <Power size={16} />}
            {props.terminateLabel}
          </button>
        </div>
      </div>
    </section>
  );
}

function TreeTab(props: {
  readonly session: AdminSession;
  readonly sessionDoc: SessionDocument | null;
  readonly selectedSessionId: string | null;
  readonly loading: boolean;
  readonly onLoad: (summary: SessionSummary) => Promise<void>;
}) {
  return (
    <div className="tree-layout">
      <aside className="tree-files">
        {props.session.sessions.length === 0 ? <EmptyState text="暂无 session 文件。" /> : null}
        {props.session.sessions.map((summary) => (
          <button
            className={props.selectedSessionId === summary.id ? "tree-file active" : "tree-file"}
            key={summary.filePath}
            type="button"
            onClick={() => void props.onLoad(summary)}
          >
            <span>{summary.name ?? summary.id}</span>
            <small>{summary.messageCount} 条 · {formatDate(summary.updatedAt)}</small>
          </button>
        ))}
      </aside>
      <section className="tree-content">
        {props.loading ? <EmptyState text="正在加载会话树..." /> : null}
        {!props.loading && props.sessionDoc === null ? <EmptyState text="选择一个 session 文件查看原始消息树。" /> : null}
        {props.sessionDoc !== null ? (
          <div className="entry-list">
            {props.sessionDoc.entries.map((entry, index) => (
              <article className="entry" key={entry.id ?? `${entry.type}-${index}`}>
                <header>
                  <span>{entry.message?.role ?? entry.type}</span>
                  {entry.id !== undefined ? <small>{entry.id}</small> : null}
                </header>
                <pre>{formatEntry(entry)}</pre>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function InfoPanel(props: { readonly title: string; readonly icon: React.ReactNode; readonly children: React.ReactNode }) {
  return (
    <section className="info-panel">
      <h3>
        {props.icon}
        {props.title}
      </h3>
      <div className="kv-list">{props.children}</div>
    </section>
  );
}

function KeyValue({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TabButton(props: {
  readonly active: boolean;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button className={props.active ? "tab active" : "tab"} type="button" onClick={props.onClick}>
      {props.icon}
      {props.label}
    </button>
  );
}

function StatusBadge({ runtime }: { readonly runtime: AdminRuntime }) {
  const label = runtime.status === "stopped" ? "stopped" : runtime.activity;
  return <span className={`status-badge ${label}`}>{label}</span>;
}

function Notice({ kind, text }: { readonly kind: "error" | "success"; readonly text: string }) {
  return (
    <section className={`notice ${kind}`}>
      {kind === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      {text}
    </section>
  );
}

function EmptyState({ text }: { readonly text: string }) {
  return <div className="empty-state">{text}</div>;
}

function formatEntry(entry: RawSessionEntry): string {
  if (entry.message?.content !== undefined) {
    return typeof entry.message.content === "string"
      ? entry.message.content
      : JSON.stringify(entry.message.content, null, 2);
  }

  return JSON.stringify(entry, null, 2);
}

function formatModel(model: PiModel | null | undefined): string {
  if (model?.provider !== undefined && model.id !== undefined) {
    return `${model.provider}/${model.id}`;
  }

  return "未选择";
}

function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }

  return new Date(value).toLocaleString();
}

function latestMessageCount(sessions: SessionSummary[]): number {
  return sessions[0]?.messageCount ?? 0;
}

function parseCommand(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("指令必须是 JSON 对象");
  }

  return parsed as Record<string, unknown>;
}

function parseJsonObject<T>(value: string, label: string): T {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }

  return parsed as T;
}

function parseJsonArray<T>(value: string, label: string): T[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 数组`);
  }

  return parsed as T[];
}

function formatCommand(command: Record<string, unknown>): string {
  return JSON.stringify(command, null, 2);
}

function templateLabelForCommand(commandText: string): string {
  try {
    const command = parseCommand(commandText);
    const normalized = JSON.stringify(command);
    return commandTemplates.find((template) => JSON.stringify(template.command) === normalized)?.label ?? "";
  } catch {
    return "";
  }
}

function formatSchedule(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "once") {
    return `单次 ${formatDate(schedule.runAt)}`;
  }

  return `cron ${schedule.expression}`;
}

function latestExecutionForTask(executions: ScheduledExecution[], taskId: string): ScheduledExecution | undefined {
  return executions.find((execution) => execution.taskId === taskId);
}

function formatExecution(execution: ScheduledExecution): string {
  return `最近${execution.trigger === "manual" ? "手动" : "定时"}执行：${execution.successCount}/${execution.targetCount} 成功，${formatDate(execution.finishedAt ?? execution.startedAt)}`;
}

function formatTaskSteps(steps: ScheduledTaskStep[]): string {
  return steps
    .map((step, index) => {
      if (step.type === "prompt") {
        return `${index + 1}. prompt: ${step.message}`;
      }

      return `${index + 1}. control: ${JSON.stringify(step.command)}`;
    })
    .join("\n");
}

function formatCommandResult(result: unknown): string {
  if (result === undefined) {
    return "无返回内容";
  }
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result, null, 2);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
