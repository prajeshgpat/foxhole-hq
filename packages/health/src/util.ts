import type { FoxholeEvent } from "@foxhole-hq/schema";
import type { Severity } from "./types";

export type Events = readonly FoxholeEvent[];

const MS_PER_MINUTE = 60_000;

/** Whole minutes from an ISO timestamp to `now`, or null when either side is not a valid date. */
export function minutesSince(ts: string, now: Date): number | null {
  const then = Date.parse(ts);
  const nowMs = now.getTime();
  if (Number.isNaN(then) || Number.isNaN(nowMs)) return null;
  return Math.floor((nowMs - then) / MS_PER_MINUTE);
}

/** Minutes from one ISO timestamp to a later one (fractional), or null when either is invalid. */
export function minutesBetween(earlierTs: string, laterTs: string): number | null {
  const from = Date.parse(earlierTs);
  const to = Date.parse(laterTs);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / MS_PER_MINUTE;
}

export function lastOf<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

export function ofType(events: Events, type: FoxholeEvent["type"]): FoxholeEvent[] {
  return events.filter((event) => event.type === type);
}

/** Warn normally, alert once the value reaches `alertMultiple` times the threshold. */
export function escalate(value: number, threshold: number, alertMultiple: number): Severity {
  return value >= threshold * alertMultiple ? "alert" : "warn";
}
