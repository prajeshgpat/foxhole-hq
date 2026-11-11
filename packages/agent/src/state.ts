import {
  ENDING_TYPES,
  PERMISSION_CLEARING_TYPES,
  type EventType,
  type FoxholeEvent,
} from "@foxhole-hq/schema";

/**
 * Folds the event stream into one current state per session (PLAN.md 4 and 8.1), so a client can
 * fetch a snapshot instead of replaying history. Everything here is pure: no I/O, no clock reads
 * (`now` is an argument), and the inputs are never mutated.
 */

/** A session with no events for this long is shown as asleep (PLAN.md 8.1: "quiet for a long time"). */
export const QUIET_ASLEEP_MS = 30 * 60 * 1000;

/** Sessions asleep (ended, or quiet-asleep) for longer than this many days are left out of snapshots. */
export const DEFAULT_RETENTION_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Epoch of the pure fold, which has no server run behind it. */
export const FOLD_EPOCH = "0";

/** `stuck` and `done` are in the plan but need health rules and PR data; nothing produces them yet. */
export type SessionStatus = "needs-you" | "stuck" | "working" | "idle" | "done" | "asleep";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string | null;
}

export interface SessionState {
  sessionId: string;
  parentSessionId: string | null;
  source: FoxholeEvent["source"];
  machineId: string;
  /** Opaque: whatever the adapter put in the event. */
  repo: string | null;
  branch: string | null;
  agentType: string | null;
  status: SessionStatus;
  /** ISO time the current status began. */
  statusSince: string;
  lastEventAt: string;
  /** Set while a tool call is open (tool.start seen, tool.end not yet). */
  currentTool: string | null;
  currentTarget: string | null;
  /** Completed turns (turn.end events). */
  turnCount: number;
  /** Tool calls started. */
  toolCallCount: number;
  /** tool.end events with status "error". */
  errorCount: number;
  pendingPermission: boolean;
  usage: SessionUsage;
}

export interface Snapshot {
  /**
   * Id of the last event folded, in the server's SSE form `<epoch>-<n>`, or null when there are none
   * yet. The pure fold uses `FOLD_EPOCH` and the event's zero-based position in the array it was given.
   */
  version: string | null;
  generatedAt: string;
  sessions: SessionState[];
}

/** Session records as folded so far, before `now` is applied. Never mutated once built. */
export type SessionMap = ReadonlyMap<string, SessionState>;

const STATUS_ORDER: readonly SessionStatus[] = ["needs-you", "stuck", "working", "idle", "done", "asleep"];

/** Events after which no tool call can still be open. */
const CLEARS_TOOL: ReadonlySet<EventType> = new Set([
  "session.start",
  "prompt.submit",
  "tool.end",
  "turn.end",
  "session.end",
  "subagent.stop",
]);

function newSession(e: FoxholeEvent): SessionState {
  return {
    sessionId: e.sessionId,
    parentSessionId: e.parentSessionId,
    source: e.source,
    machineId: e.machineId,
    repo: null,
    branch: null,
    agentType: null,
    status: "idle",
    statusSince: e.ts,
    lastEventAt: e.ts,
    currentTool: null,
    currentTarget: null,
    turnCount: 0,
    toolCallCount: 0,
    errorCount: 0,
    pendingPermission: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: null },
  };
}

/** The status after this event. An ended session ignores everything except a restart. */
function nextStatus(current: SessionStatus, type: EventType): SessionStatus {
  if (type === "session.start") return "idle";
  if (type === "prompt.submit") return "working";
  if (ENDING_TYPES.has(type)) return "asleep";
  if (current === "asleep") return "asleep";
  switch (type) {
    case "tool.start":
    case "tool.end":
      return "working";
    case "permission.request":
      return "needs-you";
    case "session.waiting":
      // an unanswered permission request outranks "waiting for input"
      return current === "needs-you" ? "needs-you" : "idle";
    case "turn.end":
      return "idle";
    default:
      return current;
  }
}

function addUsage(total: SessionUsage, usage: FoxholeEvent["usage"]): SessionUsage {
  if (!usage) return total;
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    model: usage.model ?? total.model,
  };
}

function currentToolAfter(s: SessionState, e: FoxholeEvent, status: SessionStatus) {
  if (e.type === "tool.start" && status !== "asleep") {
    return { currentTool: e.tool ?? null, currentTarget: e.target ?? null };
  }
  if (CLEARS_TOOL.has(e.type)) return { currentTool: null, currentTarget: null };
  return { currentTool: s.currentTool, currentTarget: s.currentTarget };
}

/** A permission request stays pending until the next sign of progress (the shared clearing set). */
function pendingAfter(s: SessionState, e: FoxholeEvent, status: SessionStatus): boolean {
  if (status === "asleep" || e.type === "session.start") return false;
  if (e.type === "permission.request") return true;
  return s.pendingPermission && !PERMISSION_CLEARING_TYPES.has(e.type);
}

function applyOne(s: SessionState, e: FoxholeEvent): SessionState {
  const status = nextStatus(s.status, e.type);
  return {
    ...s,
    parentSessionId: s.parentSessionId ?? e.parentSessionId,
    repo: e.repo ?? s.repo,
    branch: e.branch ?? s.branch,
    agentType: e.agentType ?? s.agentType,
    status,
    statusSince: status === s.status ? s.statusSince : e.ts,
    lastEventAt: e.ts,
    ...currentToolAfter(s, e, status),
    turnCount: s.turnCount + (e.type === "turn.end" ? 1 : 0),
    toolCallCount: s.toolCallCount + (e.type === "tool.start" ? 1 : 0),
    errorCount: s.errorCount + (e.type === "tool.end" && e.status === "error" ? 1 : 0),
    pendingPermission: pendingAfter(s, e, status),
    usage: addUsage(s.usage, e.usage),
  };
}

/**
 * Folds events into `state` in place. For a map private to one owner (the server's follower), so a
 * poll does not copy every session; the session records themselves are still replaced, never edited.
 */
export function applyEventsInPlace(state: Map<string, SessionState>, events: readonly FoxholeEvent[]): void {
  for (const e of events) state.set(e.sessionId, applyOne(state.get(e.sessionId) ?? newSession(e), e));
}

/** Fold more events into an existing state. Returns a new map; the old one is untouched. */
export function applyEvents(state: SessionMap, events: readonly FoxholeEvent[]): SessionMap {
  const next = new Map(state);
  applyEventsInPlace(next, events);
  return next;
}

/**
 * Applies `now`: an ended session is asleep, and so is an idle one, or one working with no tool call
 * open, that has been quiet for QUIET_ASLEEP_MS or longer. A pending permission request or an open
 * tool call (a long build) is not quiet: the first needs the user, the second is still running.
 */
function atTime(s: SessionState, nowMs: number): SessionState {
  if (s.status === "asleep" || s.pendingPermission || s.currentTool !== null) return s;
  const quietFor = nowMs - Date.parse(s.lastEventAt);
  if (!(quietFor >= QUIET_ASLEEP_MS)) return s;
  return {
    ...s,
    status: "asleep",
    statusSince: new Date(Date.parse(s.lastEventAt) + QUIET_ASLEEP_MS).toISOString(),
  };
}

/** Asleep (as of nowMs) since longer ago than the retention period. */
function isStale(s: SessionState, nowMs: number, retentionDays: number): boolean {
  return s.status === "asleep" && nowMs - Date.parse(s.statusSince) > retentionDays * MS_PER_DAY;
}

/** Removes stale sessions from a map private to its owner; returns how many were dropped. */
export function pruneStale(
  state: Map<string, SessionState>,
  now: Date,
  retentionDays = DEFAULT_RETENTION_DAYS,
): number {
  const nowMs = now.getTime();
  let dropped = 0;
  for (const [id, s] of state) {
    if (!isStale(atTime(s, nowMs), nowMs, retentionDays)) continue;
    state.delete(id);
    dropped++;
  }
  return dropped;
}

function bySeverity(a: SessionState, b: SessionState): number {
  const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (rank) return rank;
  const since = Date.parse(a.statusSince) - Date.parse(b.statusSince);
  return since || a.sessionId.localeCompare(b.sessionId);
}

/**
 * Sessions as of `now`, needs-you first, then working, idle, asleep; within a group the longest
 * in that status comes first (oldest statusSince), ties by session id.
 */
export function snapshotOf(
  state: SessionMap,
  now: Date,
  version: string | null,
  retentionDays = DEFAULT_RETENTION_DAYS,
): Snapshot {
  const nowMs = now.getTime();
  const sessions = [...state.values()]
    .map((s) => atTime(s, nowMs))
    .filter((s) => !isStale(s, nowMs, retentionDays))
    .sort(bySeverity);
  return { version, generatedAt: now.toISOString(), sessions };
}

/** The whole fold in one call: `version` is `0-<index of the last event>`, null for no events. */
export function foldEvents(events: readonly FoxholeEvent[], now: Date): Snapshot {
  const state = applyEvents(new Map(), events);
  return snapshotOf(state, now, events.length ? `${FOLD_EPOCH}-${events.length - 1}` : null);
}
