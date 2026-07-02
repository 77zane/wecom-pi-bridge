# wecom-pi-bridge

**中文** | [English](./README.md)

`wecom-pi-bridge` 是企业微信智能机器人和本地 Pi RPC 会话之间的桥接服务。它接收企业微信消息，按会话绑定稳定 workspace/session，把 prompt 投递给 Pi，并把 Pi 的文本和文件回复回传到企业微信。

## 功能

- 企业微信智能机器人 WebSocket 接入。
- 会话级 workspace、inbox、outbox、`.pi-sessions` 绑定。
- Pi RPC 进程启动、复用、空闲回收和进程保护控制。
- 文本、文件、图片、视频消息转发。
- Pi 通过 `outbox/` 和 `wecom_files` 指令回传文件。
- 运维控制台：会话状态、Pi 控制指令、session JSONL 查看、进程控制和定时任务。
- 定时任务：全局或单 session 生效，支持 `once`、`cron`、手动立即执行、有序 `prompt` / `control` 步骤。
- 结构化 JSON 日志。
- Dockerfile 和 docker-compose 部署入口。

## 架构

```text
WeCom Bot
  |
  | WebSocket callbacks
  v
WeComBridge
  |
  | per-chat queue
  v
ConversationDispatcher
  |
  | RuntimeManager
  v
Pi RPC process
  |
  | Pi-owned jsonl session files
  v
Workspace/.pi-sessions
```

主要模块：

- `src/server/main.ts`: 服务入口和后台调度器启动。
- `src/server/app.ts`: HTTP API 和静态 Web UI。
- `src/server/wecom/wecom-bot.ts`: 企业微信 SDK 连接。
- `src/server/wecom/wecom-bridge.ts`: 企业微信消息入口。
- `src/server/wecom/conversation-dispatcher.ts`: prompt 投递、回复回写、文件回传。
- `src/server/runtime/runtime-manager.ts`: Pi 进程生命周期管理。
- `src/server/pi/pi-rpc-client.ts`: Pi JSONL RPC 客户端。
- `src/server/bindings/binding-store.ts`: 会话绑定和运行策略。
- `src/server/scheduler/`: 定时任务存储、cron 计算和执行器。
- `src/server/admin/`: 运维会话控制服务。
- `src/web/main.tsx`: 运维控制台前端。

## 环境要求

- Node.js，支持当前 TypeScript/ESM 构建链。
- 可执行的 Pi 命令，通过 `PI_COMMAND` 指定。
- 企业微信智能机器人 ID 和 Secret。

## 配置

复制示例环境文件：

```powershell
Copy-Item .env.example .env
```

关键环境变量：

```env
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
DATA_DIR=./data
PI_COMMAND=pi
MAX_PROCESSES=50
IDLE_TIMEOUT_MS=1800000
WECOM_BOT_ID=
WECOM_BOT_SECRET=
WECOM_BOT_WS_URL=
```

- `DATA_DIR`: 数据根目录，保存 SQLite、workspace、session 文件。
- `PI_COMMAND`: Pi 可执行命令或脚本路径。
- `MAX_PROCESSES`: 最大 Pi RPC 进程数。
- `IDLE_TIMEOUT_MS`: 空闲多久后可回收进程。
- `WECOM_BOT_ID` / `WECOM_BOT_SECRET`: 企业微信机器人凭据。
- `WECOM_BOT_WS_URL`: 可选 WebSocket 地址覆盖。

## 本地开发

```powershell
npm install --ignore-scripts
npm run dev:server
npm run dev:web
npm run check
npm run build
```

本地后端会连接企业微信 WebSocket，可能顶掉线上连接；只开发前端时优先只运行 `npm run dev:web`。

## Docker 部署

```bash
docker build -t wecom-pi-bridge:latest .
docker compose up -d
```

容器默认监听 `3000`，数据保存到 `/app/data`。

## 数据布局

```text
data/
  app.db
  workspaces/
    wecom/
      <botId>/
        single/
          <userId>/
            .pi-sessions/
            inbox/
            outbox/
        group/
          <chatId>/
            .pi-sessions/
            inbox/
            outbox/
```

`app.db` 保存会话绑定、运行策略和定时任务。Pi session 内容由 Pi 写入 `.pi-sessions/`。

## 消息流程

1. 企业微信发送 WebSocket 回调。
2. 桥接服务解析会话身份。
3. 获取或创建 binding、workspace、session。
4. 消息进入会话级队列。
5. `RuntimeManager` 启动或复用 Pi RPC。
6. 投递 prompt，等待 Pi `agent_end`。
7. 读取最后 assistant 文本。
8. 剥离 `wecom_files` JSON，回写文本和文件。

群聊回复默认会 @ 原消息发送者；定时任务触发的群聊回复不强制 @ 某个用户。

## 附件处理

企业微信文件、图片、视频消息会保存到当前 workspace 的 `inbox/`，然后把相对路径通知 Pi：

```text
用户发送了文件：report.pdf
文件路径：inbox/msg-id/report-random.pdf
请根据用户之前的指令或者根据后续用户的指令做出行动。
```

语音回调按 SDK 提供的 `voice.content` 文本处理；如果企业微信以普通文件形式投递 `.mp3`、`.wav`，则按文件附件保存。

## Pi 文件回传

桥接服务会向 Pi 注入一次文件能力说明。该说明只是能力说明：当 Pi 需要让企业微信发送生成文件时，写入 `outbox/` 并在回复中输出 JSON 指令。

```json
{"wecom_files":[{"path":"outbox/report.xlsx","type":"file"}]}
```

规则：

- `path` 必须是相对路径，且位于 `outbox/` 下。
- 推荐 `type: "file"`；旧的 `image`、`voice`、`video` 仍可解析，但实际按普通文件发送。
- 桥接服务会扫描整段回复，不要求 JSON 必须是最后一行。
- JSON 会从用户可见文本中剥离。

## 定时任务

定时任务用于按时间或手动触发向 Pi session 投递步骤流。

作用范围：

- `global`: 对所有已知 session 执行。
- `session`: 只对指定 session 执行。

计划类型：

- `once`: 指定时间执行一次。
- `cron`: 五段 cron 表达式。
- “立即执行”按钮：手动执行一次，不改变原计划。

步骤类型：

- `prompt`: 按企业微信消息链路投递，Pi 有文本或文件回复就回写企业微信。
- `control`: 执行 Pi RPC 控制指令，不回写指令结果。

示例：

```json
[
  {
    "type": "control",
    "command": {
      "type": "set_thinking_level",
      "level": "high"
    }
  },
  {
    "type": "prompt",
    "message": "请总结当前会话最近的待办事项。"
  }
]
```

如果定时任务主动拉起了休眠进程，任务完成后会关闭该进程；如果进程原本就在运行，任务不会关闭它。

## 运维控制台

Web UI 提供：

- 会话列表和运行状态。
- 当前模型、thinking、pending、进程 PID。
- 读取 Pi session JSONL。
- 全局或单 session 控制指令。
- 进程保护、停止、终结和重置。
- 全局或单 session 定时任务配置。

主要 API：

- `GET /api/health`
- `GET /api/chats`
- `GET /api/session?chatKey=<chatKey>&sessionId=<sessionId>`
- `GET /api/admin/sessions`
- `POST /api/admin/sessions/control`
- `POST /api/admin/sessions/:sessionKey/control`
- `GET /api/admin/scheduled-tasks`
- `POST /api/admin/scheduled-tasks`
- `PUT /api/admin/scheduled-tasks/:taskId`
- `DELETE /api/admin/scheduled-tasks/:taskId`
- `POST /api/admin/scheduled-tasks/:taskId/run`

## 日志

常见结构化日志事件：

- `message.received`
- `pi.reply`
- `attachment.saved`
- `outbound_file.sent`
- `outbound_file.ignored`
- `scheduled_task.started`
- `scheduled_task.finished`
- `scheduled_task.target_failed`
- `pi.shutdown_started`
- `pi.shutdown_finished`
- `service.shutdown`

企业微信 SDK 调试日志默认抑制，避免原始 callback body 和临时 URL 进入日志。

## 测试

```powershell
npm run check
```

测试覆盖会话绑定、Pi RPC、运行时生命周期、附件、文件回传、运维 API、定时任务、cron 时区和类型检查。

## 安全

不要提交 `.env`、运行时数据、数据库、日志、session 文件或敏感运维交接文档。

发布前建议扫描：

```powershell
rg -n --hidden --glob '!node_modules/**' --glob '!data/**' --glob '!logs/**' "WECOM_BOT_SECRET|response_url|secret|token|C:\\Users|Desktop|password"
```

## 当前边界

- 当前没有认证或权限系统，控制台应只暴露在可信网络。
- 不自动清理历史 workspace 文件。
- 不维护独立的业务命令系统。
- 定时任务依赖已有会话绑定；全局任务只覆盖已知 session。
