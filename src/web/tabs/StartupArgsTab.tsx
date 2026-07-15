import { useState } from "react";
import { Alert, App, Button, Card, Input, Popconfirm, Space, Tag, Typography } from "antd";
import { Eraser, RotateCcw, Save } from "lucide-react";
import {
  clearWorkspaceStartupArgs,
  restartChatRuntime,
  restartRuntimes,
  saveGlobalStartupArgs,
  saveWorkspaceStartupArgs,
  type ChatAdminView
} from "../api.js";
import { formatError, formatJson, parseStartupArgsText, startupArgExamples } from "../constants.js";

export type StartupScope = { readonly type: "global"; readonly globalArgs: string[] } | { readonly type: "chat"; readonly chat: ChatAdminView };

/**
 * 启动参数编辑，同一组件服务全局和单个聊天两种作用域。
 * 作用域切换时由父层通过 key 重新挂载，草稿不跨目标残留。
 */
export function StartupArgsTab(props: { readonly scope: StartupScope; readonly onRefresh: () => Promise<void> }) {
  const { message } = App.useApp();
  const initialText =
    props.scope.type === "global"
      ? formatJson(props.scope.globalArgs)
      : formatJson(props.scope.chat.startup.workspaceArgs ?? []);
  const [argsText, setArgsText] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const effectiveArgs = props.scope.type === "global" ? props.scope.globalArgs : props.scope.chat.startup.args;
  const source = props.scope.type === "chat" ? props.scope.chat.startup.source : "global";
  const sourceText = source === "workspace" ? "使用本聊天配置" : source === "global" ? "继承全局配置" : "未配置";

  async function save(restart: boolean): Promise<void> {
    setSaving(true);
    try {
      const args = parseStartupArgsText(argsText);
      if (props.scope.type === "global") {
        const saved = await saveGlobalStartupArgs(args);
        setArgsText(formatJson(saved));
        if (restart) {
          const results = await restartRuntimes("running");
          message.success(`全局启动参数已保存，已重启 ${results.length} 个活跃进程`);
        } else {
          message.success("全局启动参数已保存，新进程启动时生效");
        }
      } else {
        const binding = await saveWorkspaceStartupArgs(props.scope.chat.chatKey, args);
        setArgsText(formatJson(binding.startupArgs ?? []));
        if (restart) {
          await restartChatRuntime(props.scope.chat.chatKey);
          message.success("启动参数已保存并重启进程");
        } else {
          message.success("启动参数已保存，新进程启动时生效");
        }
      }
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearAndInherit(restart: boolean): Promise<void> {
    if (props.scope.type !== "chat") return;
    setClearing(true);
    try {
      await clearWorkspaceStartupArgs(props.scope.chat.chatKey);
      setArgsText("[]");
      if (restart) {
        await restartChatRuntime(props.scope.chat.chatKey);
        message.success("已改为继承全局启动参数并重启进程");
      } else {
        message.success("已改为继承全局启动参数");
      }
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setClearing(false);
    }
  }

  const busy = saving || clearing;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {props.scope.type === "chat" ? (
        <Alert
          type="info"
          showIcon
          message={
            <Space size={8}>
              当前来源
              <Tag color={source === "workspace" ? "blue" : "default"}>{sourceText}</Tag>
              <Typography.Text type="secondary">
                本聊天配置会整体覆盖全局配置（不是拼接）；保存空数组 [] 表示覆盖为不加任何参数。
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
      <div className="startup-grid">
        <Card size="small" title="启动参数 JSON" className="startup-editor-card">
          <Input.TextArea
            className="code-input"
            value={argsText}
            onChange={(event) => setArgsText(event.target.value)}
            autoSize={{ minRows: 10, maxRows: 20 }}
            spellCheck={false}
          />
        </Card>
        <Card size="small" title="写法示例">
          <div className="example-list">
            {startupArgExamples.map((example) => (
              <button
                className="example-item"
                type="button"
                key={example.label}
                onClick={() => setArgsText(formatJson(example.args))}
              >
                <strong>{example.label}</strong>
                <small>{example.note}</small>
                <code>{JSON.stringify(example.args)}</code>
              </button>
            ))}
          </div>
        </Card>
        <Card size="small" title="当前生效参数">
          <pre className="code-block">{formatJson(effectiveArgs)}</pre>
        </Card>
        <Card size="small" title="注意">
          <ul className="notes-list">
            <li>必须是 JSON 数组，参数和值分开写。</li>
            <li>布尔参数单独写一个元素，重复参数就重复写。</li>
            <li>文件路径必须是 Pi 进程所在容器内可读路径。</li>
            <li>核心参数（--mode/--session-id/--session-dir 等）由桥接固定注入，配置了也会被拦截。</li>
            <li>保存只写数据库；修改后需重启 Pi 进程才会生效。</li>
          </ul>
        </Card>
      </div>
      <Space wrap>
        {props.scope.type === "chat" ? (
          <>
            <Button icon={<Eraser size={14} />} onClick={() => void clearAndInherit(false)} loading={clearing} disabled={busy}>
              清空并继承全局
            </Button>
            <Popconfirm
              title="继承全局并重启进程？"
              okText="继承并重启"
              cancelText="取消"
              onConfirm={() => void clearAndInherit(true)}
            >
              <Button icon={<RotateCcw size={14} />} disabled={busy}>
                继承并重启
              </Button>
            </Popconfirm>
          </>
        ) : null}
        <Button type="primary" icon={<Save size={14} />} onClick={() => void save(false)} loading={saving} disabled={busy}>
          保存
        </Button>
        <Popconfirm
          title={props.scope.type === "global" ? "保存并重启全部活跃进程？" : "保存并重启当前进程？"}
          description="重启只关闭进程让其按新参数启动，不会切换 Pi 会话，不删除数据。"
          okText="保存并重启"
          cancelText="取消"
          onConfirm={() => void save(true)}
        >
          <Button danger icon={<RotateCcw size={14} />} disabled={busy}>
            保存并重启
          </Button>
        </Popconfirm>
      </Space>
    </Space>
  );
}
