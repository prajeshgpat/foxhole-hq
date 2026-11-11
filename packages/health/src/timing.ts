import { isEnded, pendingPermission } from "@foxhole-hq/schema";
import type { Signal } from "./types";
import { escalate, lastOf, minutesSince, type Events } from "./util";
import type { Thresholds } from "./thresholds";

/** The shape of the rules that look only at the latest event and how old it is. */
function staleLatest(
  events: Events,
  now: Date,
  kind: Signal["kind"],
  types: readonly string[],
  thresholdMinutes: number,
  alertMultiple: number,
): Signal | null {
  const last = lastOf(events);
  if (!last || !types.includes(last.type) || isEnded(events)) return null;
  const minutes = minutesSince(last.ts, now);
  if (minutes === null || minutes < thresholdMinutes) return null;
  return {
    kind,
    sessionId: last.sessionId,
    severity: kind === "zombie" ? "info" : escalate(minutes, thresholdMinutes, alertMultiple),
    since: last.ts,
    detail: { minutes },
  };
}

export const detectStall = (events: Events, now: Date, t: Thresholds) =>
  staleLatest(events, now, "stall", ["tool.start"], t.stallMinutes, t.alertMultiple);

/**
 * Fires on the shared definition of "needs you": the latest permission request that nothing has
 * answered. An idle notification after the request does not hide it.
 */
export function detectLongWait(events: Events, now: Date, t: Thresholds): Signal | null {
  const request = pendingPermission(events);
  if (!request) return null;
  const minutes = minutesSince(request.ts, now);
  if (minutes === null || minutes < t.longWaitMinutes) return null;
  return {
    kind: "long-wait",
    sessionId: request.sessionId,
    severity: escalate(minutes, t.longWaitMinutes, t.alertMultiple),
    since: request.ts,
    detail: { minutes },
  };
}

export const detectZombie = (events: Events, now: Date, t: Thresholds) =>
  staleLatest(events, now, "zombie", ["session.waiting", "turn.end"], t.zombieMinutes, t.alertMultiple);
