import { ENDING_TYPES, type EventType, type FoxholeEvent } from "@foxhole-hq/schema";
import type { Signal } from "./types";
import { escalate, lastOf, ofType, type Events } from "./util";
import type { Thresholds } from "./thresholds";

const isFailure = (event: FoxholeEvent) => event.status === "error";

/** A finished turn, a new prompt or the end of the session closes the books on earlier failures. */
const CLOSING_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "turn.end",
  "prompt.submit",
  ...ENDING_TYPES,
]);

function trailingFailures(ends: readonly FoxholeEvent[]): readonly FoxholeEvent[] {
  let begin = ends.length;
  while (begin > 0 && isFailure(ends[begin - 1]!)) begin--;
  return ends.slice(begin);
}

function closedSinceLastEnd(events: Events, last: FoxholeEvent): boolean {
  const lastIndex = events.lastIndexOf(last);
  return events.slice(lastIndex + 1).some((event) => CLOSING_TYPES.has(event.type));
}

export function detectErrorStreak(events: Events, t: Thresholds): Signal | null {
  const ends = ofType(events, "tool.end");
  const last = lastOf(ends);
  if (!last || closedSinceLastEnd(events, last)) return null;

  const streak = trailingFailures(ends);
  const window = ends.length >= t.errorRatioWindow ? ends.slice(-t.errorRatioWindow) : [];
  const failedInWindow = window.filter(isFailure);
  const streakFires = streak.length >= t.errorStreakLength;
  const ratioFires = window.length > 0 && failedInWindow.length / window.length > t.errorRatioShare;
  if (!streakFires && !ratioFires) return null;

  const first = streakFires ? streak[0]! : failedInWindow[0]!;
  return {
    kind: "error-streak",
    sessionId: last.sessionId,
    severity: escalate(streak.length, t.errorStreakLength, t.alertMultiple),
    since: first.ts,
    detail: {
      consecutiveFailures: streak.length,
      failuresInWindow: failedInWindow.length,
      window: window.length,
    },
  };
}
