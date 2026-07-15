import { useState } from "react";
import { App, Button, Card, Input, Popconfirm, Space, Table, Tag, Typography } from "antd";
import { CalendarPlus, Play, Trash2 } from "lucide-react";
import {
  createScheduledTask,
  deleteScheduledTask,
  runScheduledTask,
  type ChatAdminView,
  type ScheduledExecution,
  type ScheduledTask,
  type ScheduledTaskSchedule,
  type ScheduledTaskStep
} from "../api.js";
import {
  defaultScheduleText,
  defaultStepsText,
  formatDate,
  formatError,
  parseJsonArray,
  parseJsonObject
} from "../constants.js";

export type ScheduleScope = { readonly type: "global" } | { readonly type: "chat"; readonly chat: ChatAdminView };

function formatSchedule(schedule: ScheduledTaskSchedule): string {
  return schedule.type === "once" ? `单次 ${formatDate(schedule.runAt)}` : `cron ${schedule.expression}`;
}

function formatSteps(steps: ScheduledTaskStep[]): string {
  return steps
    .map((step, index) =>
      step.type === "prompt"
        ? `${index + 1}. prompt: ${step.message}`
        : `${index + 1}. control: ${JSON.stringify(step.command)}`
    )
    .join("\n");
}

const statusColors: Record<ScheduledTask["lastStatus"], string> = {
  idle: "default",
  running: "blue",
  success: "green",
  error: "red"
};

/** 定时任务管理，同一组件服务全局和单聊天两种作用域。 */
export function ScheduleTab(props: {
  readonly scope: ScheduleScope;
  readonly tasks: ScheduledTask[];
  readonly executions: ScheduledExecution[];
  readonly onRefresh: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [name, setName] = useState(props.scope.type === "global" ? "全局定时任务" : "定时任务");
  const [scheduleText, setScheduleText] = useState(defaultScheduleText);
  const [stepsText, setStepsText] = useState(defaultStepsText);
  const [creating, setCreating] = useState(false);
  const [rowAction, setRowAction] = useState<string | null>(null);

  const scope = props.scope;
  const visibleTasks =
    scope.type === "global"
      ? props.tasks.filter((task) => task.scope === "global")
      : props.tasks.filter((task) => task.chatKey === scope.chat.chatKey);

  async function create(): Promise<void> {
    setCreating(true);
    try {
      const task = await createScheduledTask({
        name,
        scope: props.scope.type === "global" ? "global" : "session",
        chatKey: props.scope.type === "chat" ? props.scope.chat.chatKey : undefined,
        schedule: parseJsonObject<ScheduledTaskSchedule>(scheduleText, "计划"),
        steps: parseJsonArray<ScheduledTaskStep>(stepsText, "步骤")
      });
      message.success(`定时任务已创建：${task.name}`);
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setCreating(false);
    }
  }

  async function runNow(task: ScheduledTask): Promise<void> {
    setRowAction(`run:${task.id}`);
    try {
      const result = await runScheduledTask(task.id);
      message.success(`立即执行完成：${result.successCount}/${result.targetCount} 成功，失败 ${result.errorCount}`);
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setRowAction(null);
    }
  }

  async function remove(task: ScheduledTask): Promise<void> {
    setRowAction(`delete:${task.id}`);
    try {
      await deleteScheduledTask(task.id);
      message.success("定时任务已删除");
      await props.onRefresh();
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setRowAction(null);
    }
  }

  function latestExecution(taskId: string): ScheduledExecution | undefined {
    return props.executions.find((execution) => execution.taskId === taskId);
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card size="small" title="新建任务">
        <div className="schedule-form">
          <div className="schedule-name">
            <Typography.Text type="secondary">任务名称</Typography.Text>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div>
            <Typography.Text type="secondary">计划 JSON</Typography.Text>
            <Input.TextArea
              className="code-input"
              value={scheduleText}
              onChange={(event) => setScheduleText(event.target.value)}
              autoSize={{ minRows: 4, maxRows: 10 }}
              spellCheck={false}
            />
          </div>
          <div>
            <Typography.Text type="secondary">步骤 JSON</Typography.Text>
            <Input.TextArea
              className="code-input"
              value={stepsText}
              onChange={(event) => setStepsText(event.target.value)}
              autoSize={{ minRows: 4, maxRows: 10 }}
              spellCheck={false}
            />
          </div>
        </div>
        <Button
          type="primary"
          icon={<CalendarPlus size={14} />}
          loading={creating}
          onClick={() => void create()}
          style={{ marginTop: 12 }}
        >
          创建任务
        </Button>
      </Card>
      <Table<ScheduledTask>
        rowKey="id"
        size="small"
        dataSource={visibleTasks}
        pagination={false}
        locale={{ emptyText: "暂无定时任务" }}
        columns={[
          {
            title: "名称",
            dataIndex: "name",
            render: (_, task) => (
              <Space direction="vertical" size={2}>
                <Typography.Text strong>{task.name}</Typography.Text>
                <Typography.Text type="secondary" className="steps-text">
                  {formatSteps(task.steps)}
                </Typography.Text>
              </Space>
            )
          },
          { title: "计划", render: (_, task) => formatSchedule(task.schedule), width: 180 },
          { title: "下次执行", render: (_, task) => formatDate(task.nextRunAt), width: 170 },
          {
            title: "上次状态",
            width: 200,
            render: (_, task) => {
              const execution = latestExecution(task.id);
              return (
                <Space direction="vertical" size={2}>
                  <Tag color={statusColors[task.lastStatus]}>{task.lastStatus}</Tag>
                  {task.lastError !== null ? (
                    <Typography.Text type="danger" className="steps-text">
                      {task.lastError}
                    </Typography.Text>
                  ) : null}
                  {execution !== undefined ? (
                    <Typography.Text type="secondary" className="steps-text">
                      最近{execution.trigger === "manual" ? "手动" : "定时"}：{execution.successCount}/
                      {execution.targetCount} 成功，{formatDate(execution.finishedAt ?? execution.startedAt)}
                    </Typography.Text>
                  ) : null}
                </Space>
              );
            }
          },
          {
            title: "操作",
            width: 200,
            render: (_, task) => (
              <Space>
                <Button
                  size="small"
                  icon={<Play size={13} />}
                  loading={rowAction === `run:${task.id}`}
                  onClick={() => void runNow(task)}
                >
                  立即执行
                </Button>
                <Popconfirm
                  title={`删除定时任务「${task.name}」？`}
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => void remove(task)}
                >
                  <Button size="small" danger icon={<Trash2 size={13} />} loading={rowAction === `delete:${task.id}`}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            )
          }
        ]}
      />
    </Space>
  );
}
