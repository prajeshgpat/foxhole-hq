import type { FoxholeEvent } from "@foxhole-hq/schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION_DAYS,
  QUIET_ASLEEP_MS,
  applyEvents,
  applyEventsInPlace,
  foldEvents,
  pruneStale,
  snapshotOf,
  type SessionState,
} from "../src/state";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const quiet = QUIET_ASLEEP_MS / 1000;
let n = 0;

function ev(type: FoxholeEvent["type"], seconds: number, extra: Partial<FoxholeEvent> = {}): FoxholeEvent {
  n++;
  return {
    v: 1,
    id: `6f1c2b9e-3f4a-4b7c-9d2e-${String(n).padStart(12, "0")}`,
    ts: at(seconds),
    source: "claude-code",
    machineId: "m_test",
    sessionId: "s1",
    parentSessionId: null,
    type,
    ...extra,
  };
}
const fold = (events: FoxholeEvent[], nowSeconds = 60) =>
  foldEvents(events, new Date(T0 + nowSeconds * 1000));
const only = (events: FoxholeEvent[], nowSeconds?: number) => fold(events, nowSeconds).sessions[0]!;

describe("foldEvents status", () => {
  it("returns an empty snapshot with no version for no events", () => {
    const snap = fold([]);
    expect(snap.sessions).toEqual([]);
    expect(snap.version).toBeNull();
    expect(snap.generatedAt).toBe(at(60));
  });

  it("reports a started session as idle", () => {
    expect(only([ev("session.start", 0)]).status).toBe("idle");
  });

  it("reports working after a prompt, with statusSince at the prompt", () => {
    const s = only([ev("session.start", 0), ev("prompt.submit", 5)]);
    expect([s.status, s.statusSince]).toEqual(["working", at(5)]);
  });

  it("keeps statusSince while tool activity continues the same status", () => {
    const s = only([ev("prompt.submit", 5), ev("tool.start", 6), ev("tool.end", 7)]);
    expect(s.statusSince).toBe(at(5));
  });

  it("reports needs-you on a permission request", () => {
    const s = only([ev("prompt.submit", 0), ev("permission.request", 3, { status: "waiting" })]);
    expect([s.status, s.pendingPermission]).toEqual(["needs-you", true]);
  });

  it.each(["tool.start", "tool.end", "prompt.submit", "turn.end"] as const)(
    "clears needs-you on the next %s",
    (type) => {
      const s = only([ev("permission.request", 0), ev(type, 2)]);
      expect(s.pendingPermission).toBe(false);
      expect(s.status).toBe(type === "turn.end" ? "idle" : "working");
    },
  );

  it("reports idle after turn.end and after session.waiting", () => {
    expect(only([ev("prompt.submit", 0), ev("turn.end", 4)]).status).toBe("idle");
    expect(only([ev("prompt.submit", 0), ev("session.waiting", 4)]).status).toBe("idle");
  });

  it("keeps needs-you when session.waiting arrives with a permission unanswered", () => {
    expect(only([ev("permission.request", 0), ev("session.waiting", 1)]).status).toBe("needs-you");
  });

  it("reports asleep after session.end and keeps it asleep through late tool events", () => {
    const s = only([ev("prompt.submit", 0), ev("session.end", 5), ev("tool.end", 6)]);
    expect([s.status, s.statusSince, s.currentTool]).toEqual(["asleep", at(5), null]);
  });

  it("wakes an ended session on a new prompt", () => {
    expect(only([ev("session.end", 0), ev("prompt.submit", 5)]).status).toBe("working");
  });

  it("turns a quiet session asleep exactly at the threshold, not a second before", () => {
    const events = [ev("turn.end", 0)];
    expect(only(events, quiet - 1).status).toBe("idle");
    const asleep = only(events, quiet);
    expect([asleep.status, asleep.statusSince]).toEqual(["asleep", at(quiet)]);
  });

  it("turns a working session with no open tool asleep exactly at the threshold", () => {
    const events = [ev("prompt.submit", 0)];
    expect(only(events, quiet - 1).status).toBe("working");
    expect(only(events, quiet).status).toBe("asleep");
  });

  it("keeps working while a tool call stays open, however long it runs", () => {
    const s = only([ev("prompt.submit", 0), ev("tool.start", 1, { tool: "Bash" })], 40 * 60 + 1);
    expect([s.status, s.currentTool]).toEqual(["working", "Bash"]);
  });

  it("keeps needs-you well past the quiet threshold while the permission is unanswered", () => {
    const events = [ev("prompt.submit", 0), ev("permission.request", 1)];
    for (const hours of [1, 6, 48]) {
      const s = only(events, hours * 3600);
      expect([s.status, s.pendingPermission]).toEqual(["needs-you", true]);
    }
  });

  it("lets a session go asleep again once its permission is answered and the tool closed", () => {
    const events = [ev("permission.request", 0), ev("tool.start", 1, { tool: "Bash" }), ev("tool.end", 2)];
    expect(only(events, 2 + quiet - 1).status).toBe("working");
    expect(only(events, 2 + quiet).status).toBe("asleep");
  });

  it("never produces stuck or done", () => {
    const events = [ev("prompt.submit", 0), ev("tool.end", 1, { status: "error" }), ev("turn.end", 2)];
    expect(["stuck", "done"]).not.toContain(only(events).status);
  });
});

describe("foldEvents details", () => {
  it("tracks the open tool and target, and clears them on tool.end", () => {
    const open = only([ev("tool.start", 0, { tool: "Read", target: "src/a.ts" })]);
    expect([open.currentTool, open.currentTarget]).toEqual(["Read", "src/a.ts"]);
    const closed = only([ev("tool.start", 0, { tool: "Read", target: "src/a.ts" }), ev("tool.end", 1)]);
    expect([closed.currentTool, closed.currentTarget]).toEqual([null, null]);
  });

  it("counts tool calls, turns and failed tool calls", () => {
    const s = only([
      ev("tool.start", 0, { tool: "Bash" }),
      ev("tool.end", 1, { status: "error" }),
      ev("tool.start", 2, { tool: "Bash" }),
      ev("tool.end", 3, { status: "ok" }),
      ev("turn.end", 4),
    ]);
    expect([s.toolCallCount, s.errorCount, s.turnCount]).toEqual([2, 1, 1]);
  });

  it("sums usage across turns and keeps the last model", () => {
    const s = only([
      ev("turn.end", 0, { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, model: "a" } }),
      ev("turn.end", 1, { usage: { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 7, model: "b" } }),
      ev("session.end", 2, { usage: { inputTokens: 3, outputTokens: 4 } }),
    ]);
    expect(s.usage).toEqual({
      inputTokens: 14,
      outputTokens: 11,
      cacheReadTokens: 100,
      cacheWriteTokens: 7,
      model: "b",
    });
  });

  it("files a subagent under its own id, linked to its parent, as ended", () => {
    const snap = fold([
      ev("prompt.submit", 0),
      ev("subagent.stop", 3, { sessionId: "sub1", parentSessionId: "s1", agentType: "Explore" }),
    ]);
    const sub = snap.sessions.find((s) => s.sessionId === "sub1")!;
    expect([sub.parentSessionId, sub.agentType, sub.status]).toEqual(["s1", "Explore", "asleep"]);
    expect(snap.sessions.find((s) => s.sessionId === "s1")!.status).toBe("working");
  });

  it("carries repo and branch through as opaque strings and keeps the latest", () => {
    const s = only([
      ev("session.start", 0, { repo: "local/odd name", branch: "a" }),
      ev("tool.start", 1, { branch: "b" }),
    ]);
    expect([s.repo, s.branch]).toEqual(["local/odd name", "b"]);
  });

  it("keeps interleaved sessions separate", () => {
    const snap = fold([
      ev("prompt.submit", 0, { sessionId: "a" }),
      ev("prompt.submit", 1, { sessionId: "b" }),
      ev("tool.start", 2, { sessionId: "a", tool: "Read" }),
      ev("turn.end", 3, { sessionId: "b" }),
    ]);
    const by = Object.fromEntries(snap.sessions.map((s) => [s.sessionId, s]));
    expect([by.a!.currentTool, by.a!.status, by.b!.status, by.b!.currentTool]).toEqual([
      "Read",
      "working",
      "idle",
      null,
    ]);
  });

  it("sets version to the index of the last event", () => {
    expect(fold([ev("session.start", 0), ev("turn.end", 1), ev("turn.end", 2)]).version).toBe("0-2");
  });

  it("does not mutate its input", () => {
    const events = [ev("prompt.submit", 0), ev("tool.start", 1, { tool: "Read" })];
    const copy = structuredClone(events);
    fold(events);
    expect(events).toEqual(copy);
  });
});

describe("foldEvents ordering", () => {
  it("sorts needs-you, working, idle, asleep, then oldest statusSince first", () => {
    const snap = fold([
      ev("session.end", 0, { sessionId: "asleep" }),
      ev("turn.end", 5, { sessionId: "idle-late" }),
      ev("turn.end", 2, { sessionId: "idle-early" }),
      ev("prompt.submit", 3, { sessionId: "working" }),
      ev("permission.request", 9, { sessionId: "needs" }),
    ]);
    expect(snap.sessions.map((s) => s.sessionId)).toEqual([
      "needs",
      "working",
      "idle-early",
      "idle-late",
      "asleep",
    ]);
  });
});

const DAY = 24 * 3600;
const retention = DEFAULT_RETENTION_DAYS * DAY;

describe("retention", () => {
  const events = () => [
    ev("session.end", 0, { sessionId: "ended" }),
    ev("turn.end", 0, { sessionId: "quiet" }),
    ev("prompt.submit", 0, { sessionId: "pending-old" }),
    ev("permission.request", 1, { sessionId: "pending-old" }),
  ];
  const ids = (nowSeconds: number) => fold(events(), nowSeconds).sessions.map((s) => s.sessionId);

  it("keeps ended and quiet sessions until the retention period has passed", () => {
    expect(ids(retention)).toContain("quiet");
    expect(ids(retention)).toContain("ended");
  });

  it("leaves an ended session out once it is more than the retention period old", () => {
    expect(ids(retention + 1)).not.toContain("ended");
  });

  it("measures a quiet session from when it fell asleep, not from its last event", () => {
    expect(ids(retention + quiet)).toContain("quiet");
    expect(ids(retention + quiet + 1)).not.toContain("quiet");
  });

  it("never drops a session that still needs the user", () => {
    expect(ids(100 * DAY)).toEqual(["pending-old"]);
  });

  it("accepts a different retention", () => {
    const state = applyEvents(new Map(), [ev("session.end", 0)]);
    expect(snapshotOf(state, new Date(T0 + 2 * DAY * 1000 + 1), null, 2).sessions).toEqual([]);
    expect(snapshotOf(state, new Date(T0 + 2 * DAY * 1000), null, 2).sessions).toHaveLength(1);
  });

  it("prunes stale sessions from a private map and lets them come back fresh", () => {
    const map = new Map<string, SessionState>();
    applyEventsInPlace(map, events());
    const dropped = pruneStale(map, new Date(T0 + (retention + quiet + 1) * 1000));
    expect(dropped).toBe(2);
    expect([...map.keys()]).toEqual(["pending-old"]);
    applyEventsInPlace(map, [ev("prompt.submit", retention + 5, { sessionId: "ended" })]);
    expect(map.get("ended")).toMatchObject({ status: "working", turnCount: 0 });
  });

  it("does not touch the map it was folded from", () => {
    const before = applyEvents(new Map(), [ev("turn.end", 0)]);
    const after = applyEvents(before, [ev("turn.end", 1)]);
    expect(before.get("s1")!.turnCount).toBe(1);
    expect(after.get("s1")!.turnCount).toBe(2);
  });
});
