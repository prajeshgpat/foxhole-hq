import type { EventType, FoxholeEvent } from "./event";

/**
 * One definition of a session's life, shared by everything that reads events (the state
 * snapshot, the health rules), so "ended" and "needs you" mean the same thing everywhere.
 */
type Typed = Pick<FoxholeEvent, "type">;

/** A session is over when it closes, or when a subagent finishes (its only event). */
export const ENDING_TYPES: ReadonlySet<EventType> = new Set(["session.end", "subagent.stop"]);

/** An ended session comes back when it is resumed or given a new prompt. */
export const REVIVING_TYPES: ReadonlySet<EventType> = new Set(["session.start", "prompt.submit"]);

/**
 * Schema v1 has no "permission answered" event, so a request counts as answered at the next
 * sign of progress. An idle notification (session.waiting) is not progress.
 */
export const PERMISSION_CLEARING_TYPES: ReadonlySet<EventType> = new Set([
  "tool.start",
  "tool.end",
  "prompt.submit",
  "turn.end",
  "session.end",
  "subagent.stop",
]);

/** Whether a session is ended after these events, given in order. */
export function isEnded(events: readonly Typed[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]!.type;
    if (ENDING_TYPES.has(type)) return true;
    if (REVIVING_TYPES.has(type)) return false;
  }
  return false;
}

/** The latest permission request that nothing has answered yet, or null. */
export function pendingPermission<E extends Typed>(events: readonly E[]): E | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "permission.request") return event;
    if (PERMISSION_CLEARING_TYPES.has(event.type)) return null;
  }
  return null;
}
