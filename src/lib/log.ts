// Structured logging (review P2).
//
// The app logged with bare `console.log`/`console.error` and free-form strings:
//
//     console.error("yandex oauth error", e);
//
// In production that is a plain line in a container's stdout with no level, no
// timestamp, no tenant and no request correlation. You cannot filter by
// organization, alert on an error rate, or follow one request across the proxy,
// the agent and an adapter. Log aggregators (Loki, CloudWatch, Datadog) all
// index JSON fields, so a line like the above is effectively unsearchable.
//
// This module emits ONE JSON object per line with a stable shape:
//
//     {"ts":"2026-08-30T12:00:00.000Z","level":"error","msg":"oauth exchange failed",
//      "org":1,"platform":"yandex","err":"invalid_grant"}
//
// Deliberately dependency-free (no pino/winston): it writes to stdout/stderr,
// which is what every container platform collects, and keeps the bundle lean.
//
// Usage:
//     import { log } from "@/lib/log";
//     log.info("campaign paused", { org, campaignId });
//     log.error("oauth exchange failed", { platform: "yandex" }, err);

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Minimum level to emit. LOG_LEVEL=debug in dev, info by default. */
function minLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  return LEVEL_ORDER[raw as LogLevel] ?? LEVEL_ORDER.info;
}

/** Pretty, human-readable lines locally; JSON in production. */
function prettyOutput(): boolean {
  if (process.env.LOG_FORMAT === "json") return false;
  if (process.env.LOG_FORMAT === "pretty") return true;
  return process.env.NODE_ENV !== "production";
}

export interface LogFields {
  /** Tenant — the single most useful filter in a multi-tenant system. */
  org?: number | null;
  userId?: number | null;
  /** Correlates every line emitted while handling one request. */
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Normalize an unknown thrown value into loggable fields.
 * Never let logging itself throw, and never swallow the stack in dev.
 */
function errorFields(err: unknown): Record<string, unknown> {
  if (err == null) return {};
  if (err instanceof Error) {
    return {
      err: err.message,
      errName: err.name,
      // Stacks are noisy in aggregated production logs but essential locally.
      ...(process.env.NODE_ENV === "production" ? {} : { stack: err.stack }),
    };
  }
  return { err: String(err) };
}

/**
 * Redact obvious secrets so a token can never reach the log stream.
 * Keys are matched case-insensitively on a substring, so `x-api-key`,
 * `refreshToken` and `client_secret` are all covered.
 */
const SECRET_KEY = /(token|secret|password|api[-_]?key|authorization|cookie)/i;

function sanitize(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : v;
  }
  return out;
}

function emit(level: LogLevel, msg: string, fields: LogFields = {}, err?: unknown): void {
  if (LEVEL_ORDER[level] < minLevel()) return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...sanitize(fields),
    ...errorFields(err),
  };

  // Warnings and errors go to stderr so platforms that split streams classify
  // them correctly.
  const sink = level === "error" || level === "warn" ? console.error : console.log;

  if (prettyOutput()) {
    const { ts, level: _l, msg: _m, ...rest } = payload;
    const extras = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
    sink(`${String(ts).slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${msg}${extras}`);
    return;
  }
  sink(JSON.stringify(payload));
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields, err?: unknown) => emit("warn", msg, fields, err),
  error: (msg: string, fields?: LogFields, err?: unknown) => emit("error", msg, fields, err),
};
