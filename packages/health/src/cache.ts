import type { FoxholeEvent, Usage } from "@foxhole-hq/schema";
import type { Signal } from "./types";
import { lastOf, minutesBetween, ofType, type Events } from "./util";
import type { Thresholds } from "./thresholds";

const PERCENT = 100;

/** cacheRead / (input + cacheRead + cacheWrite); null when the turn has no input at all. */
export function cacheReadShare(usage: Usage): number | null {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const total = usage.inputTokens + cacheRead + (usage.cacheWriteTokens ?? 0);
  return total > 0 ? cacheRead / total : null;
}

interface TurnShare {
  readonly event: FoxholeEvent;
  readonly share: number;
}

function turnShares(events: Events): TurnShare[] {
  return ofType(events, "turn.end").flatMap((event) => {
    const share = event.usage ? cacheReadShare(event.usage) : null;
    return share === null ? [] : [{ event, share }];
  });
}

export function detectCacheDrop(events: Events, t: Thresholds): Signal | null {
  const turns = turnShares(events);
  const latest = lastOf(turns);
  const earlier = turns.slice(0, -1);
  const previous = lastOf(earlier);
  if (!latest || !previous || earlier.length < t.cacheDropMinEarlierTurns) return null;

  // After a pause longer than the provider's cache lifetime a cold cache is normal, not a drop.
  const gap = minutesBetween(previous.event.ts, latest.event.ts);
  if (gap === null || gap > t.cacheTurnWindowMinutes) return null;

  const mean = earlier.reduce((sum, turn) => sum + turn.share, 0) / earlier.length;
  if (mean <= 0 || latest.share >= mean * t.cacheDropFraction) return null;

  return {
    kind: "cache-drop",
    sessionId: latest.event.sessionId,
    severity: "info",
    since: latest.event.ts,
    detail: {
      latestSharePercent: Math.round(latest.share * PERCENT),
      earlierMeanSharePercent: Math.round(mean * PERCENT),
      earlierTurns: earlier.length,
    },
  };
}
