export interface CommandTemplate {
  readonly label: string;
  readonly command: Record<string, unknown>;
}

export const commandTemplates: CommandTemplate[] = [
  { label: "get_state", command: { type: "get_state" } },
  { label: "get_messages", command: { type: "get_messages" } },
  { label: "get_available_models", command: { type: "get_available_models" } },
  {
    label: "set_model",
    command: { type: "set_model", provider: "doubao", modelId: "doubao-seed-2-0-lite-260428" }
  },
  { label: "cycle_model", command: { type: "cycle_model" } },
  { label: "set_thinking_level", command: { type: "set_thinking_level", level: "medium" } },
  { label: "cycle_thinking_level", command: { type: "cycle_thinking_level" } },
  { label: "set_steering_mode", command: { type: "set_steering_mode", mode: "one-at-a-time" } },
  { label: "set_follow_up_mode", command: { type: "set_follow_up_mode", mode: "one-at-a-time" } },
  { label: "compact", command: { type: "compact" } },
  { label: "set_auto_compaction", command: { type: "set_auto_compaction", enabled: true } },
  { label: "set_auto_retry", command: { type: "set_auto_retry", enabled: true } },
  { label: "abort_retry", command: { type: "abort_retry" } },
  { label: "abort", command: { type: "abort" } },
  { label: "new_session", command: { type: "new_session" } },
  { label: "get_session_stats", command: { type: "get_session_stats" } },
  { label: "bash", command: { type: "bash", command: "pwd" } },
  { label: "abort_bash", command: { type: "abort_bash" } },
  { label: "export_html", command: { type: "export_html" } },
  {
    label: "switch_session",
    command: {
      type: "switch_session",
      sessionPath: "/app/data/workspaces/<bot>/<kind>/<chat>/.pi-sessions/session.jsonl"
    }
  },
  { label: "fork", command: { type: "fork", entryId: "entry-id" } },
  { label: "clone", command: { type: "clone" } },
  { label: "get_commands", command: { type: "get_commands" } },
  { label: "set_session_name", command: { type: "set_session_name", name: "" } }
];

export interface StartupArgExample {
  readonly label: string;
  readonly args: string[];
  readonly note: string;
}

export const startupArgExamples: StartupArgExample[] = [
  { label: "模型", args: ["--model", "opencode-go/glm-5.2"], note: "参数和值分开写" },
  { label: "thinking", args: ["--thinking", "high"], note: "off/minimal/low/medium/high/xhigh" },
  {
    label: "替换提示词",
    args: ["--system-prompt", "你是企业微信里的研发运维助手。回答要简洁，命令要可执行。"],
    note: "可写字符串"
  },
  { label: "提示词文件", args: ["--system-prompt", "/app/data/prompts/SYSTEM.md"], note: "路径必须在容器内可读" },
  {
    label: "追加提示词",
    args: ["--append-system-prompt", "企业微信场景下，不要暴露本地路径、inbox、outbox。"],
    note: "可重复配置"
  },
  { label: "工具白名单", args: ["--tools", "read,grep,find,ls"], note: "逗号分隔" },
  { label: "布尔参数", args: ["--approve"], note: "单独写一个元素" }
];

export const defaultCommandText = JSON.stringify(commandTemplates[0]!.command, null, 2);
export const defaultScheduleText = JSON.stringify(
  { type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
  null,
  2
);
export const defaultStepsText = JSON.stringify([{ type: "prompt", message: "请执行这条定时任务。" }], null, 2);
export const defaultStartupArgsText = "[]";

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }

  return new Date(value).toLocaleString();
}

export function parseCommandText(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("指令必须是 JSON 对象");
  }

  return parsed as Record<string, unknown>;
}

export function parseStartupArgsText(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("启动参数必须是 JSON 字符串数组");
  }

  return parsed;
}

export function parseJsonObject<T>(value: string, label: string): T {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }

  return parsed as T;
}

export function parseJsonArray<T>(value: string, label: string): T[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 数组`);
  }

  return parsed as T[];
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
