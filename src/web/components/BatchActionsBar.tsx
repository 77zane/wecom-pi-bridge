import { useState } from "react";
import { App, Button, Input, Modal, Popconfirm, Select, Space, Typography } from "antd";
import { Power, RotateCcw, Send, X } from "lucide-react";
import { restartChatRuntime, runChatCommand, stopChatRuntime, type ChatAdminView } from "../api.js";
import { commandTemplates, defaultCommandText, formatError, formatJson, parseCommandText } from "../constants.js";

interface BatchOutcome {
  readonly label: string;
  readonly error: string | null;
}

/**
 * 侧栏多选后的批量操作条。批量动作串行逐个聊天执行，
 * 避免同时拉起大量 Pi 进程；结果汇总成一条通知。
 */
export function BatchActionsBar(props: {
  readonly selectedChats: ChatAdminView[];
  readonly onClear: () => void;
  readonly onRefresh: () => Promise<void>;
}) {
  const { notification } = App.useApp();
  const [running, setRunning] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandText, setCommandText] = useState(defaultCommandText);

  async function runBatch(
    actionKey: string,
    actionName: string,
    task: (chat: ChatAdminView) => Promise<void>
  ): Promise<void> {
    setRunning(actionKey);
    const outcomes: BatchOutcome[] = [];
    try {
      for (const chat of props.selectedChats) {
        try {
          await task(chat);
          outcomes.push({ label: chat.binding.externalChatId, error: null });
        } catch (error: unknown) {
          outcomes.push({ label: chat.binding.externalChatId, error: formatError(error) });
        }
      }

      const failures = outcomes.filter((item) => item.error !== null);
      const summary = `${actionName}：${outcomes.length - failures.length}/${outcomes.length} 成功`;
      if (failures.length === 0) {
        notification.success({ message: summary });
      } else {
        notification.warning({
          message: summary,
          description: (
            <ul className="batch-failure-list">
              {failures.map((item) => (
                <li key={item.label}>
                  {item.label}：{item.error}
                </li>
              ))}
            </ul>
          ),
          duration: 0
        });
      }
      await props.onRefresh();
    } finally {
      setRunning(null);
    }
  }

  async function executeBatchCommand(): Promise<void> {
    let command: Record<string, unknown>;
    try {
      command = parseCommandText(commandText);
    } catch (error: unknown) {
      notification.error({ message: formatError(error) });
      return;
    }

    setCommandOpen(false);
    await runBatch("command", "批量执行指令", async (chat) => {
      await runChatCommand(chat.chatKey, command);
    });
  }

  if (props.selectedChats.length === 0) {
    return null;
  }

  return (
    <div className="batch-bar">
      <Typography.Text strong>已选 {props.selectedChats.length} 个聊天</Typography.Text>
      <Space wrap size={8}>
        <Button size="small" icon={<Send size={13} />} loading={running === "command"} onClick={() => setCommandOpen(true)}>
          批量执行指令
        </Button>
        <Popconfirm
          title={`重启 ${props.selectedChats.length} 个聊天的 Pi 进程？`}
          description="逐个关闭进程；开启保护的会立即拉起，其余下次消息时启动。"
          okText="重启"
          cancelText="取消"
          onConfirm={() =>
            void runBatch("restart", "批量重启", async (chat) => {
              await restartChatRuntime(chat.chatKey);
            })
          }
        >
          <Button size="small" icon={<RotateCcw size={13} />} loading={running === "restart"}>
            批量重启
          </Button>
        </Popconfirm>
        <Popconfirm
          title={`杀掉 ${props.selectedChats.length} 个聊天的 Pi 进程？`}
          description="会话数据保留；会同时关闭这些聊天的进程保护。"
          okText="杀进程"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={() =>
            void runBatch("stop", "批量杀进程", async (chat) => {
              await stopChatRuntime(chat.chatKey);
            })
          }
        >
          <Button size="small" danger icon={<Power size={13} />} loading={running === "stop"}>
            批量杀进程
          </Button>
        </Popconfirm>
        <Button size="small" type="text" icon={<X size={13} />} onClick={props.onClear}>
          取消选择
        </Button>
      </Space>
      <Modal
        title={`批量执行指令（${props.selectedChats.length} 个聊天）`}
        open={commandOpen}
        okText="执行"
        cancelText="取消"
        onOk={() => void executeBatchCommand()}
        onCancel={() => setCommandOpen(false)}
        width={560}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            指令会逐个发给所选聊天的 Pi 进程；未运行的会临时拉起，执行完自动关闭。
          </Typography.Text>
          <Select
            style={{ width: "100%" }}
            showSearch
            placeholder="选择指令模板"
            onChange={(label) => {
              const template = commandTemplates.find((item) => item.label === label);
              if (template !== undefined) {
                setCommandText(formatJson(template.command));
              }
            }}
            options={commandTemplates.map((template) => ({ value: template.label, label: template.label }))}
          />
          <Input.TextArea
            className="code-input"
            value={commandText}
            onChange={(event) => setCommandText(event.target.value)}
            autoSize={{ minRows: 6, maxRows: 14 }}
            spellCheck={false}
          />
        </Space>
      </Modal>
    </div>
  );
}
