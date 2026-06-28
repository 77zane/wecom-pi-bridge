import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import {
  BindingStore,
  decodeChatKey,
  encodeChatKey
} from "./bindings/binding-store.js";
import type { AppConfig } from "./config.js";
import {
  listSessionSummaries,
  readSessionFile
} from "./sessions/session-reader.js";

export interface AppServices {
  readonly bindingStore?: BindingStore;
}

const sessionQuerySchema = z.object({
  chatKey: z.string().min(1),
  sessionId: z.string().min(1)
});

export function createApp(config: AppConfig, services: AppServices = {}) {
  const app = Fastify({
    logger: config.nodeEnv !== "test"
  });
  const ownsBindingStore = services.bindingStore === undefined;
  const bindingStore = services.bindingStore ?? new BindingStore(path.join(config.dataDir, "app.db"), config.dataDir);

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
