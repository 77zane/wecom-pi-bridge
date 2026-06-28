import { WSClient } from "@wecom/aibot-node-sdk";
import type {
  FileMessage,
  ImageMessage,
  Logger,
  MixedMessage,
  SendMsgBody,
  TextMessage,
  VideoMessage,
  WeComMediaType,
  VoiceMessage,
  WsFrame
} from "@wecom/aibot-node-sdk";
import type { AppConfig } from "../config.js";
import { logError, logInfo, logWarn } from "../logging.js";
import type { WeComBridge, WeComDownloader, WeComSender } from "./wecom-bridge.js";

export interface RunningWeComBot {
  disconnect(): void;
}

export function startWeComBot(config: AppConfig, createBridge: (client: WSClient) => WeComBridge): RunningWeComBot | null {
  if (config.wecomBotId.length === 0 || config.wecomBotSecret.length === 0) {
    return null;
  }

  const client = new WSClient({
    botId: config.wecomBotId,
    secret: config.wecomBotSecret,
    logger: createWeComSdkLogger(),
    ...(config.wecomBotWsUrl.length > 0 ? { wsUrl: config.wecomBotWsUrl } : {})
  });

  registerWeComHandlers(client, createBridge(client));
  client.connect();

  return {
    disconnect: () => {
      client.disconnect();
    }
  };
}

export function createWeComSdkLogger(): Logger {
  return {
    debug: () => {},
    info: (message: string) => {
      logInfo("wecom.sdk", {
        message
      });
    },
    warn: (message: string) => {
      logWarn("wecom.sdk", {
        message
      });
    },
    error: (message: string) => {
      logError("wecom.sdk", message);
    }
  };
}

export function createWeComSender(client: WSClient): WeComSender {
  return {
    sendMessage: async (chatId: string, body: SendMsgBody) => {
      await client.sendMessage(chatId, body);
    },
    uploadMedia: async (buffer: Buffer, options: { readonly type: WeComMediaType; readonly filename: string }) => {
      const result = await client.uploadMedia(buffer, options);
      return { mediaId: result.media_id };
    },
    sendMediaMessage: async (chatId: string, type: WeComMediaType, mediaId: string) => {
      await client.sendMediaMessage(chatId, type, mediaId);
    }
  };
}

export function createWeComDownloader(client: WSClient): WeComDownloader {
  return {
    downloadFile: (url: string, aesKey?: string) => client.downloadFile(url, aesKey)
  };
}

function registerWeComHandlers(client: WSClient, bridge: WeComBridge): void {
  client.on("message.text", (frame: WsFrame<TextMessage>) => {
    handleFrame(frame, (body) => bridge.handleTextMessage(body));
  });
  client.on("message.file", (frame: WsFrame<FileMessage>) => {
    handleFrame(frame, (body) => bridge.handleFileMessage(body));
  });
  client.on("message.image", (frame: WsFrame<ImageMessage>) => {
    handleFrame(frame, (body) => bridge.handleImageMessage(body));
  });
  client.on("message.video", (frame: WsFrame<VideoMessage>) => {
    handleFrame(frame, (body) => bridge.handleVideoMessage(body));
  });
  client.on("message.voice", (frame: WsFrame<VoiceMessage>) => {
    handleFrame(frame, (body) => bridge.handleVoiceMessage(body));
  });
  client.on("message.mixed", (frame: WsFrame<MixedMessage>) => {
    handleFrame(frame, (body) => bridge.handleMixedMessage(body));
  });
}

function handleFrame<T>(frame: WsFrame<T>, handler: (body: T) => Promise<void>): void {
  void withBody(frame, handler).catch((error: unknown) => {
    console.error("Failed to handle WeCom message", error);
  });
}

async function withBody<T>(frame: WsFrame<T>, handler: (body: T) => Promise<void>): Promise<void> {
  if (frame.body === undefined) {
    return;
  }

  await handler(frame.body);
}
