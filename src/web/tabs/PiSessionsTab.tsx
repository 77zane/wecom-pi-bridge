import { useState } from "react";
import { App, Button, Card, Empty, Popconfirm, Space, Spin, Tag, Typography } from "antd";
import { Plus, RefreshCw } from "lucide-react";
import {
  createPiSession,
  fetchPiSessionDocument,
  switchPiSession,
  type ChatAdminView,
  type PiSessionDocument,
  type PiSessionSummary,
  type RawSessionEntry
} from "../api.js";
import { formatDate, formatError, formatJson } from "../constants.js";

function formatEntry(entry: RawSessionEntry): string {
  if (entry.message?.content !== undefined) {
    return typeof entry.message.content === "string" ? entry.message.content : formatJson(entry.message.content);
  }

  return formatJson(entry);
}

/**
 * Pi 会话管理：查看当前 workspace 下的 session 文件，新建/切换当前绑定，
 * 浏览 session 原始内容。只改"绑定到哪个 Pi 会话"，不编辑 session 文件。
 */
export function PiSessionsTab(props: { readonly chat: ChatAdminView; readonly onRefresh: () => Promise<void> }) {
  const { message } = App.useApp();
  const [doc, setDoc] = useState<PiSessionDocument | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [creating, setCreating] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const { chat } = props;
  const boundId = chat.binding.sessionId;
  const hasBoundFile = chat.piSessions.some((summary) => summary.id === boundId);

  async function viewSession(summary: PiSessionSummary): Promise<void> {
    setLoadingDoc(true);
    try {
      const session = await fetchPiSessionDocument(chat.chatKey, summary.id);
      setViewingId(summary.id);
      setDoc(session);
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setLoadingDoc(false);
    }
  }

  async function createSession(): Promise<void> {
    setCreating(true);
    try {
      const result = await createPiSession(chat.chatKey);
      const transientText = result.startedRuntime && result.stoppedRuntime ? "（已临时拉起并关闭进程）" : "";
      message.success(`已新建并绑定 Pi 会话：${result.sessionId}${transientText}`);
      setDoc(null);
      setViewingId(null);
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setCreating(false);
    }
  }

  async function switchSession(summary: PiSessionSummary): Promise<void> {
    setSwitchingId(summary.id);
    try {
      const result = await switchPiSession(chat.chatKey, summary.id);
      const transientText = result.startedRuntime && result.stoppedRuntime ? "（已临时拉起并关闭进程）" : "";
      message.success(`已切换并绑定 Pi 会话：${result.sessionId}${transientText}`);
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setSwitchingId(null);
    }
  }

  return (
    <div className="pi-sessions-layout">
      <Card
        size="small"
        className="pi-session-list-card"
        title={
          <Space direction="vertical" size={0}>
            <span>Pi 会话文件</span>
            <Typography.Text type="secondary" style={{ fontWeight: "normal", fontSize: 12 }}>
              当前绑定 {boundId}
            </Typography.Text>
          </Space>
        }
        extra={
          <Popconfirm
            title="新建 Pi 会话并绑定？"
            description="之后企业微信消息将进入新会话；旧会话文件保留，可随时切回。"
            okText="新建"
            cancelText="取消"
            onConfirm={() => void createSession()}
          >
            <Button size="small" type="primary" icon={<Plus size={13} />} loading={creating}>
              新建会话
            </Button>
          </Popconfirm>
        }
      >
        <div className="pi-session-list">
          {!hasBoundFile ? (
            <div className="pi-session-row">
              <div className="pi-session-file">
                <Typography.Text>{boundId}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  等待首条消息写入 session 文件
                </Typography.Text>
              </div>
              <Tag color="green">当前</Tag>
            </div>
          ) : null}
          {chat.piSessions.length === 0 && hasBoundFile ? <Empty description="暂无 session 文件" /> : null}
          {chat.piSessions.map((summary) => {
            const isBound = summary.id === boundId;
            return (
              <div className="pi-session-row" key={summary.filePath}>
                <button
                  className={viewingId === summary.id ? "pi-session-file active" : "pi-session-file"}
                  type="button"
                  onClick={() => void viewSession(summary)}
                >
                  <Typography.Text>{summary.name ?? summary.id}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {summary.messageCount} 条 · {formatDate(summary.updatedAt)}
                  </Typography.Text>
                </button>
                {isBound ? (
                  <Tag color="green">当前</Tag>
                ) : (
                  <Popconfirm
                    title={`把企业微信消息切换到「${summary.name ?? summary.id}」？`}
                    okText="切换"
                    cancelText="取消"
                    onConfirm={() => void switchSession(summary)}
                  >
                    <Button size="small" icon={<RefreshCw size={13} />} loading={switchingId === summary.id}>
                      切换
                    </Button>
                  </Popconfirm>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <Card size="small" title="会话内容" className="pi-session-content-card">
        {loadingDoc ? (
          <div className="pi-session-loading">
            <Spin />
          </div>
        ) : doc === null ? (
          <Empty description="选择一个 session 文件查看原始消息" />
        ) : (
          <div className="entry-list">
            {doc.entries.map((entry, index) => (
              <article className="entry" key={entry.id ?? `${entry.type}-${index}`}>
                <header>
                  <Tag>{entry.message?.role ?? entry.type}</Tag>
                  {entry.id !== undefined ? <Typography.Text type="secondary">{entry.id}</Typography.Text> : null}
                </header>
                <pre>{formatEntry(entry)}</pre>
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
