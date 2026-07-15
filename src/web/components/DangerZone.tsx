import { useState } from "react";
import { Alert, Button, Card, Input, Modal, Space, Typography } from "antd";
import { AlertTriangle } from "lucide-react";

export interface DangerAction {
  readonly key: string;
  readonly buttonLabel: string;
  readonly title: string;
  readonly description: string;
  /** 用户必须原样输入这段文本才能执行。 */
  readonly confirmText: string;
  readonly onConfirm: () => Promise<void>;
}

/**
 * 危险操作统一入口：红色卡片 + 输入确认文本的二次确认弹窗。
 * 替代旧版散落在指令面板里的 window.confirm。
 */
export function DangerZone({ actions }: { readonly actions: DangerAction[] }) {
  const [activeAction, setActiveAction] = useState<DangerAction | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [running, setRunning] = useState(false);

  function openAction(action: DangerAction): void {
    setConfirmInput("");
    setActiveAction(action);
  }

  async function confirm(): Promise<void> {
    if (activeAction === null) return;
    setRunning(true);
    try {
      await activeAction.onConfirm();
      setActiveAction(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card
      className="danger-zone"
      size="small"
      title={
        <Space size={8}>
          <AlertTriangle size={16} />
          危险区
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        {actions.map((action) => (
          <div className="danger-row" key={action.key}>
            <div>
              <Typography.Text strong>{action.title}</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {action.description}
              </Typography.Paragraph>
            </div>
            <Button danger onClick={() => openAction(action)}>
              {action.buttonLabel}
            </Button>
          </div>
        ))}
      </Space>
      <Modal
        title={activeAction?.title}
        open={activeAction !== null}
        okText="确认执行"
        okButtonProps={{ danger: true, disabled: confirmInput !== activeAction?.confirmText, loading: running }}
        cancelText="取消"
        onOk={() => void confirm()}
        onCancel={() => setActiveAction(null)}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Alert type="error" showIcon message={activeAction?.description} />
          <Typography.Text>
            输入 <Typography.Text code>{activeAction?.confirmText}</Typography.Text> 以确认：
          </Typography.Text>
          <Input
            value={confirmInput}
            onChange={(event) => setConfirmInput(event.target.value)}
            placeholder={activeAction?.confirmText}
            autoFocus
          />
        </Space>
      </Modal>
    </Card>
  );
}
