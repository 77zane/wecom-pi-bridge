# wecom-pi-bridge

`wecom-pi-bridge` is a bridge between a WeCom intelligent bot and local Pi RPC sessions.

The service keeps the platform layer deliberately small: it receives WeCom messages, binds each chat to a stable workspace/session, forwards messages to a Pi RPC process, and sends Pi's final reply back to WeCom.

## Core Principles

- The bridge only forwards messages, files, and minimal runtime metadata.
- Pi owns session files and workspace contents.
- The bridge does not keep a second copy of Pi conversation history.
- One single chat maps to one workspace and one Pi session.
- One group chat maps to one workspace and one Pi session.
- Messages inside the same chat are processed serially.
- Pi user-facing replies are forwarded as Pi wrote them.
- The bridge only removes machine-readable `wecom_files` JSON from Pi replies.
- Users do not get bridge-specific business commands in the WeCom bot.

## Features

- WeCom intelligent bot WebSocket connection through `@wecom/aibot-node-sdk`.
- Per-chat stable workspace and Pi session binding.
- Local Pi RPC process spawning and reuse.
- Per-chat message queue to avoid interleaving consecutive user messages.
- Idle Pi process cleanup with conservative state checks.
- Graceful Pi shutdown through stdin EOF before signal-based fallback.
- Incoming file/image/video attachment download into the chat workspace.
- Outbound file delivery from Pi through an `outbox/` JSON directive.
- Read-only Web UI for browsing Pi session files.
- Structured logs for message flow, file flow, and process lifecycle.

## Architecture

```text
WeCom Bot
  |
  | WebSocket callbacks
  v
WeComBridge
  |
  | per-chat queue
  v
RuntimeManager
  |
  | spawn/reuse local process
  v
Pi RPC process
  |
  | Pi-owned jsonl session files
  v
Workspace/.pi-sessions
```

Main modules:

- `src/server/main.ts`: service entrypoint.
- `src/server/wecom/wecom-bot.ts`: WeCom SDK connection and event registration.
- `src/server/wecom/wecom-bridge.ts`: WeCom-to-Pi forwarding logic.
- `src/server/runtime/runtime-manager.ts`: Pi process lifecycle management.
- `src/server/runtime/chat-message-queue.ts`: per-chat serialization.
- `src/server/pi/pi-rpc-client.ts`: stdin/stdout JSONL RPC client for Pi.
- `src/server/bindings/binding-store.ts`: chat-to-workspace/session bindings.
- `src/server/sessions/session-reader.ts`: Pi session jsonl reader.
- `src/server/app.ts`: HTTP API for the Web UI.
- `src/web/main.tsx`: read-only session browser UI.

For a deeper design note, see [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md).

## Requirements

- Node.js with TypeScript strip-compatible runtime support.
- A local Pi command available through `PI_COMMAND`.
- A WeCom intelligent bot with WebSocket credentials.

## Installation

```powershell
npm install --ignore-scripts
```

Copy the example environment file:

```powershell
Copy-Item .env.example .env
```

Then fill in local values in `.env`.

## Configuration

`.env.example`:

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

Important settings:

- `PI_COMMAND`: local Pi executable or script path.
- `DATA_DIR`: bridge data root.
- `MAX_PROCESSES`: maximum live Pi RPC processes.
- `IDLE_TIMEOUT_MS`: idle duration before a Pi process may be cleaned up.
- `WECOM_BOT_ID`: WeCom intelligent bot ID.
- `WECOM_BOT_SECRET`: WeCom intelligent bot secret.
- `WECOM_BOT_WS_URL`: optional custom WeCom WebSocket URL.

Startup validation checks that WeCom credentials exist, `PI_COMMAND` can be resolved, and `DATA_DIR` is writable.

## Development

Run the backend:

```powershell
npm run dev:server
```

Run the Web UI:

```powershell
npm run dev:web
```

Open:

```text
http://127.0.0.1:5173
```

Run checks:

```powershell
npm run check
```

`npm run check` performs server type checking, web type checking, and the Vitest test suite.

## Data Layout

The bridge stores runtime data under `DATA_DIR`.

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

`app.db` stores chat bindings only. Pi session content is stored by Pi under `.pi-sessions/`.

## Message Flow

For text messages:

1. WeCom sends a WebSocket callback.
2. The bridge resolves the chat identity.
3. The bridge gets or creates the chat binding.
4. The message enters the per-chat queue.
5. `RuntimeManager` gets or starts the matching Pi RPC process.
6. The bridge sends the user message to Pi.
7. The bridge waits for Pi `agent_end`.
8. The bridge reads Pi's last assistant text.
9. The bridge sends the final reply back to WeCom.

For group chats, replies mention the original sender.

## Attachment Handling

WeCom file, image, and video messages are downloaded into the current chat workspace `inbox/`.

The bridge forwards a plain path notification to Pi:

```text
用户发送了文件：report.pdf
文件路径：inbox/msg-id/report-random.pdf
请根据用户之前的指令或者根据后续用户的指令做出行动。
```

The original filename is preserved and a random suffix is added to avoid collisions.

WeCom `voice` callbacks are handled as text because the SDK exposes `voice.content`, which is the text content WeCom provides for that voice input. The bridge does not perform speech recognition. Audio files such as `.mp3` or `.wav` are handled as normal file attachments when WeCom delivers them as file messages.

## Pi Outbound Files

The bridge injects a file protocol instruction once per chat.

When Pi wants WeCom to send a generated file, Pi should write it under the current workspace `outbox/` and append a JSON directive to the final reply:

```json
{"wecom_files":[{"path":"outbox/report.xlsx","type":"file"}]}
```

Supported types:

- `file`
- `image`
- `voice`
- `video`

The bridge removes the machine-readable directive from the user-facing reply, uploads the file to WeCom, and sends it to the chat.

Only relative paths under `outbox/` are accepted.

## Process Lifecycle

Each active chat can have one live Pi RPC process.

The process is not cleaned up while:

- the bridge is delivering a message,
- Pi is streaming,
- Pi is compacting,
- Pi has pending messages.

Idle time starts after Pi finishes replying.

Shutdown sequence:

1. Close Pi RPC stdin so Pi can exit by itself.
2. Wait up to 60 seconds.
3. Send `SIGTERM` if it has not exited.
4. Wait briefly.
5. Send `SIGKILL` as a final fallback.
6. Record `kill-timeout` if the process still cannot be confirmed exited.

On service shutdown, live Pi RPC processes are closed concurrently.

## Web UI

The Web UI is read-only.

It can:

- list known single and group chats,
- list Pi session files,
- open the selected session file,
- show raw session entries including tool calls,
- refresh chat/session data manually.

HTTP API:

- `GET /api/health`
- `GET /api/chats`
- `GET /api/session?chatKey=<chatKey>&sessionId=<sessionId>`

## Logs

The service emits structured JSON logs.

Useful event names:

- `message.received`
- `pi.reply`
- `attachment.saved`
- `outbound_file.sent`
- `outbound_file.ignored`
- `pi.idle_reap_skipped`
- `pi.shutdown_started`
- `pi.shutdown_finished`
- `pi.shutdown_failed`
- `pi.process_removed`
- `service.shutdown`

WeCom SDK debug logs are suppressed by default so raw callback bodies and response URLs are not written to logs.

## Security And Privacy

Do not commit `.env`, runtime data, logs, or local session files.

The repository `.gitignore` excludes:

- `.env` and `.env.*`, except `.env.example`
- `data/`
- `logs/`
- `node_modules/`
- generated database and log files

Before publishing, scan for credentials and local identifiers:

```powershell
rg -n --hidden --glob '!node_modules/**' --glob '!data/**' --glob '!logs/**' "WECOM_BOT_SECRET|response_url|secret|token|C:\\Users|Desktop"
```

## Tests

The test suite covers:

- chat binding and stable session IDs,
- per-chat queue ordering,
- Pi RPC request/response parsing,
- Pi `follow_up` behavior,
- Pi shutdown fallback behavior,
- runtime capacity and idle cleanup,
- active-operation protection,
- attachment save and notification behavior,
- outbound `wecom_files` parsing,
- session file reading,
- Web API session lookup,
- startup configuration validation.

Run:

```powershell
npm run check
```

## Current MVP Boundaries

Not included yet:

- authentication or permission control,
- session editing,
- complex retry policy,
- automatic file cleanup,
- multi-bot management UI,
- business command system,
- memory or summarization system.

Recommended real-world validation:

- Send a message, wait for idle cleanup, then send another message and confirm the same workspace/session is resumed.
- Test WeCom file, image, video, voice input, and mixed messages.
- Ask Pi to generate a file into `outbox/` and verify WeCom receives it.
- Watch logs for `pi.shutdown_failed`, `kill-timeout`, and repeated `state_unavailable`.
