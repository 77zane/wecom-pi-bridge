export type ChatKind = "single" | "group";

export interface ChatBinding {
  readonly botId: string;
  readonly kind: ChatKind;
  readonly externalChatId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly name: string | null;
  readonly filePath: string;
  readonly updatedAt: string | null;
}

