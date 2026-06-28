# WeCom Pi Bridge 项目总览

## 项目目标

`wecom-pi-bridge` 是一个企业微信智能机器人到 Pi RPC 的桥接服务。

它的核心职责很窄：

- 接收企业微信智能机器人消息。
- 为每个单聊或群聊绑定固定 workspace 和 Pi session。
- 通过 Pi RPC 进程把用户消息转发给 Pi。
- 把 Pi 的最终回复转回企业微信。
- 保存企业微信传来的附件，并把附件路径通知 Pi。
- 读取 Pi 自己生成的 session 文件，在 Web UI 中展示。

平台不负责维护 Pi 会话内容，不编辑 session，不做权限系统，不做复杂业务命令。

## 技术栈

- 后端：Node.js + TypeScript + Fastify
- 前端：React + Vite
- 企业微信接入：`@wecom/aibot-node-sdk`
- Pi 调用：本地 Pi 命令的 RPC 模式，使用 stdin/stdout JSONL 通信
- 本地存储：Node 内置 SQLite，用于 chat binding
- 测试：Vitest

## 开发原则

核心原则是：桥接服务只做转发和必要的运行时管理，不替 Pi 做会话管理，不替用户做业务决策。

- 保持平台职责窄：接消息、排队、启动/复用 Pi RPC、转发回复、保存附件、展示 session。
- Pi 自己拥有 session 文件和 workspace 内容；平台不要维护一份自己的会话内容副本。
- 除 chat binding、附件 inbox、协议注入版本和运行时状态外，尽量不新增平台侧持久状态。
- 不给企业微信用户暴露业务命令；用户只正常对话。
- 不拦截或改写 Pi 的用户可见回复；平台只移除机器可读的 `wecom_files` JSON。
- 文件路径只作为 Pi 可读的本地路径通知，不对用户暴露。
- 遇到企业微信 SDK 或 Pi RPC 行为不确定时，先查官方文档、SDK 类型、源码或做集成验证，不凭空猜实现。
- 优先实现简单闭环，避免提前引入权限、复杂重试、文件清理、摘要、记忆系统等非 MVP 能力。
- 进程生命周期必须保守：Pi 正在执行、streaming、compacting 或有 pending message 时，不回收。
- 对真实运行有影响的行为要有结构化日志，方便从日志判断发生了什么。

## 测试原则

本项目按 TDD 思路开发：先把关键行为写成测试约束，再实现或调整代码。

- 测试不能太薄，不能只为了覆盖率写断言。
- 单元测试用于卡住确定性规则：绑定、路径安全、队列顺序、消息切分、RPC 协议解析、进程回收判断。
- 集成测试很重要，因为企业微信 SDK 和 Pi RPC 的真实行为都不是平台自己完全可控的。
- 对企业微信 SDK 和 Pi RPC 的接口不要靠猜；需要查看 SDK 类型、官方文档、源码，必要时用真实 bot 或真实 Pi RPC 验证。
- 涉及进程生命周期的改动要覆盖：正常 EOF 退出、超时后 kill、kill 后兜底、运行中不回收、服务退出并发回收。
- 涉及消息顺序的改动要覆盖：同 chat 串行、不同 chat 可并行、连续消息不进入 Pi steer。
- 涉及附件的改动要覆盖：保存路径、文件名保留、重名处理、通知文案、非法 outbox 路径拒绝。
- 涉及 Web UI/session 的改动要覆盖：单聊和群聊 session 都能读取，尤其是 chatKey 放在 query 里避免 path 编码问题。
- 每段功能完成后至少跑相关测试；正式收尾时跑 `npm run check`。
- 真实联调中如果需要用户在企微里发消息或文件，由开发者明确说明要测什么、预期观察什么。

## 运行方式

常用命令：

```powershell
npm install --ignore-scripts
npm run dev:server
npm run dev:web
npm run check
```

配置文件是 `.env`，关键项：

- `PI_COMMAND`：Pi 可执行命令或脚本路径。
- `DATA_DIR`：平台数据根目录，默认 `./data`。
- `MAX_PROCESSES`：最多同时运行的 Pi RPC 进程，默认 `50`。
- `IDLE_TIMEOUT_MS`：Pi 进程空闲多久后可被回收，默认 `1800000`。
- `WECOM_BOT_ID` / `WECOM_BOT_SECRET`：企业微信智能机器人配置。

服务启动时会校验企业微信配置、`PI_COMMAND` 是否存在，以及 `DATA_DIR` 是否可写。

## 目录结构

主要源码：

- `src/server/main.ts`：服务入口，组装配置、Fastify、WeCom bot、RuntimeManager。
- `src/server/wecom/wecom-bot.ts`：企业微信 SDK 连接与事件注册。
- `src/server/wecom/wecom-bridge.ts`：企业微信消息到 Pi 的核心转发逻辑。
- `src/server/pi/pi-rpc-client.ts`：Pi RPC stdin/stdout 客户端。
- `src/server/runtime/runtime-manager.ts`：Pi RPC 子进程生命周期管理。
- `src/server/runtime/chat-message-queue.ts`：按 chat 串行处理消息。
- `src/server/bindings/binding-store.ts`：单聊/群聊与 workspace/session 的绑定。
- `src/server/sessions/session-reader.ts`：读取 Pi session jsonl 文件。
- `src/server/app.ts`：Web UI 所需 API。
- `src/web/main.tsx`：Web UI。

数据目录结构大致如下：

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

## 会话与 Workspace 绑定

绑定规则：

- 单聊：一个用户对应一个 workspace 和一个 Pi session。
- 群聊：一个群对应一个 workspace 和一个 Pi session。
- 群聊里不区分多个用户的独立 session，群内消息都进入同一个群 session。

`BindingStore` 会按 `botId + kind + externalChatId` 创建稳定绑定。

Pi session id 是稳定 hash：

```text
s-<sha256(botId, kind, externalChatId) 前 32 位>
```

Pi 启动时会传入：

```text
--mode rpc
--session-id <sessionId>
--session-dir <workspace>/.pi-sessions
--name <externalChatId>
```

## 消息流

文本消息流程：

1. 企业微信 SDK 收到消息。
2. `WeComBridge` 解析 chat 地址。
3. `BindingStore` 获取或创建 workspace/session 绑定。
4. `ChatMessageQueue` 按 chat 串行排队。
5. `RuntimeManager` 获取或创建 Pi RPC 子进程。
6. `PiRpcClient.runUserMessage()` 把消息投递给 Pi，并等待 `agent_end`。
7. 读取 Pi 最后一条 assistant 文本。
8. 桥接服务把结果转成企业微信 markdown 回复。

连续消息不会进入 Pi 内部 steer 模式；平台侧会按 chat 排队，上一条完成后再投递下一条。

## 附件处理

企业微信文件、图片、视频消息按附件处理：

1. 通过 SDK 下载文件。
2. 保存到当前 workspace 的 `inbox/`。
3. 给 Pi 发送一条路径通知。

通知格式：

```text
用户发送了文件：report.pdf
文件路径：inbox/msg-id/report-random.pdf
请根据用户之前的指令或者根据后续用户的指令做出行动。
```

文件名会保留用户原始文件名，并追加随机后缀避免重名。

企业微信 `voice` 消息当前按文本处理，因为 SDK 暴露的是 `voice.content`，含义是企业微信已经给出的语音识别文本。平台不做语音识别，也不保存音频。用户上传的 `.mp3`、`.wav` 等音频文件如果作为文件发送，会走普通附件保存逻辑。

## Pi 发文件给企微

桥接服务会在每个 chat 第一次消息里注入一次文件协议说明，要求 Pi：

- 把要发送的文件写入当前 workspace 的 `outbox/`。
- 在最终回复末尾追加机器可读 JSON。
- 不在面向用户的文本里暴露 `outbox`、`inbox` 或本地路径。

协议示例：

```json
{"wecom_files":[{"path":"outbox/report.xlsx","type":"file"}]}
```

支持的 `type`：

- `file`
- `image`
- `voice`
- `video`

桥接服务只做两件事：

- 从 Pi 回复中移除 `wecom_files` JSON。
- 上传并发送对应文件。

Pi 写给用户看的文本会原样转发，不由平台改写。

出于安全考虑，`wecom_files[].path` 必须是相对路径，并且必须位于 `outbox/` 下。其他路径会被忽略并记录日志。

## Pi RPC 生命周期

`RuntimeManager` 负责 Pi RPC 子进程管理。

关键规则：

- 同一个 chat 复用同一个活 Pi RPC 进程。
- 如果进程已退出，下次消息会按同一个 workspace/session 重新启动。
- 最大进程数由 `MAX_PROCESSES` 控制。
- 空闲回收由 `IDLE_TIMEOUT_MS` 控制。
- 空闲时间从 Pi 回复完成后开始算，不从用户消息到达时开始算。
- 如果桥接层正在投递消息或等待 Pi 回复，进程不会被回收。
- 回收前会查询 Pi RPC state。
- Pi 正在 streaming、compacting 或有 pending message 时，不回收。

关闭流程：

1. 先关闭 Pi RPC stdin，让 Pi 自己退出。
2. 等待 `60s`。
3. 如果没退出，发送 `SIGTERM`。
4. 再短暂等待。
5. 如果仍未退出，发送 `SIGKILL`。
6. 如果依然无法确认退出，记录 `kill-timeout`。

服务退出时，会并发关闭所有活 Pi RPC 子进程。

## Web UI

前端地址：

```text
http://127.0.0.1:5173
```

Web UI 当前能力：

- 展示所有已知单聊和群聊。
- 展示每个 chat 下的 Pi session 文件。
- 点开 session 时读取最新文件内容。
- 提供手动刷新列表和刷新会话按钮。
- 展示所有 session entry，包括 tool call 和原始 JSON 内容。

后端 API：

- `GET /api/health`
- `GET /api/chats`
- `GET /api/session?chatKey=<chatKey>&sessionId=<sessionId>`
- `GET /api/chats/:chatKey/sessions/:sessionId`，保留兼容用

## 日志

服务使用结构化 JSON 日志。

重点事件：

- `message.received`：收到企业微信消息。
- `pi.reply`：Pi 返回完成。
- `attachment.saved`：附件保存完成。
- `outbound_file.sent`：Pi 请求发送的文件已发送。
- `outbound_file.ignored`：Pi 请求发送的文件路径无效。
- `pi.idle_reap_skipped`：空闲回收被跳过。
- `pi.shutdown_started`：开始关闭 Pi RPC 进程。
- `pi.shutdown_finished`：Pi RPC 进程关闭完成。
- `pi.shutdown_failed`：Pi RPC 关闭失败。
- `pi.process_removed`：Pi RPC 进程退出后从运行表移除。
- `service.shutdown`：服务关闭完成。

企业微信 SDK debug 日志已静默，避免输出原始 callback body 和 `response_url`。

## 测试

运行：

```powershell
npm run check
```

`check` 包含：

- server TypeScript 检查
- web TypeScript 检查
- Vitest 全量测试

当前测试覆盖重点：

- binding 创建与稳定 session id
- chat 消息串行队列
- Pi RPC 请求/响应、follow up、agent end、shutdown fallback
- RuntimeManager 复用、容量、空闲回收、活跃任务保护、并发 shutdown
- 企业微信文本、群聊 @、附件保存、混合消息、Pi outbound 文件协议
- session 文件读取和 Web API
- 配置校验

## 当前 MVP 边界

当前暂不做：

- 登录和权限系统。
- session 编辑。
- 复杂失败重试。
- 文件自动清理。
- 多 bot 管理 UI。
- 业务命令系统。
- 自动摘要或记忆系统。

当前需要重点实测：

- Pi 被空闲回收后，再次消息是否恢复同一 workspace 和同一 session。
- 企业微信真实文件、图片、视频、语音输入、混合消息行为。
- Pi 生成 outbox 文件后，企业微信是否能稳定收到。
- 长时间运行后是否出现 `pi.shutdown_failed`、`kill-timeout`、`state_unavailable`。
