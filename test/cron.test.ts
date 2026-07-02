import { describe, expect, it } from "vitest";
import { nextCronDate } from "../src/server/scheduler/cron.js";

describe("cron scheduler", () => {
  it("computes the next run in the configured timezone", () => {
    const next = nextCronDate("0 9 * * *", new Date("2026-07-01T09:50:00.000Z"), "Asia/Shanghai");

    expect(next?.toISOString()).toBe("2026-07-02T01:00:00.000Z");
  });
});
