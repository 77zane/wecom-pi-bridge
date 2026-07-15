import path from "node:path";
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import { AdminSessionService } from "./admin/session-admin-service.js";
import {
  BindingStore,
  decodeChatKey,
  encodeChatKey
} from "./bindings/binding-store.js";
import type { AppConfig } from "./config.js";
import type { PiQueueMode, PiRpcControlCommand, PiThinkingLevel } from "./pi/pi-rpc-client.js";
import type { ChatMessageQueue } from "./runtime/chat-message-queue.js";
import type { RuntimeManager } from "./runtime/runtime-manager.js";
import type { ScheduledTaskService } from "./scheduler/scheduled-task-service.js";
import type { ScheduledTaskInput, ScheduledTaskSchedule, ScheduledTaskStep } from "./scheduler/scheduled-task-store.js";
import {
  listSessionSummaries,
  readSessionFile
} from "./sessions/session-reader.js";

export interface AppServices {
  readonly bindingStore?: BindingStore;
  readonly runtime?: RuntimeManager;
  readonly queue?: ChatMessageQueue;
  readonly scheduledTasks?: ScheduledTaskService;
}

const sessionQuerySchema = z.object({
  chatKey: z.string().min(1),
  sessionId: z.string().min(1)
});

const thinkingLevelSchema = z.union([
  z.literal("off"),
  z.literal("minimal"),
  z.literal("low"),
  z.literal("medium"),
  z.literal("high"),
  z.literal("xhigh")
]);
const queueModeSchema = z.union([z.literal("all"), z.literal("one-at-a-time")]);
const controlCommandSchema: z.ZodType<PiRpcControlCommand> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("get_state") }),
  z.object({ type: z.literal("get_messages") }),
  z.object({ type: z.literal("get_available_models") }),
  z.object({ type: z.literal("set_model"), provider: z.string().min(1), modelId: z.string().min(1) }),
  z.object({ type: z.literal("cycle_model") }),
  z.object({ type: z.literal("set_thinking_level"), level: thinkingLevelSchema }),
  z.object({ type: z.literal("cycle_thinking_level") }),
  z.object({ type: z.literal("set_steering_mode"), mode: queueModeSchema }),
  z.object({ type: z.literal("set_follow_up_mode"), mode: queueModeSchema }),
  z.object({ type: z.literal("compact"), customInstructions: z.string().optional() }),
  z.object({ type: z.literal("set_auto_compaction"), enabled: z.boolean() }),
  z.object({ type: z.literal("set_auto_retry"), enabled: z.boolean() }),
  z.object({ type: z.literal("abort_retry") }),
  z.object({ type: z.literal("abort") }),
  z.object({ type: z.literal("new_session"), parentSession: z.string().optional() }),
  z.object({ type: z.literal("get_session_stats") }),
  z.object({ type: z.literal("bash"), command: z.string().min(1) }),
  z.object({ type: z.literal("abort_bash") }),
  z.object({ type: z.literal("export_html"), outputPath: z.string().optional() }),
  z.object({ type: z.literal("switch_session"), sessionPath: z.string().min(1) }),
  z.object({ type: z.literal("fork"), entryId: z.string().min(1) }),
  z.object({ type: z.literal("clone") }),
  z.object({ type: z.literal("get_commands") }),
  z.object({ type: z.literal("set_session_name"), name: z.string() })
]) as z.ZodType<PiRpcControlCommand>;
const controlBodySchema = z.object({
  command: controlCommandSchema
});
const broadcastControlBodySchema = controlBodySchema.extend({
  scope: z.union([z.literal("running"), z.literal("all")])
});
const terminateBodySchema = z.object({
  scope: z.literal("all")
});
const restartBodySchema = z.object({
  scope: z.union([z.literal("running"), z.literal("all")])
});
const runtimePolicyBodySchema = z.object({
  idleReapingEnabled: z.boolean()
});
const sessionProtectionBodySchema = z.object({
  protectedRuntime: z.boolean()
});
const startupArgsBodySchema = z.object({
  args: z.array(z.string())
});
const newSessionBodySchema = z.object({
  parentSession: z.string().min(1).optional()
});
const switchSessionBodySchema = z.object({
  sessionId: z.string().min(1)
});
const scheduledTaskScheduleSchema: z.ZodType<ScheduledTaskSchedule> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), runAt: z.string().datetime(), timezone: z.string().optional() }),
  z.object({ type: z.literal("cron"), expression: z.string().min(1), timezone: z.string().optional() })
]);
const scheduledTaskStepSchema: z.ZodType<ScheduledTaskStep> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), message: z.string().min(1) }),
  z.object({ type: z.literal("control"), command: controlCommandSchema })
]);
const scheduledTaskBodySchema: z.ZodType<ScheduledTaskInput> = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean(),
    scope: z.union([z.literal("global"), z.literal("session")]),
    sessionKey: z.string().optional(),
    schedule: scheduledTaskScheduleSchema,
    steps: z.array(scheduledTaskStepSchema).min(1)
  })
  .superRefine((value, context) => {
    if (value.scope === "session" && (value.sessionKey === undefined || value.sessionKey.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "sessionKey is required for session scoped tasks",
        path: ["sessionKey"]
      });
    }
  }) as z.ZodType<ScheduledTaskInput>;

void (thinkingLevelSchema satisfies z.ZodType<PiThinkingLevel>);
void (queueModeSchema satisfies z.ZodType<PiQueueMode>);

export function createApp(config: AppConfig, services: AppServices = {}) {
  const app = Fastify({
    logger: config.nodeEnv !== "test"
  });
  const ownsBindingStore = services.bindingStore === undefined;
  const bindingStore = services.bindingStore ?? new BindingStore(path.join(config.dataDir, "app.db"), config.dataDir);
  const adminSessionService = new AdminSessionService(bindingStore, services.runtime, services.queue);
  const scheduledTasks = services.scheduledTasks;

  app.addHook("onClose", async () => {
    if (ownsBindingStore) {
      bindingStore.close();
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "wecom-pi-bridge"
  }));

  app.get("/api/chats", async () => {
    const bindings = bindingStore.listAll();
    const chats = await Promise.all(
      bindings.map(async (binding) => ({
        chatKey: encodeChatKey(binding),
        binding,
        sessions: await listSessionSummaries(binding.sessionDir)
      }))
    );

    return { chats };
  });

  app.get("/api/admin/sessions", async () => ({
    runtimePolicy: adminSessionService.getRuntimePolicy(),
    startupArgs: adminSessionService.getGlobalStartupArgs(),
    sessions: await adminSessionService.listSessions()
  }));

  app.get("/api/admin/runtime-policy", async () => ({
    runtimePolicy: adminSessionService.getRuntimePolicy()
  }));

  app.get("/api/admin/startup-args", async () => ({
    startupArgs: adminSessionService.getGlobalStartupArgs()
  }));

  app.put("/api/admin/startup-args", async (request, reply) => {
    const body = startupArgsBodySchema.parse(request.body);
    try {
      return {
        startupArgs: adminSessionService.setGlobalStartupArgs(body.args)
      };
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/admin/runtime-policy", async (request) => {
    const body = runtimePolicyBodySchema.parse(request.body);
    return {
      runtimePolicy: adminSessionService.setRuntimePolicy(body)
    };
  });

  app.post("/api/admin/sessions/:sessionKey/control", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);
    const body = controlBodySchema.parse(request.body);

    try {
      const control = await adminSessionService.sendControlCommand(params.sessionKey, body.command);
      return {
        result: control.result,
        startedRuntime: control.startedRuntime,
        stoppedRuntime: control.stoppedRuntime
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Session not found") {
        return reply.code(404).send({ error: message });
      }
      if (message.startsWith("No live Pi process")) {
        return reply.code(409).send({ error: message });
      }

      throw error;
    }
  });

  app.post("/api/admin/sessions/control", async (request) => {
    const body = broadcastControlBodySchema.parse(request.body);
    return {
      scope: body.scope,
      results: await adminSessionService.broadcastControlCommand(body.command, body.scope)
    };
  });

  app.post("/api/admin/sessions/terminate", async (request) => {
    const body = terminateBodySchema.parse(request.body);
    return {
      scope: body.scope,
      results: await adminSessionService.terminateAllSessions()
    };
  });

  app.post("/api/admin/sessions/restart", async (request) => {
    const body = restartBodySchema.parse(request.body);
    return {
      scope: body.scope,
      results: await adminSessionService.restartRuntimes(body.scope)
    };
  });

  app.post("/api/admin/sessions/:sessionKey/stop", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);
    const stop = await adminSessionService.stopSession(params.sessionKey);
    if (stop === undefined) {
      return reply.code(404).send({ error: "session not found" });
    }

    return { stop };
  });

  app.post("/api/admin/sessions/:sessionKey/restart", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);
    const restart = await adminSessionService.restartSessionRuntime(params.sessionKey);
    if (restart === undefined) {
      return reply.code(404).send({ error: "session not found" });
    }

    return { restart };
  });

  app.put("/api/admin/sessions/:sessionKey/startup-args", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);
    const body = startupArgsBodySchema.parse(request.body);

    try {
      const binding = adminSessionService.setWorkspaceStartupArgs(params.sessionKey, body.args);
      if (binding === undefined) {
        return reply.code(404).send({ error: "session not found" });
      }

      return { binding };
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/admin/sessions/:sessionKey/startup-args", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);
    const binding = adminSessionService.clearWorkspaceStartupArgs(params.sessionKey);
    if (binding === undefined) {
      return reply.code(404).send({ error: "session not found" });
    }

    return { binding };
  });

  app.post("/api/admin/sessions/:sessionKey/protection", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);
    const body = sessionProtectionBodySchema.parse(request.body);

    try {
      const protection = await adminSessionService.setSessionProtection(params.sessionKey, body.protectedRuntime);
      if (protection === undefined) {
        return reply.code(404).send({ error: "session not found" });
      }

      return { protection };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Pi process limit reached")) {
        return reply.code(409).send({ error: message });
      }

      throw error;
    }
  });

  app.post("/api/admin/sessions/:sessionKey/new-session", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);
    const body = newSessionBodySchema.parse(request.body ?? {});

    try {
      const session = await adminSessionService.createAndBindNewSession(params.sessionKey, body.parentSession);
      if (session === undefined) {
        return reply.code(404).send({ error: "session not found" });
      }

      return { session };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Pi process limit reached")) {
        return reply.code(409).send({ error: message });
      }

      throw error;
    }
  });

  app.post("/api/admin/sessions/:sessionKey/switch-session", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);
    const body = switchSessionBodySchema.parse(request.body);

    try {
      const session = await adminSessionService.switchAndBindSession(params.sessionKey, body.sessionId);
      if (session === undefined) {
        return reply.code(404).send({ error: "session not found" });
      }

      return { session };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Session file not found") {
        return reply.code(404).send({ error: message });
      }
      if (message.startsWith("Pi process limit reached")) {
        return reply.code(409).send({ error: message });
      }

      throw error;
    }
  });

  app.post("/api/admin/sessions/:sessionKey/terminate", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);

    try {
      const terminate = await adminSessionService.terminateSession(params.sessionKey);
      if (terminate === undefined) {
        return reply.code(404).send({ error: "session not found" });
      }

      return { terminate };
    } catch {
      return reply.code(404).send({ error: "session not found" });
    }
  });

  app.post("/api/admin/sessions/:sessionKey/reset", async (request, reply) => {
    const params = z
      .object({
        sessionKey: z.string().min(1)
      })
      .parse(request.params);

    try {
      const reset = await adminSessionService.resetSession(params.sessionKey);
      if (reset === undefined) {
        return reply.code(404).send({ error: "session not found" });
      }

      return { reset };
    } catch {
      return reply.code(404).send({ error: "session not found" });
    }
  });

  app.get("/api/admin/scheduled-tasks", async () => {
    if (scheduledTasks === undefined) {
      return {
        tasks: [],
        executions: []
      };
    }

    return {
      tasks: scheduledTasks.listTasks(),
      executions: scheduledTasks.listExecutions()
    };
  });

  app.post("/api/admin/scheduled-tasks", async (request) => {
    if (scheduledTasks === undefined) {
      throw new Error("Scheduled task service is not available");
    }

    const body = scheduledTaskBodySchema.parse(request.body);
    return {
      task: scheduledTasks.createTask(body)
    };
  });

  app.put("/api/admin/scheduled-tasks/:taskId", async (request, reply) => {
    if (scheduledTasks === undefined) {
      throw new Error("Scheduled task service is not available");
    }

    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const body = scheduledTaskBodySchema.parse(request.body);
    const task = scheduledTasks.updateTask(params.taskId, body);
    if (task === undefined) {
      return reply.code(404).send({ error: "task not found" });
    }

    return { task };
  });

  app.delete("/api/admin/scheduled-tasks/:taskId", async (request, reply) => {
    if (scheduledTasks === undefined) {
      throw new Error("Scheduled task service is not available");
    }

    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    if (!scheduledTasks.deleteTask(params.taskId)) {
      return reply.code(404).send({ error: "task not found" });
    }

    return { deleted: true };
  });

  app.post("/api/admin/scheduled-tasks/:taskId/run", async (request, reply) => {
    if (scheduledTasks === undefined) {
      throw new Error("Scheduled task service is not available");
    }

    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const result = await scheduledTasks.runTaskNow(params.taskId);
    if (result === undefined) {
      return reply.code(404).send({ error: "task not found" });
    }

    return { result };
  });

  app.get("/api/session", async (request, reply) => {
    const query = sessionQuerySchema.parse(request.query);
    return readSessionByChatKey(bindingStore, query.chatKey, query.sessionId, reply);
  });

  app.get("/api/chats/:chatKey/sessions/:sessionId", async (request, reply) => {
    const params = z
      .object({
        chatKey: z.string().min(1),
        sessionId: z.string().min(1)
      })
      .parse(request.params);

    return readSessionByChatKey(bindingStore, params.chatKey, params.sessionId, reply);
  });

  if (config.nodeEnv === "production") {
    const webRoot = path.join(process.cwd(), "dist", "web");
    if (existsSync(webRoot)) {
      void app.register(fastifyStatic, {
        root: webRoot,
        prefix: "/"
      });
      app.setNotFoundHandler((request, reply) => {
        if (request.raw.url?.startsWith("/api/") === true) {
          return reply.code(404).send({ error: "not found" });
        }

        return reply.sendFile("index.html");
      });
    }
  }

  return app;
}

async function readSessionByChatKey(
  bindingStore: BindingStore,
  chatKey: string,
  sessionId: string,
  reply: {
    code(statusCode: number): {
      send(payload: unknown): unknown;
    };
  }
): Promise<unknown> {
  let identity: ReturnType<typeof decodeChatKey>;
  try {
    identity = decodeChatKey(chatKey);
  } catch {
    return reply.code(404).send({ error: "chat not found" });
  }

  const binding = bindingStore.getByIdentity(identity);
  if (binding === undefined) {
    return reply.code(404).send({ error: "chat not found" });
  }

  const summaries = await listSessionSummaries(binding.sessionDir);
  const summary = summaries.find((item) => item.id === sessionId);
  if (summary === undefined) {
    return reply.code(404).send({ error: "session not found" });
  }

  return {
    session: await readSessionFile(summary.filePath)
  };
}
