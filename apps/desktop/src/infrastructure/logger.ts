export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, string | number | boolean | null>;

export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  event: string;
  context?: LogContext;
};

const PRIVATE_KEYS = /api.?key|token|secret|password|credential/i;

function redact(context?: LogContext): LogContext | undefined {
  if (!context) return undefined;
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      PRIVATE_KEYS.test(key) ? "[REDACTED]" : value,
    ]),
  );
}

export function createLogEntry(
  level: LogLevel,
  event: string,
  context?: LogContext,
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    context: redact(context),
  };
}

export function log(
  level: LogLevel,
  event: string,
  context?: LogContext,
) {
  const entry = createLogEntry(level, event, context);
  const method = level === "debug" ? "debug" : level;
  console[method](JSON.stringify(entry));
}
