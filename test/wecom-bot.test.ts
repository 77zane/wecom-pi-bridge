import { afterEach, describe, expect, it, vi } from "vitest";
import { createWeComSdkLogger } from "../src/server/wecom/wecom-bot.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WeCom bot SDK logger", () => {
  it("suppresses SDK debug logs that may include raw message bodies", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createWeComSdkLogger();

    logger.debug("raw body with response_url");

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps SDK info logs as structured bridge logs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = createWeComSdkLogger();

    logger.info("Authenticated");

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
      level: "info",
      event: "wecom.sdk",
      message: "Authenticated"
    });
  });
});
