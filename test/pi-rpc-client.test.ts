import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiRpcClient,
  buildPiRpcArgs,
  type PiRpcProcess,
  type PiRpcState
} from "../src/server/pi/pi-rpc-client.js";

class FakePiProcess extends EventEmitter implements PiRpcProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  killed = false;
  killedWith: NodeJS.Signals | number | undefined;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killedWith = signal;
    this.killSignals.push(signal);
    return true;
  }
}

function readJsonLine(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      stream.off("data", onData);
      resolve(JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>);
    };
    stream.on("data", onData);
  });
}

function writeResponse(process: FakePiProcess, request: Record<string, unknown>, data: unknown): void {
  process.stdout.write(
    `${JSON.stringify({
      id: request.id,
      type: "response",
      command: request.type,
      success: true,
      data
    })}\n`
  );
}

const idleState: PiRpcState = {
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  sessionId: "s-1234",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0
};

afterEach(() => {
  vi.useRealTimers();
});

describe("PiRpcClient", () => {
  it("builds Pi RPC process arguments from the binding", () => {
    expect(
      buildPiRpcArgs({
        sessionId: "s-abc",
        sessionDir: "C:\\data\\sessions",
        sessionName: "User A"
      })
    ).toEqual(["--mode", "rpc", "--session-id", "s-abc", "--session-dir", "C:\\data\\sessions", "--name", "User A"]);
  });

  it("sends get_state and resolves the correlated response", async () => {
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const statePromise = client.getState();
    const request = await readJsonLine(process.stdin);
    writeResponse(process, request, idleState);

    await expect(statePromise).resolves.toMatchObject({
      isStreaming: false,
      pendingMessageCount: 0,
      sessionId: "s-1234"
    });
  });

  it("sends model and thinking control commands over the same RPC channel", async () => {
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const setModelPromise = client.setModel("deepseek", "deepseek-v4-pro");
    const setModelRequest = await readJsonLine(process.stdin);
    expect(setModelRequest).toMatchObject({
      type: "set_model",
      provider: "deepseek",
      modelId: "deepseek-v4-pro"
    });
    writeResponse(process, setModelRequest, {
      provider: "deepseek",
      id: "deepseek-v4-pro",
      api: "openai-completions"
    });

    await expect(setModelPromise).resolves.toMatchObject({
      provider: "deepseek",
      id: "deepseek-v4-pro"
    });

    const setThinkingPromise = client.setThinkingLevel("high");
    const setThinkingRequest = await readJsonLine(process.stdin);
    expect(setThinkingRequest).toMatchObject({
      type: "set_thinking_level",
      level: "high"
    });
    writeResponse(process, setThinkingRequest, null);

    await expect(setThinkingPromise).resolves.toBeUndefined();
  });

  it("lists available models and forwards generic control commands without starting a user turn", async () => {
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const modelsPromise = client.getAvailableModels();
    const modelsRequest = await readJsonLine(process.stdin);
    expect(modelsRequest).toMatchObject({
      type: "get_available_models"
    });
    writeResponse(process, modelsRequest, {
      models: [
        {
          provider: "deepseek",
          id: "deepseek-v4-flash",
          api: "openai-completions"
        }
      ]
    });

    await expect(modelsPromise).resolves.toEqual([
      expect.objectContaining({
        provider: "deepseek",
        id: "deepseek-v4-flash"
      })
    ]);

    const commandPromise = client.sendControlCommand({
      type: "set_auto_compaction",
      enabled: false
    });
    const commandRequest = await readJsonLine(process.stdin);
    expect(commandRequest).toMatchObject({
      type: "set_auto_compaction",
      enabled: false
    });
    writeResponse(process, commandRequest, null);

    await expect(commandPromise).resolves.toBeUndefined();
  });

  it("uses prompt when Pi is idle", async () => {
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const deliveryPromise = client.deliverUserMessage("hello");
    const stateRequest = await readJsonLine(process.stdin);
    writeResponse(process, stateRequest, idleState);
    const promptRequest = await readJsonLine(process.stdin);
    writeResponse(process, promptRequest, null);

    await expect(deliveryPromise).resolves.toBe("prompt");
    expect(promptRequest).toMatchObject({
      type: "prompt",
      message: "hello"
    });
  });

  it("uses follow_up when Pi is streaming or has pending messages", async () => {
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const deliveryPromise = client.deliverUserMessage("next");
    const stateRequest = await readJsonLine(process.stdin);
    writeResponse(process, stateRequest, {
      ...idleState,
      isStreaming: true,
      pendingMessageCount: 1
    });
    const followUpRequest = await readJsonLine(process.stdin);
    writeResponse(process, followUpRequest, null);

    await expect(deliveryPromise).resolves.toBe("follow_up");
    expect(followUpRequest).toMatchObject({
      type: "follow_up",
      message: "next"
    });
  });

  it("waits for agent_end and reads the last assistant text", async () => {
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const resultPromise = client.runUserMessage("hello");
    const stateRequest = await readJsonLine(process.stdin);
    writeResponse(process, stateRequest, idleState);
    const promptRequest = await readJsonLine(process.stdin);
    writeResponse(process, promptRequest, null);

    process.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [], willRetry: false })}\n`);

    const lastTextRequest = await readJsonLine(process.stdin);
    writeResponse(process, lastTextRequest, { text: "final answer" });

    await expect(resultPromise).resolves.toBe("final answer");
    expect(lastTextRequest).toMatchObject({
      type: "get_last_assistant_text"
    });
  });

  it("treats a missing last assistant text as an empty reply", async () => {
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const resultPromise = client.runUserMessage("hello");
    const stateRequest = await readJsonLine(process.stdin);
    writeResponse(process, stateRequest, idleState);
    const promptRequest = await readJsonLine(process.stdin);
    writeResponse(process, promptRequest, null);

    process.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [], willRetry: false })}\n`);

    const lastTextRequest = await readJsonLine(process.stdin);
    writeResponse(process, lastTextRequest, {});

    await expect(resultPromise).resolves.toBe("");
  });

  it("rejects cleanly when the process exits while delivering a message", async () => {
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const resultPromise = client.runUserMessage("hello");
    await readJsonLine(process.stdin);
    process.emit("exit", 1, null);

    await expect(resultPromise).rejects.toThrow("Pi RPC process exited");
  });

  it("shuts down by ending stdin and waiting for Pi to exit", async () => {
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const shutdownPromise = client.shutdown(60_000);

    expect(process.stdin.writableEnded).toBe(true);
    expect(process.killed).toBe(false);
    process.emit("exit", 0, null);

    await expect(shutdownPromise).resolves.toBe("exited");
  });

  it("falls back to SIGTERM when Pi does not exit within the grace period", async () => {
    vi.useFakeTimers();
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const shutdownPromise = client.shutdown(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(process.killed).toBe(true);
    expect(process.killedWith).toBe("SIGTERM");
    process.emit("exit", null, "SIGTERM");

    await expect(shutdownPromise).resolves.toBe("killed");
  });

  it("does not wait forever when the process ignores kill signals", async () => {
    vi.useFakeTimers();
    const process = new FakePiProcess();
    const client = new PiRpcClient(process);

    const shutdownPromise = client.shutdown(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(process.killSignals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(shutdownPromise).resolves.toBe("kill-timeout");
  });
});
