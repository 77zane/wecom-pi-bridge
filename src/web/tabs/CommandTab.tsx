import { useState } from "react";
import { Alert, App, Button, Card, Input, Select, Space, Typography } from "antd";
import { Send } from "lucide-react";
import { runChatCommand, runGlobalCommand, type ChatAdminView } from "../api.js";
import { commandTemplates, defaultCommandText, formatError, formatJson, parseCommandText } from "../constants.js";

export type CommandScope = { readonly type: "global" } | { readonly type: "chat"; readonly chat: ChatAdminView };

function templateLabelFor(commandText: string): string {
  try {
    const normalized = JSON.stringify(parseCommandText(commandText));
    return commandTemplates.find((template) => JSON.stringify(template.command) === normalized)?.label ?? "";
  } catch {
    return "";
  }
}

/** Pi RPC 指令控制台，同一组件服务全局广播和单聊天两种作用域。 */
export function CommandTab(props: { readonly scope: CommandScope; readonly onRefresh: () => Promise<void> }) {
  const { message } = App.useApp();
  const [commandText, setCommandText] = useState(defaultCommandText);
  const [broadcastScope, setBroadcastScope] = useState<"running" | "all">("running");
  const [resultText, setResultText] = useState("");
  const [running, setRunning] = useState(false);

  async function execute(): Promise<void> {
    setRunning(true);
    setResultText("执行中...");
    try {
      const command = parseCommandText(commandText);
      if (props.scope.type === "global") {
        const results = await runGlobalCommand(broadcastScope, command);
        const okCount = results.filter((item) => item.status === "ok").length;
        message.success(`指令完成：${okCount}/${results.length} 成功`);
        setResultText(formatJson(results));
      } else {
        const control = await runChatCommand(props.scope.chat.chatKey, command);
        const transientText =
          control.startedRuntime === true && control.stoppedRuntime === true ? "（已临时拉起并关闭进程）" : "";
        message.success(`指令已执行${transientText}`);
        setResultText(control.result === undefined ? "无返回内容" : formatJson(control.result));
      }
      await props.onRefresh();
    } catch (error: unknown) {
      const text = formatError(error);
      message.error(text);
      setResultText(`错误：${text}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Alert
        type="warning"
        showIcon
        message={
          props.scope.type === "global"
            ? "指令直接发给 Pi RPC 进程。「全部聊天」范围会为未运行的聊天临时拉起进程，执行完自动关闭。"
            : "指令直接发给该聊天的 Pi RPC 进程；进程未运行时会临时拉起，执行完自动关闭。"
        }
      />
      <Card size="small" title="执行指令">
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Space wrap>
            {props.scope.type === "global" ? (
              <Select
                style={{ width: 180 }}
                value={broadcastScope}
                onChange={setBroadcastScope}
                options={[
                  { value: "running", label: "运行中的聊天" },
                  { value: "all", label: "全部聊天" }
                ]}
              />
            ) : null}
            <Select
              style={{ width: 260 }}
              showSearch
              placeholder="选择指令模板"
              value={templateLabelFor(commandText) || undefined}
              onChange={(label) => {
                const template = commandTemplates.find((item) => item.label === label);
                if (template !== undefined) {
                  setCommandText(formatJson(template.command));
                }
              }}
              options={commandTemplates.map((template) => ({ value: template.label, label: template.label }))}
            />
          </Space>
          <div>
            <Typography.Text type="secondary">指令 JSON</Typography.Text>
            <Input.TextArea
              className="code-input"
              value={commandText}
              onChange={(event) => setCommandText(event.target.value)}
              autoSize={{ minRows: 6, maxRows: 16 }}
              spellCheck={false}
            />
          </div>
          <Button type="primary" icon={<Send size={14} />} loading={running} onClick={() => void execute()}>
            {props.scope.type === "global"
              ? broadcastScope === "all"
                ? "执行到全部聊天"
                : "执行到运行中的聊天"
              : "执行"}
          </Button>
        </Space>
      </Card>
      {resultText !== "" ? (
        <Card size="small" title="执行结果">
          <pre className="code-block result-block">{resultText}</pre>
        </Card>
      ) : null}
    </Space>
  );
}
