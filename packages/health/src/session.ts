import type { Signal } from "./types";
import { resolveThresholds, type Thresholds } from "./thresholds";
import { detectLoop } from "./loop";
import { detectErrorStreak } from "./errors";
import { detectLongWait, detectStall, detectZombie } from "./timing";
import { detectCacheDrop } from "./cache";
import type { Events } from "./util";

/** Evaluates every single-session rule over one session's events (in order). Never mutates its inputs. */
export function evaluateSession(events: Events, now: Date, thresholds?: Partial<Thresholds>): Signal[] {
  const t = resolveThresholds(thresholds);
  const signals = [
    detectLoop(events, t),
    detectErrorStreak(events, t),
    detectStall(events, now, t),
    detectLongWait(events, now, t),
    detectZombie(events, now, t),
    detectCacheDrop(events, t),
  ];
  return signals.filter((signal): signal is Signal => signal !== null);
}
