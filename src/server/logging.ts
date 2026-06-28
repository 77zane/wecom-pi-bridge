export type LogDetails = Record<string, string | number | boolean | null | undefined>;

export function logInfo(event: string, details: LogDetails = {}): void {
  writeLog("info", event, details);
}

export function logWarn(event: string, details: LogDetails = {}): void {
  writeLog("warn", event, details);
}

export function logError(event: string, error: unknown, details: LogDetails = {}): void {
  const errorDetails =
    error instanceof Error
      ? {
          errorName: error.name,
          errorMessage: error.message
        }
      : {
          errorMessage: String(error)
        };

  writeLog("error", event, {
    ...details,
    ...errorDetails
  });
}

function writeLog(level: "info" | "warn" | "error", event: string, details: LogDetails): void {
  const payload = {
    level,
    event,
    time: new Date().toISOString(),
    ...details
  };

  if (level === "error") {
    console.error(JSON.stringify(payload));
    return;
  }

  if (level === "warn") {
    console.warn(JSON.stringify(payload));
    return;
  }

  console.info(JSON.stringify(payload));
}
