import { z } from "zod";

/**
 * Every adapter (Claude Code, Codex, SDK) normalizes into this one event shape.
 * The schema is strict on purpose: an unknown field fails validation, so nothing beyond
 * this metadata (no code, prompts, diffs or file contents) can ride along by accident.
 */
export const SCHEMA_VERSION = 1;

export const SOURCES = ["claude-code", "codex", "sdk"] as const;

export const EVENT_TYPES = [
  "session.start",
  "prompt.submit",
  "tool.start",
  "tool.end",
  "permission.request",
  "session.waiting",
  "subagent.stop",
  /** One turn finished (Claude Code's Stop hook); the session stays open until session.end. */
  "turn.end",
  "session.end",
] as const;

export const STATUSES = ["ok", "error", "waiting"] as const;

/** Targets are short labels (a relative path, a command name, a hostname), never content. */
export const MAX_TARGET_LENGTH = 80;

export const Usage = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    model: z.string().min(1).optional(),
  })
  .strict();
export type Usage = z.infer<typeof Usage>;

export const FoxholeEvent = z
  .object({
    v: z.literal(SCHEMA_VERSION),
    id: z.string().uuid(),
    ts: z.string().datetime(),
    source: z.enum(SOURCES),
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    parentSessionId: z.string().min(1).nullable(),
    type: z.enum(EVENT_TYPES),
    tool: z.string().min(1).optional(),
    target: z.string().max(MAX_TARGET_LENGTH).nullable().optional(),
    status: z.enum(STATUSES).optional(),
    /** For subagent events: the agent's type label (e.g. "Explore"), never its prompt or output. */
    agentType: z.string().min(1).max(MAX_TARGET_LENGTH).optional(),
    usage: Usage.optional(),
    repo: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  })
  .strict();
export type FoxholeEvent = z.infer<typeof FoxholeEvent>;
export type EventType = (typeof EVENT_TYPES)[number];

/** Event types that were renamed; events logged before a rename are read under the new name. */
const RENAMED_TYPES: Readonly<Record<string, EventType>> = { "session.stop": "turn.end" };

/** Brings an event written by an older version up to the current shape. Call it before validating logged events. */
export function upgradeEvent(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const type = (input as { type?: unknown }).type;
  const renamed = typeof type === "string" ? RENAMED_TYPES[type] : undefined;
  return renamed ? { ...input, type: renamed } : input;
}

export function parseEvent(input: unknown): FoxholeEvent {
  return FoxholeEvent.parse(input);
}

export function safeParseEvent(input: unknown) {
  return FoxholeEvent.safeParse(input);
}
