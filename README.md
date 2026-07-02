# wecom-pi-bridge

`wecom-pi-bridge` 是企业微信智能机器人和本地 Pi RPC 会话之间的桥接服务。

`wecom-pi-bridge` is a bridge between a WeCom intelligent bot and local Pi RPC sessions.

## 项目定位 / Purpose

服务保持平台层尽量薄：接收企业微信消息，按会话绑定稳定 workspace 和 Pi session，把消息投递给 Pi RPC 进程，再把 Pi 的最终回复和文件回传到企业微信。

The service keeps the platform layer deliberately small: it receives WeCom messages, binds each chat to a stable workspace and Pi session, forwards messages to Pi RPC, then sends Pi's final reply and files back to WeCom.

核心原则 / Core principles:

- 一个单聊或群聊对应一个 workspace 和一个 Pi session。
- One single or group chat maps to one workspace and one Pi session.
- 同一会话内的消息串行处理，避免上下文交错。
- Messages in the same chat are processed serially to avoid context interleaving.
- Pi 拥有 session 文件和 workspace 内容，桥接服务不维护第二份对话历史。
- Pi owns session files and workspace contents; the bridge does not keep a second conversation history.
- 桥接服务只剥离机器可读的 `wecom_files` JSON，面向用户的回复尽量按 Pi 原文发送。
- The bridge only removes machine-readable `wecom_files` JSON and otherwise forwards Pi's user-facing text.

## 功能 / Features

- 企业微信智能机器人 WebSocket 接入。
- WeCom intelligent bot WebSocket integration.
- 会话级 workspace、inbox、outbox、`.pi-sessions` 绑定。
- Per-chat workspace, inbox, outbox, and `.pi-sessions` binding.
- Pi RPC 进程启动、复用、状态检查和空闲回收。
- Pi RPC process spawning, reuse, state inspection, and idle cleanup.
- 文本、文件、图片、视频消息转发给 Pi。
- Text, file, image, and video messages are forwarded to Pi.
- Pi 通过 `outbox/` 和 `wecom_files` 指令回传文件。
- Pi can send files through `outbox/` and the `wecom_files` directive.
- Web 运维控制台：查看会话、运行时状态、session 文件、执行控制指令、保护/停止/终结会话。
- Web operations console for sessions, runtime state, session files, control commands, protection, stop, and reset actions.
- 定时任务：全局或单 session 生效，支持 `once`、`cron`、手动立即执行、有序 prompt/control 步骤。
- Scheduled tasks: global or single-session scope, `once`, `cron`, manual run-now, and ordered prompt/control steps.
- 结构化 JSON 日志。
- Structured JSON logs.
- Dockerfile 和 docker-compose 部署入口。
- Dockerfile and docker-compose deployment entry points.

## 架构 / Architecture

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

主要模块 / Main modules:

- `src/server/main.ts`: 服务入口和后台调度器启动。Service entrypoint and background schedulers.
- `src/server/app.ts`: HTTP API 和静态 Web UI。HTTP API and static Web UI serving.
- `src/server/wecom/wecom-bot.ts`: 企业微信 SDK 连接。WeCom SDK connection.
- `src/server/wecom/wecom-bridge.ts`: 企业微信消息入口。WeCom message entrypoint.
- `src/server/wecom/conversation-dispatcher.ts`: prompt 投递、回复回写、文件回传。Prompt dispatch, reply delivery, and outbound files.
- `src/server/wecom/outbound-file-protocol.ts`: `wecom_files` 协议解析。`wecom_files` protocol parsing.
- `src/server/runtime/runtime-manager.ts`: Pi 进程生命周期管理。Pi process lifecycle management.
- `src/server/runtime/chat-message-queue.ts`: 会话级串行队列。Per-chat serialization queue.
- `src/server/pi/pi-rpc-client.ts`: Pi JSONL RPC 客户端。Pi JSONL RPC client.
- `src/server/bindings/binding-store.ts`: 会话绑定和运行策略。Chat bindings and runtime policy.
- `src/server/scheduler/`: 定时任务存储、cron 计算和执行器。Scheduled task store, cron calculation, and executor.
- `src/server/admin/`: 运维会话控制服务。Admin session control service.
- `src/web/main.tsx`: 运维控制台前端。Operations console frontend.

## 环境要求 / Requirements

- Node.js，支持当前 TypeScript/ESM 构建链。
- Node.js compatible with the current TypeScript/ESM toolchain.
- 可执行的 Pi 命令，通过 `PI_COMMAND` 指定。
- A runnable Pi command configured through `PI_COMMAND`.
- 企业微信智能机器人 ID 和 Secret。
- WeCom intelligent bot ID and secret.

## 配置 / Configuration

复制示例环境文件 / Copy the example environment file:

```powershell
Copy-Item .env.example .env
```

关键环境变量 / Important environment variables:

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

- `DATA_DIR`: 数据根目录，保存 SQLite、workspace、session 文件。Data root for SQLite, workspaces, and session files.
- `PI_COMMAND`: Pi 可执行命令或脚本路径。Pi executable or script path.
- `MAX_PROCESSES`: 最大 Pi RPC 进程数。Maximum live Pi RPC processes.
- `IDLE_TIMEOUT_MS`: 空闲多久后可回收进程。Idle duration before cleanup.
- `WECOM_BOT_ID` / `WECOM_BOT_SECRET`: 企业微信机器人凭据。WeCom bot credentials.
- `WECOM_BOT_WS_URL`: 可选 WebSocket 地址覆盖。Optional WebSocket URL override.

## 本地开发 / Development

安装依赖 / Install dependencies:

```powershell
npm install --ignore-scripts
```

启动后端 / Run backend:

```powershell
npm run dev:server
```

启动前端 / Run Web UI:

```powershell
npm run dev:web
```

检查 / Run checks:

```powershell
npm run check
```

构建 / Build:

```powershell
npm run build
```

本地后端会连接企业微信 WebSocket，可能顶掉线上连接；只开发前端时优先只运行 `npm run dev:web`。

The local backend connects to the WeCom WebSocket and may take over the production connection. When only working on the UI, prefer `npm run dev:web`.

## Docker 部署 / Docker Deployment

构建镜像 / Build image:

```bash
docker build -t wecom-pi-bridge:latest .
```

使用 compose / Run with compose:

```bash
docker compose up -d
```

容器默认监听 `3000`，数据挂载到 `/app/data`。

The container listens on `3000` by default and stores data under `/app/data`.

## 数据布局 / Data Layout

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

`app.db` stores chat bindings, runtime policy, and scheduled tasks. Pi writes session content under `.pi-sessions/`.

## 消息流程 / Message Flow

文本消息 / Text messages:

1. 企业微信发送 WebSocket 回调。WeCom sends a WebSocket callback.
2. 桥接服务解析会话身份。The bridge resolves chat identity.
3. 获取或创建 binding、workspace、session。It gets or creates binding, workspace, and session.
4. 消息进入会话级队列。The message enters the per-chat queue.
5. `RuntimeManager` 启动或复用 Pi RPC 进程。`RuntimeManager` starts or reuses Pi RPC.
6. 投递 prompt，等待 Pi `agent_end`。The prompt is delivered and the bridge waits for Pi `agent_end`.
7. 读取最后 assistant 文本。The bridge reads the last assistant text.
8. 剥离 `wecom_files` JSON，回写文本和文件。It strips `wecom_files` JSON and sends text/files back.

群聊回复默认会 @ 原消息发送者；定时任务触发的群聊回复不强制 @ 某个用户。

Group replies mention the original sender by default. Scheduled task replies do not force a mention.

## 附件处理 / Attachments

企业微信文件、图片、视频消息会保存到当前 workspace 的 `inbox/`，然后把相对路径通知 Pi。

WeCom file, image, and video messages are saved under the current workspace `inbox/`; the relative path is forwarded to Pi.

示例 / Example:

```text
用户发送了文件：report.pdf
文件路径：inbox/msg-id/report-random.pdf
请根据用户之前的指令或者根据后续用户的指令做出行动。
```

语音回调按 SDK 提供的 `voice.content` 文本处理；如果企业微信以普通文件形式投递 `.mp3`、`.wav`，则按文件附件保存。

Voice callbacks are handled as `voice.content` text from the SDK. Audio files such as `.mp3` or `.wav` are saved as file attachments when WeCom delivers them as files.

## Pi 文件回传 / Pi Outbound Files

桥接服务会向 Pi 注入一次文件能力说明。该说明只是能力说明：当 Pi 需要让企业微信发送生成文件时，写入 `outbox/` 并在回复中输出 JSON 指令。

The bridge injects a file capability note once per chat. This is a capability note: when Pi needs WeCom to send a generated file, it writes the file under `outbox/` and outputs a JSON directive.

```json
{"wecom_files":[{"path":"outbox/report.xlsx","type":"file"}]}
```

规则 / Rules:

- `path` 必须是相对路径，且位于 `outbox/` 下。
- `path` must be relative and under `outbox/`.
- 推荐 `type: "file"`；旧的 `image`、`voice`、`video` 仍可解析，但实际按普通文件发送。
- Prefer `type: "file"`. Legacy `image`, `voice`, and `video` directives are still accepted but are sent as ordinary file attachments.
- 桥接服务会扫描整段回复，不要求 JSON 必须是最后一行。
- The bridge scans the whole reply; the JSON does not have to be the final line.
- JSON 会从用户可见文本中剥离。
- The JSON is removed from user-facing text.

## 定时任务 / Scheduled Tasks

定时任务用于按时间或手动触发向 Pi session 投递步骤流。

Scheduled tasks deliver ordered steps to Pi sessions by time or manual trigger.

作用范围 / Scope:

- `global`: 对所有已知 session 执行。Runs for all known sessions.
- `session`: 只对指定 session 执行。Runs for one selected session.

计划类型 / Schedule types:

- `once`: 指定时间执行一次。Run once at a specified time.
- `cron`: 五段 cron 表达式。Five-field cron expression.
- “立即执行”按钮：手动执行一次，不改变原计划。Run Now button: manual one-off execution without changing the schedule.

步骤类型 / Step types:

- `prompt`: 按企业微信消息链路投递，Pi 有文本或文件回复就回写企业微信。Delivered like a WeCom message; Pi text and file replies are sent back.
- `control`: 执行 Pi RPC 控制指令，不回写指令结果。Runs a Pi RPC control command without sending the command result to WeCom.

示例 / Example:

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
  },
  {
    "type": "prompt",
    "message": "请根据总结生成下一步行动计划。"
  }
]
```

进程收尾 / Process cleanup:

- 如果定时任务主动拉起了休眠进程，任务完成后会关闭该进程。
- If the scheduler starts a sleeping Pi process, it shuts it down after the task finishes.
- 如果进程原本就在运行，任务不会关闭它。
- If the process was already running, the scheduler leaves it running.

## 运维控制台 / Operations Console

Web UI 提供 / The Web UI provides:

- 会话列表和运行状态。Session list and runtime state.
- 当前模型、thinking、pending、进程 PID。Current model, thinking level, pending count, and PID.
- 读取 Pi session JSONL。Pi session JSONL browsing.
- 全局或单 session 控制指令。Global or single-session control commands.
- 进程保护、停止、终结和重置。Runtime protection, stop, terminate, and reset.
- 全局或单 session 定时任务配置。Global or single-session scheduled task configuration.

主要 API / Main APIs:

- `GET /api/health`
- `GET /api/chats`
- `GET /api/session?chatKey=<chatKey>&sessionId=<sessionId>`
- `GET /api/admin/sessions`
- `POST /api/admin/sessions/control`
- `POST /api/admin/sessions/:sessionKey/control`
- `POST /api/admin/sessions/:sessionKey/stop`
- `POST /api/admin/sessions/:sessionKey/protection`
- `POST /api/admin/sessions/:sessionKey/terminate`
- `GET /api/admin/scheduled-tasks`
- `POST /api/admin/scheduled-tasks`
- `PUT /api/admin/scheduled-tasks/:taskId`
- `DELETE /api/admin/scheduled-tasks/:taskId`
- `POST /api/admin/scheduled-tasks/:taskId/run`

## 进程生命周期 / Process Lifecycle

每个活跃会话最多一个 Pi RPC 进程。

Each active chat has at most one live Pi RPC process.

不会清理进程的情况 / Cleanup is skipped when:

- 正在投递消息。A message is being delivered.
- Pi 正在 streaming。Pi is streaming.
- Pi 正在 compacting。Pi is compacting.
- Pi 有 pending 消息。Pi has pending messages.
- 会话启用了进程保护。Runtime protection is enabled.

关闭顺序 / Shutdown sequence:

1. 关闭 Pi RPC stdin。Close Pi RPC stdin.
2. 等待最多 60 秒。Wait up to 60 seconds.
3. 发送 `SIGTERM`。Send `SIGTERM`.
4. 再短暂等待。Wait briefly again.
5. 发送 `SIGKILL` 兜底。Send `SIGKILL` as fallback.
6. 仍无法确认退出则记录 `kill-timeout`。Record `kill-timeout` if exit cannot be confirmed.

## 日志 / Logs

服务输出结构化 JSON 日志。

The service emits structured JSON logs.

常见事件 / Useful events:

- `message.received`
- `pi.reply`
- `attachment.saved`
- `outbound_file.sent`
- `outbound_file.ignored`
- `scheduled_task.started`
- `scheduled_task.finished`
- `scheduled_task.target_failed`
- `pi.idle_reap_skipped`
- `pi.shutdown_started`
- `pi.shutdown_finished`
- `pi.shutdown_failed`
- `pi.process_removed`
- `service.shutdown`

企业微信 SDK 调试日志默认抑制，避免原始 callback body 和临时 URL 进入日志。

WeCom SDK debug logs are suppressed by default so raw callback bodies and temporary URLs are not written to logs.

## 测试 / Tests

测试覆盖 / The test suite covers:

- 会话绑定和稳定 session ID。Chat binding and stable session IDs.
- Pi RPC 请求/响应、`follow_up`、`agent_end` 和空回复处理。Pi RPC request/response, `follow_up`, `agent_end`, and empty reply handling.
- 运行时容量、空闲回收、保护和关闭。Runtime capacity, idle cleanup, protection, and shutdown.
- 附件保存和通知。Attachment save and notification.
- `wecom_files` 解析和文件路径安全。`wecom_files` parsing and path safety.
- 运维控制 API。Admin control APIs.
- 定时任务执行、cron 时区和 prompt 回写。Scheduled task execution, cron timezone, and prompt reply delivery.
- 前后端类型检查。Server and web type checks.

运行 / Run:

```powershell
npm run check
```

## 安全 / Security

不要提交 `.env`、运行时数据、数据库、日志、session 文件或敏感运维交接文档。

Do not commit `.env`, runtime data, databases, logs, session files, or sensitive operations handoff documents.

发布前建议扫描 / Before publishing, scan for secrets:

```powershell
rg -n --hidden --glob '!node_modules/**' --glob '!data/**' --glob '!logs/**' "WECOM_BOT_SECRET|response_url|secret|token|C:\\Users|Desktop|password"
```

## 当前边界 / Current Boundaries

- 当前没有认证或权限系统，控制台应只暴露在可信网络。
- There is no authentication or permission system; expose the console only on trusted networks.
- 不自动清理历史 workspace 文件。
- Historical workspace files are not automatically cleaned up.
- 不维护独立的业务命令系统。
- No separate business command system is maintained.
- 定时任务依赖已有会话绑定；全局任务只覆盖已知 session。
- Scheduled tasks depend on existing bindings; global tasks only cover known sessions.
