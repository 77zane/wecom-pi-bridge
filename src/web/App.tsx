import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Button, Checkbox, Empty, Space, Tabs, Tag, Typography } from "antd";
import { Bot, CalendarClock, ListTree, RefreshCw, Settings2, SlidersHorizontal, Terminal, User, Users } from "lucide-react";
import {
  fetchAdminOverview,
  fetchScheduledTasks,
  type AdminOverview,
  type ChatAdminView,
  type ScheduledExecution,
  type ScheduledTask
} from "./api.js";
import { formatError } from "./constants.js";
import { BatchActionsBar } from "./components/BatchActionsBar.js";
import { ChatOverviewTab, GlobalOverviewTab, RuntimeStatusTag } from "./tabs/OverviewTab.js";
import { StartupArgsTab } from "./tabs/StartupArgsTab.js";
import { CommandTab } from "./tabs/CommandTab.js";
import { ScheduleTab } from "./tabs/ScheduleTab.js";
import { PiSessionsTab } from "./tabs/PiSessionsTab.js";

/** 侧栏选中目标：全局，或某个聊天（值为 chatKey）。 */
const GLOBAL_TARGET = "global";

export function App() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [executions, setExecutions] = useState<ScheduledExecution[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string>(GLOBAL_TARGET);
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);

  async function loadAll(): Promise<void> {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextOverview, nextTasks] = await Promise.all([fetchAdminOverview(), fetchScheduledTasks()]);
      setOverview(nextOverview);
      setTasks(nextTasks.tasks);
      setExecutions(nextTasks.executions);

      const validKeys = new Set(nextOverview.chats.map((chat) => chat.chatKey));
      setSelectedTarget((current) => (current === GLOBAL_TARGET || validKeys.has(current) ? current : GLOBAL_TARGET));
      setCheckedKeys((current) => current.filter((key) => validKeys.has(key)));
    } catch (error: unknown) {
      setLoadError(formatError(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  const chats = overview?.chats ?? [];
  const selectedChat = useMemo(
    () => chats.find((chat) => chat.chatKey === selectedTarget) ?? null,
    [chats, selectedTarget]
  );
  const checkedChats = useMemo(() => chats.filter((chat) => checkedKeys.includes(chat.chatKey)), [chats, checkedKeys]);
  const runningCount = chats.filter((chat) => chat.runtime.status === "running").length;

  function toggleChecked(chatKey: string, checked: boolean): void {
    setCheckedKeys((current) => (checked ? [...current, chatKey] : current.filter((key) => key !== chatKey)));
  }

  async function refresh(): Promise<void> {
    await loadAll();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            WeCom Pi Bridge 运维控制台
          </Typography.Title>
          <Typography.Text type="secondary">
            {chats.length} 个聊天 · {runningCount} 个运行中
          </Typography.Text>
        </div>
        <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>
          刷新
        </Button>
      </header>

      {loadError !== null ? (
        <Alert
          type="error"
          showIcon
          message={loadError}
          action={
            <Button size="small" onClick={() => void refresh()}>
              重试
            </Button>
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div className="workspace">
        <aside className="sidebar">
          <button
            className={selectedTarget === GLOBAL_TARGET ? "sidebar-item global active" : "sidebar-item global"}
            type="button"
            onClick={() => setSelectedTarget(GLOBAL_TARGET)}
          >
            <Settings2 size={16} />
            <span className="sidebar-item-main">
              <strong>全局</strong>
              <small>作用于所有聊天的默认配置与控制</small>
            </span>
          </button>

          <div className="sidebar-section-title">
            <span>聊天列表</span>
            {chats.length > 0 ? (
              <Checkbox
                checked={checkedKeys.length === chats.length && chats.length > 0}
                indeterminate={checkedKeys.length > 0 && checkedKeys.length < chats.length}
                onChange={(event) => setCheckedKeys(event.target.checked ? chats.map((chat) => chat.chatKey) : [])}
              >
                全选
              </Checkbox>
            ) : null}
          </div>

          {chats.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无聊天。用户发来第一条消息后会自动创建。"
            />
          ) : null}

          <div className="sidebar-list">
            {chats.map((chat) => (
              <div
                className={chat.chatKey === selectedTarget ? "sidebar-row active" : "sidebar-row"}
                key={chat.chatKey}
              >
                <Checkbox
                  checked={checkedKeys.includes(chat.chatKey)}
                  onChange={(event) => toggleChecked(chat.chatKey, event.target.checked)}
                />
                <button className="sidebar-item chat" type="button" onClick={() => setSelectedTarget(chat.chatKey)}>
                  <span className="sidebar-kind">
                    {chat.binding.kind === "single" ? <User size={15} /> : <Users size={15} />}
                  </span>
                  <span className="sidebar-item-main">
                    <strong>{chat.binding.externalChatId}</strong>
                    <small>
                      {chat.binding.kind === "single" ? "单聊" : "群聊"} · {chat.piSessions.length} 个 session 文件
                    </small>
                  </span>
                  <RuntimeStatusTag runtime={chat.runtime} />
                </button>
              </div>
            ))}
          </div>

          <BatchActionsBar selectedChats={checkedChats} onClear={() => setCheckedKeys([])} onRefresh={refresh} />
        </aside>

        <section className="detail">
          {overview === null ? (
            <Empty description={loading ? "加载中..." : "暂无数据"} />
          ) : selectedChat === null ? (
            <GlobalDetail
              key={GLOBAL_TARGET}
              overview={overview}
              tasks={tasks}
              executions={executions}
              onRefresh={refresh}
            />
          ) : (
            <ChatDetail
              key={selectedChat.chatKey}
              chat={selectedChat}
              tasks={tasks}
              executions={executions}
              onRefresh={refresh}
              onDeleted={() => setSelectedTarget(GLOBAL_TARGET)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function GlobalDetail(props: {
  readonly overview: AdminOverview;
  readonly tasks: ScheduledTask[];
  readonly executions: ScheduledExecution[];
  readonly onRefresh: () => Promise<void>;
}) {
  return (
    <>
      <header className="detail-heading">
        <div>
          <Typography.Title level={5} style={{ margin: 0 }}>
            全局
          </Typography.Title>
          <Typography.Text type="secondary">配置与控制作用于所有聊天；聊天级配置会覆盖全局。</Typography.Text>
        </div>
      </header>
      <Tabs
        defaultActiveKey="overview"
        items={[
          {
            key: "overview",
            label: tabLabel(<Bot size={15} />, "概览"),
            children: (
              <GlobalOverviewTab
                chats={props.overview.chats}
                runtimePolicy={props.overview.runtimePolicy}
                onRefresh={props.onRefresh}
              />
            )
          },
          {
            key: "startup",
            label: tabLabel(<SlidersHorizontal size={15} />, "启动参数"),
            children: (
              <StartupArgsTab
                scope={{ type: "global", globalArgs: props.overview.globalStartupArgs }}
                onRefresh={props.onRefresh}
              />
            )
          },
          {
            key: "command",
            label: tabLabel(<Terminal size={15} />, "指令"),
            children: <CommandTab scope={{ type: "global" }} onRefresh={props.onRefresh} />
          },
          {
            key: "schedule",
            label: tabLabel(<CalendarClock size={15} />, "定时任务"),
            children: (
              <ScheduleTab
                scope={{ type: "global" }}
                tasks={props.tasks}
                executions={props.executions}
                onRefresh={props.onRefresh}
              />
            )
          }
        ]}
      />
    </>
  );
}

function ChatDetail(props: {
  readonly chat: ChatAdminView;
  readonly tasks: ScheduledTask[];
  readonly executions: ScheduledExecution[];
  readonly onRefresh: () => Promise<void>;
  readonly onDeleted: () => void;
}) {
  const { chat } = props;

  return (
    <>
      <header className="detail-heading">
        <div>
          <Space size={8}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {chat.binding.externalChatId}
            </Typography.Title>
            <Tag>{chat.binding.kind === "single" ? "单聊" : "群聊"}</Tag>
            <RuntimeStatusTag runtime={chat.runtime} />
          </Space>
          <Typography.Text type="secondary" className="workspace-path">
            {chat.binding.workspacePath}
          </Typography.Text>
        </div>
      </header>
      <Tabs
        defaultActiveKey="overview"
        items={[
          {
            key: "overview",
            label: tabLabel(<Bot size={15} />, "概览"),
            children: <ChatOverviewTab chat={chat} onRefresh={props.onRefresh} onDeleted={props.onDeleted} />
          },
          {
            key: "startup",
            label: tabLabel(<SlidersHorizontal size={15} />, "启动参数"),
            children: <StartupArgsTab scope={{ type: "chat", chat }} onRefresh={props.onRefresh} />
          },
          {
            key: "command",
            label: tabLabel(<Terminal size={15} />, "指令"),
            children: <CommandTab scope={{ type: "chat", chat }} onRefresh={props.onRefresh} />
          },
          {
            key: "schedule",
            label: tabLabel(<CalendarClock size={15} />, "定时任务"),
            children: (
              <ScheduleTab
                scope={{ type: "chat", chat }}
                tasks={props.tasks}
                executions={props.executions}
                onRefresh={props.onRefresh}
              />
            )
          },
          {
            key: "pi-sessions",
            label: tabLabel(<ListTree size={15} />, "Pi 会话"),
            children: <PiSessionsTab chat={chat} onRefresh={props.onRefresh} />
          }
        ]}
      />
    </>
  );
}

function tabLabel(icon: ReactNode, text: string): ReactNode {
  return (
    <span className="tab-label">
      {icon}
      {text}
    </span>
  );
}
