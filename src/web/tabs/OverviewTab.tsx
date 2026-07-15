import { useState } from "react";
import { App, Button, Card, Descriptions, Popconfirm, Space, Statistic, Switch, Tag, Typography } from "antd";
import { Power, RotateCcw, ShieldCheck } from "lucide-react";
import {
  restartChatRuntime,
  setChatProtection,
  setRuntimePolicy,
  stopChatRuntime,
  terminateAllChats,
  terminateChat,
  type ChatAdminView,
  type PiModel,
  type RuntimePolicy,
  type RuntimeView
} from "../api.js";
import { formatDate, formatError } from "../constants.js";
import { DangerZone } from "../components/DangerZone.js";

const activityColors: Record<RuntimeView["activity"], string> = {
  idle: "green",
  streaming: "blue",
  compacting: "purple",
  pending: "orange",
  unknown: "gold",
  stopped: "default"
};

export function RuntimeStatusTag({ runtime }: { readonly runtime: RuntimeView }) {
  const label = runtime.status === "stopped" ? "stopped" : runtime.activity;
  return <Tag color={activityColors[label as RuntimeView["activity"]] ?? "default"}>{label}</Tag>;
}

function formatModel(model: PiModel | null | undefined): string {
  if (model?.provider !== undefined && model.id !== undefined) {
    return `${model.provider}/${model.id}`;
  }

  return "未选择";
}

export function GlobalOverviewTab(props: {
  readonly chats: ChatAdminView[];
  readonly runtimePolicy: RuntimePolicy;
  readonly onRefresh: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [policyLoading, setPolicyLoading] = useState(false);
  const runningCount = props.chats.filter((chat) => chat.runtime.status === "running").length;
  const protectedCount = props.chats.filter((chat) => chat.binding.protectedRuntime).length;

  async function toggleIdleReaping(checked: boolean): Promise<void> {
    setPolicyLoading(true);
    try {
      await setRuntimePolicy(checked);
      message.success(checked ? "已开启杀闲置进程" : "已关闭杀闲置进程");
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setPolicyLoading(false);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div className="stat-grid">
        <Card size="small">
          <Statistic title="聊天数" value={props.chats.length} />
        </Card>
        <Card size="small">
          <Statistic title="运行中进程" value={runningCount} />
        </Card>
        <Card size="small">
          <Statistic title="受保护进程" value={protectedCount} />
        </Card>
      </div>
      <Card size="small" title="运行策略">
        <div className="policy-row">
          <div>
            <Typography.Text strong>杀闲置进程</Typography.Text>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              开启后，空闲超时的 Pi 进程会被自动回收；受保护或正在执行的进程不受影响。
            </Typography.Paragraph>
          </div>
          <Switch
            checked={props.runtimePolicy.idleReapingEnabled}
            loading={policyLoading}
            onChange={(checked) => void toggleIdleReaping(checked)}
          />
        </div>
      </Card>
      <DangerZone
        actions={[
          {
            key: "terminate-all",
            title: "删除全部工作区数据",
            buttonLabel: "全部删除",
            description:
              "关闭所有运行中的 Pi 进程，删除全部聊天绑定和 workspace 目录（含 session、inbox、outbox），不可恢复。",
            confirmText: "全部删除",
            onConfirm: async () => {
              const results = await terminateAllChats();
              const stopped = results.filter((item) => item.stoppedRuntime).length;
              message.success(`已删除 ${results.length} 个工作区，关闭 ${stopped} 个运行中进程`);
              await props.onRefresh();
            }
          }
        ]}
      />
    </Space>
  );
}

export function ChatOverviewTab(props: {
  readonly chat: ChatAdminView;
  readonly onRefresh: () => Promise<void>;
  readonly onDeleted: () => void;
}) {
  const { message } = App.useApp();
  const [protectionLoading, setProtectionLoading] = useState(false);
  const [killLoading, setKillLoading] = useState(false);
  const [restartLoading, setRestartLoading] = useState(false);

  const { chat } = props;
  const state = chat.runtime.state;

  async function toggleProtection(checked: boolean): Promise<void> {
    setProtectionLoading(true);
    try {
      const protection = await setChatProtection(chat.chatKey, checked);
      const startedText = protection.startedRuntime ? "，已拉起进程" : "";
      message.success(protection.protectedRuntime ? `已开启进程保护${startedText}` : "已关闭进程保护");
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setProtectionLoading(false);
    }
  }

  async function killProcess(): Promise<void> {
    setKillLoading(true);
    try {
      const stop = await stopChatRuntime(chat.chatKey);
      const stoppedText = stop.stoppedRuntime ? "进程已关闭" : "当前没有运行中的进程";
      message.success(stop.protectedRuntime ? stoppedText : `${stoppedText}，进程保护已关闭`);
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setKillLoading(false);
    }
  }

  async function restartProcess(): Promise<void> {
    setRestartLoading(true);
    try {
      const restart = await restartChatRuntime(chat.chatKey);
      const stoppedText = restart.stoppedRuntime ? "已关闭当前进程" : "当前没有运行进程";
      const startedText = restart.startedRuntime ? "，进程保护已重新拉起" : "，下次消息按新参数启动";
      message.success(`${stoppedText}${startedText}`);
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setRestartLoading(false);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div className="panel-grid">
        <Card size="small" title="运行状态">
          <Descriptions
            column={1}
            size="small"
            colon={false}
            items={[
              {
                key: "pid",
                label: "进程",
                children: chat.runtime.pid === null ? "未运行" : `pid ${chat.runtime.pid}`
              },
              { key: "activity", label: "活动", children: <RuntimeStatusTag runtime={chat.runtime} /> },
              { key: "ops", label: "活跃操作", children: chat.runtime.activeOperations },
              { key: "lastUsed", label: "最后使用", children: formatDate(chat.runtime.lastUsedAt) }
            ]}
          />
        </Card>
        <Card size="small" title="模型状态">
          <Descriptions
            column={1}
            size="small"
            colon={false}
            items={[
              { key: "model", label: "模型", children: formatModel(state?.model) },
              { key: "thinking", label: "thinking", children: state?.thinkingLevel ?? "-" },
              {
                key: "compaction",
                label: "自动压缩",
                children:
                  state?.autoCompactionEnabled === undefined ? "-" : state.autoCompactionEnabled ? "开启" : "关闭"
              },
              { key: "pending", label: "pending", children: state?.pendingMessageCount ?? 0 }
            ]}
          />
        </Card>
        <Card size="small" title="会话数据">
          <Descriptions
            column={1}
            size="small"
            colon={false}
            items={[
              {
                key: "sessionId",
                label: "当前 Pi 会话",
                children: (
                  <Typography.Text code copyable>
                    {chat.binding.sessionId}
                  </Typography.Text>
                )
              },
              { key: "files", label: "session 文件", children: chat.piSessions.length },
              {
                key: "messages",
                label: "消息数",
                children: state?.messageCount ?? chat.piSessions[0]?.messageCount ?? 0
              },
              { key: "kind", label: "类型", children: chat.binding.kind === "single" ? "单聊" : "群聊" }
            ]}
          />
        </Card>
      </div>
      <Card size="small" title="进程控制">
        <div className="policy-row">
          <div>
            <Space size={8}>
              <ShieldCheck size={16} />
              <Typography.Text strong>进程保护</Typography.Text>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              开启后进程不会被闲置回收，进程退出后会自动重新拉起。
            </Typography.Paragraph>
          </div>
          <Space size={12} wrap>
            <Switch
              checked={chat.binding.protectedRuntime}
              loading={protectionLoading}
              onChange={(checked) => void toggleProtection(checked)}
            />
            <Popconfirm
              title="重启 Pi 进程"
              description="关闭当前进程；开启保护时立即重新拉起，否则下次消息时按新参数启动。"
              okText="重启"
              cancelText="取消"
              onConfirm={() => void restartProcess()}
            >
              <Button icon={<RotateCcw size={14} />} loading={restartLoading}>
                重启进程
              </Button>
            </Popconfirm>
            <Popconfirm
              title="杀掉 Pi 进程"
              description="会话数据保留；该操作会同时关闭进程保护。"
              okText="杀进程"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void killProcess()}
            >
              <Button danger icon={<Power size={14} />} loading={killLoading}>
                杀进程
              </Button>
            </Popconfirm>
          </Space>
        </div>
      </Card>
      <DangerZone
        actions={[
          {
            key: "terminate",
            title: "删除工作区数据",
            buttonLabel: "删除",
            description: `关闭 ${chat.binding.externalChatId} 的 Pi 进程，删除绑定和整个 workspace 目录（含全部 session、inbox、outbox），不可恢复。`,
            confirmText: chat.binding.externalChatId,
            onConfirm: async () => {
              await terminateChat(chat.chatKey);
              message.success("工作区已删除");
              props.onDeleted();
              await props.onRefresh();
            }
          }
        ]}
      />
    </Space>
  );
}
