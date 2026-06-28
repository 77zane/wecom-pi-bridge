import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface ChatBinding {
  readonly botId: string;
  readonly kind: "single" | "group";
  readonly externalChatId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
}

interface SessionSummary {
  readonly id: string;
  readonly name: string | null;
  readonly filePath: string;
  readonly updatedAt: string | null;
  readonly messageCount: number;
}

interface ChatListItem {
  readonly chatKey: string;
  readonly binding: ChatBinding;
  readonly sessions: SessionSummary[];
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

function App() {
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [selected, setSelected] = useState<{ chatKey: string; sessionId: string } | null>(null);
  const [session, setSession] = useState<SessionDocument | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.chatKey === selected?.chatKey) ?? null,
    [chats, selected?.chatKey]
  );

  async function loadChats(): Promise<void> {
    setLoadingList(true);
    setError(null);
    try {
      const response = await fetch("/api/chats");
      if (!response.ok) {
        throw new Error(`Failed to load chats: ${response.status}`);
      }
      const body = (await response.json()) as { chats: ChatListItem[] };
      setChats(body.chats);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingList(false);
    }
  }

  async function loadSession(chatKey: string, sessionId: string): Promise<void> {
    setLoadingSession(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        chatKey,
        sessionId
      });
      const response = await fetch(`/api/session?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to load session: ${response.status}`);
      }
      const body = (await response.json()) as { session: SessionDocument };
      setSession(body.session);
      setSelected({ chatKey, sessionId });
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingSession(false);
    }
  }

  useEffect(() => {
    void loadChats();
  }, []);

  return (
    <main className="shell">
      <section className="toolbar">
        <h1>WeCom Pi Bridge</h1>
        <div className="toolbar-actions">
          <button type="button" onClick={() => void loadChats()} disabled={loadingList}>
            刷新列表
          </button>
          <button
            type="button"
            onClick={() => {
              if (selected !== null) {
                void loadSession(selected.chatKey, selected.sessionId);
              }
            }}
            disabled={selected === null || loadingSession}
          >
            刷新会话
          </button>
        </div>
      </section>
      {error !== null ? <section className="error-state">{error}</section> : null}
      <section className="workspace">
        <nav className="chat-list" aria-label="会话列表">
          {chats.length === 0 ? <div className="empty-state">暂无会话</div> : null}
          {chats.map((chat) => (
            <section className="chat-group" key={chat.chatKey}>
              <div className="chat-heading">
                <span>{chat.binding.kind === "single" ? "单聊" : "群聊"}</span>
                <strong>{chat.binding.externalChatId}</strong>
              </div>
              <div className="session-list">
                {chat.sessions.length === 0 ? <div className="muted">暂无 session 文件</div> : null}
                {chat.sessions.map((item) => (
                  <button
                    className={
                      selected?.chatKey === chat.chatKey && selected.sessionId === item.id
                        ? "session-row active"
                        : "session-row"
                    }
                    key={item.id}
                    type="button"
                    onClick={() => void loadSession(chat.chatKey, item.id)}
                  >
                    <span>{item.name ?? item.id}</span>
                    <small>{item.messageCount} 条</small>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </nav>
        <section className="session-detail">
          {session === null ? (
            <div className="empty-state">选择一个 session 查看内容</div>
          ) : (
            <>
              <header className="detail-heading">
                <div>
                  <h2>{session.summary.name ?? session.summary.id}</h2>
                  <p>{selectedChat?.binding.workspacePath}</p>
                </div>
                <span>{session.summary.messageCount} 条消息</span>
              </header>
              <div className="entry-list">
                {session.entries.map((entry, index) => (
                  <article className="entry" key={entry.id ?? `${entry.type}-${index}`}>
                    <header>
                      <span>{entry.message?.role ?? entry.type}</span>
                      {entry.id !== undefined ? <small>{entry.id}</small> : null}
                    </header>
                    <pre>{formatEntry(entry)}</pre>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      </section>
    </main>
  );
}

function formatEntry(entry: RawSessionEntry): string {
  if (entry.message?.content !== undefined) {
    return typeof entry.message.content === "string"
      ? entry.message.content
      : JSON.stringify(entry.message.content, null, 2);
  }

  return JSON.stringify(entry, null, 2);
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
