import { isEnded } from "@foxhole-hq/schema";
import type { Signal } from "./types";
import { resolveThresholds, type Thresholds } from "./thresholds";
import { EDIT_TOOLS } from "./tools";
import { lastOf, minutesSince, type Events } from "./util";

/** The shared den for sessions outside any repo: unrelated folders, so a shared name means nothing. */
const SCRATCH_REPO = "scratch";

interface LiveSession {
  readonly id: string;
  readonly repo: string;
  readonly branch: string | null;
  readonly firstTs: string;
  /** Target to the ts of its earliest edit inside the window. */
  readonly recentEdits: ReadonlyMap<string, string>;
}

function recentEdits(events: Events, now: Date, windowMinutes: number): Map<string, string> {
  const edits = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool.start" || !event.tool || !EDIT_TOOLS.has(event.tool)) continue;
    if (event.target == null || edits.has(event.target)) continue;
    const age = minutesSince(event.ts, now);
    if (age !== null && age <= windowMinutes) edits.set(event.target, event.ts);
  }
  return edits;
}

/** Whether any event is within the window of now (events need not be in timestamp order). */
function isActive(events: Events, now: Date, windowMinutes: number): boolean {
  return events.some((event) => {
    const age = minutesSince(event.ts, now);
    return age !== null && age <= windowMinutes;
  });
}

/** A session that is open, in a real repo, and has done something inside the window; else null. */
function summarize(events: Events, now: Date, t: Thresholds): LiveSession | null {
  const first = events[0];
  const repo = lastOf(events.filter((e) => e.repo))?.repo;
  if (!first || !repo || repo === SCRATCH_REPO || isEnded(events)) return null;
  if (!isActive(events, now, t.collisionWindowMinutes)) return null;
  return {
    id: first.sessionId,
    repo,
    branch: lastOf(events.filter((e) => e.branch))?.branch ?? null,
    firstTs: first.ts,
    recentEdits: recentEdits(events, now, t.collisionWindowMinutes),
  };
}

/** Session id to its parent id, from every session given (ended ones included). */
function parentIndex(sessionsEvents: readonly Events[]): ReadonlyMap<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const events of sessionsEvents) {
    const first = events[0];
    if (!first) continue;
    parents.set(first.sessionId, events.find((e) => e.parentSessionId)?.parentSessionId ?? null);
  }
  return parents;
}

/** The top of a session's family: follow parents as far as the given events know them. */
function familyRoot(id: string, parents: ReadonlyMap<string, string | null>): string {
  const seen = new Set<string>([id]);
  let current = id;
  for (;;) {
    const parent = parents.get(current);
    if (!parent || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const earlier = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);

/** The pair collides when the second session joined; null when they do not collide. */
function collisionOf(a: LiveSession, b: LiveSession) {
  const sharedSince = [...a.recentEdits]
    .filter(([target]) => b.recentEdits.has(target))
    .map(([target, ts]) => later(ts, b.recentEdits.get(target)!));
  const sameBranch = a.branch !== null && a.branch === b.branch;
  const candidates = [...sharedSince, ...(sameBranch ? [later(a.firstTs, b.firstTs)] : [])];
  if (candidates.length === 0) return null;
  return {
    since: candidates.reduce(earlier),
    sharedFiles: sharedSince.length,
    sameBranch: sameBranch ? 1 : 0,
  };
}

/** Same file is a real conflict risk (warn); sharing a branch is often intended (info). */
function signalFor(
  self: LiveSession,
  other: LiveSession,
  c: NonNullable<ReturnType<typeof collisionOf>>,
): Signal {
  return {
    kind: "collision",
    sessionId: self.id,
    severity: c.sharedFiles > 0 ? "warn" : "info",
    since: c.since,
    detail: { otherSessionId: other.id, sharedFiles: c.sharedFiles, sameBranch: c.sameBranch },
  };
}

/**
 * One signal per session in each colliding pair, so a session in two collisions gets two signals.
 * Sessions of one family (parent, subagents, their descendants) never collide with each other.
 */
export function evaluateCollisions(
  sessionsEvents: readonly Events[],
  now: Date,
  thresholds?: Partial<Thresholds>,
): Signal[] {
  const t = resolveThresholds(thresholds);
  const parents = parentIndex(sessionsEvents);
  const live = sessionsEvents.flatMap((events) => summarize(events, now, t) ?? []);
  const signals: Signal[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.id === b.id || a.repo !== b.repo) continue;
      if (familyRoot(a.id, parents) === familyRoot(b.id, parents)) continue;
      const collision = collisionOf(a, b);
      if (collision) signals.push(signalFor(a, b, collision), signalFor(b, a, collision));
    }
  }
  return signals;
}
