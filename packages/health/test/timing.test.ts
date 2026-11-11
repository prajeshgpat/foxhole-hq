import { describe, expect, it } from "vitest";
import { evaluateSession } from "../src";
import { ago, ev, NOW, sessionEnd, toolEnd, toolStart } from "./factory";

const kinds = (events: Parameters<typeof evaluateSession>[0], overrides = {}) =>
  evaluateSession(events, NOW, overrides).map((s) => s.kind);

describe("stall", () => {
  it("fires when a tool.start is the latest event and is 10 minutes old", () => {
    const events = [toolStart("a.ts", "Bash", 10)];
    const [signal] = evaluateSession(events, NOW);
    expect(signal).toMatchObject({ kind: "stall", since: ago(10), detail: { minutes: 10 } });
  });

  it("does not fire one minute below the threshold", () => {
    expect(kinds([toolStart("a.ts", "Bash", 9)])).toEqual([]);
  });

  it("clears when any later event arrives", () => {
    expect(kinds([toolStart("a.ts", "Bash", 20), toolEnd("ok", 19)])).not.toContain("stall");
  });

  it("is never reported for an ended session", () => {
    expect(kinds([toolStart("a.ts", "Bash", 30), sessionEnd(29)])).toEqual([]);
  });

  it("is not reported when the last lifecycle event is a subagent.stop", () => {
    const stop = ev({ type: "subagent.stop", ts: ago(30) });
    expect(kinds([toolStart("a.ts", "Bash", 40), stop])).toEqual([]);
  });

  it("respects an overridden threshold", () => {
    expect(kinds([toolStart("a.ts", "Bash", 3)], { stallMinutes: 3 })).toEqual(["stall"]);
  });

  it("works without a target", () => {
    expect(kinds([toolStart(undefined, "WebSearch", 15)])).toEqual(["stall"]);
  });
});

describe("long-wait", () => {
  const request = (minutes: number) => ev({ type: "permission.request", tool: "Bash", ts: ago(minutes) });

  it("fires when the latest event is a permission request 5 minutes old", () => {
    expect(evaluateSession([request(5)], NOW)[0]).toMatchObject({
      kind: "long-wait",
      detail: { minutes: 5 },
    });
  });

  it("does not fire below the threshold", () => {
    expect(kinds([request(4)])).toEqual([]);
  });

  it("clears once the session moves on", () => {
    expect(kinds([request(20), toolStart("a.ts", "Bash", 19), toolEnd("ok", 19)])).toEqual([]);
  });

  it("does not fire for an ended session", () => {
    expect(kinds([request(20), sessionEnd(10)])).toEqual([]);
  });

  it("fires for a resumed session whose request is older than the threshold", () => {
    const events = [
      sessionEnd(100),
      ev({ type: "session.start", ts: ago(50) }),
      ev({ type: "prompt.submit", ts: ago(49) }),
      request(20),
    ];
    expect(evaluateSession(events, NOW)[0]).toMatchObject({ kind: "long-wait", since: ago(20) });
  });

  it("still fires when an idle notification follows the request, with since from the request", () => {
    const events = [request(20), ev({ type: "session.waiting", ts: ago(10) })];
    const long = evaluateSession(events, NOW, { zombieMinutes: Infinity });
    expect(long).toHaveLength(1);
    expect(long[0]).toMatchObject({ kind: "long-wait", since: ago(20), detail: { minutes: 20 } });
  });

  it("does not fire when a tool.end follows the request", () => {
    expect(kinds([request(20), toolEnd("ok", 15)])).toEqual([]);
  });

  it("does not fire when the last lifecycle event is a subagent.stop", () => {
    expect(kinds([request(20), ev({ type: "subagent.stop", ts: ago(10) })])).toEqual([]);
  });

  it("respects an overridden threshold", () => {
    expect(kinds([request(2)], { longWaitMinutes: 2 })).toEqual(["long-wait"]);
  });

  it("escalates to alert at twice the threshold", () => {
    expect(evaluateSession([request(10)], NOW)[0]?.severity).toBe("alert");
  });
});

describe("zombie", () => {
  const idle = (type: "session.waiting" | "turn.end", minutes: number) => ev({ type, ts: ago(minutes) });

  it("fires for a waiting session idle for 2 hours", () => {
    expect(evaluateSession([idle("session.waiting", 120)], NOW)[0]).toMatchObject({
      kind: "zombie",
      severity: "info",
      detail: { minutes: 120 },
    });
  });

  it("fires for a turn.end 2 hours old", () => {
    expect(kinds([idle("turn.end", 180)])).toEqual(["zombie"]);
  });

  it("does not fire one minute below the threshold", () => {
    expect(kinds([idle("turn.end", 119)])).toEqual([]);
  });

  it("clears when the session starts a new prompt", () => {
    expect(kinds([idle("turn.end", 300), ev({ type: "prompt.submit", ts: ago(1) })])).toEqual([]);
  });

  it("does not fire once the session has ended", () => {
    expect(kinds([idle("turn.end", 300), sessionEnd(200)])).toEqual([]);
  });

  it("fires again after a resume leaves the session idle", () => {
    const events = [sessionEnd(400), ev({ type: "session.start", ts: ago(300) }), idle("turn.end", 200)];
    expect(kinds(events)).toEqual(["zombie"]);
  });

  it("does not fire when the last lifecycle event is a subagent.stop", () => {
    expect(kinds([idle("turn.end", 300), ev({ type: "subagent.stop", ts: ago(200) })])).toEqual([]);
  });

  it("respects an overridden threshold", () => {
    expect(kinds([idle("turn.end", 30)], { zombieMinutes: 30 })).toEqual(["zombie"]);
  });

  it("tolerates empty input", () => {
    expect(kinds([])).toEqual([]);
  });
});
