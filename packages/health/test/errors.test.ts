import { describe, expect, it } from "vitest";
import { evaluateSession } from "../src";
import { ago, ends, ev, NOW } from "./factory";

const streaks = (events: ReturnType<typeof ends>, overrides = {}) =>
  evaluateSession(events, NOW, overrides).filter((s) => s.kind === "error-streak");

describe("error-streak", () => {
  it("fires on three failures in a row", () => {
    const events = ends(["error", "error", "error"]);
    const signals = streaks(events);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ since: events[0]?.ts, detail: { consecutiveFailures: 3 } });
  });

  it("does not fire on two failures in a row", () => {
    expect(streaks(ends(["ok", "error", "error"]))).toEqual([]);
  });

  it("clears after a successful call", () => {
    expect(streaks(ends(["error", "error", "error", "ok"]))).toEqual([]);
  });

  it("fires when more than half of the last ten fail", () => {
    const signals = streaks(
      ends(["error", "ok", "error", "ok", "error", "ok", "error", "ok", "error", "error"]),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.detail).toMatchObject({ failuresInWindow: 6, window: 10 });
  });

  it("does not fire when exactly half of the last ten fail", () => {
    expect(
      streaks(ends(["error", "ok", "error", "ok", "error", "ok", "error", "ok", "error", "ok"])),
    ).toEqual([]);
  });

  it("does not apply the ratio rule below ten calls", () => {
    expect(streaks(ends(["error", "ok", "error", "ok", "error", "ok", "error", "ok", "error"]))).toEqual([]);
  });

  it("ignores failures older than the last ten", () => {
    const old = Array<"error" | "ok">(5).fill("error");
    expect(streaks(ends([...old, ...Array<"error" | "ok">(10).fill("ok")]))).toEqual([]);
  });

  it("respects overridden thresholds", () => {
    expect(streaks(ends(["error", "error"]), { errorStreakLength: 2 })).toHaveLength(1);
    expect(
      streaks(ends(["error", "ok", "error", "ok"]), { errorRatioWindow: 4, errorRatioShare: 0.25 }),
    ).toHaveLength(1);
  });

  it.each(["turn.end", "prompt.submit", "session.end", "subagent.stop"] as const)(
    "clears once a %s follows the last failed call",
    (type) => {
      const events = [...ends(["error", "error", "error"], 30), ev({ type, ts: ago(10) })];
      expect(streaks(events)).toEqual([]);
    },
  );

  it("fires again when failures resume after the turn ended", () => {
    const events = [
      ...ends(["error", "error", "error"], 50),
      ev({ type: "turn.end", ts: ago(40) }),
      ...ends(["error", "error", "error"], 30),
    ];
    expect(streaks(events)).toHaveLength(1);
  });

  it("is not cleared by an idle notification", () => {
    const events = [...ends(["error", "error", "error"], 30), ev({ type: "session.waiting", ts: ago(10) })];
    expect(streaks(events)).toHaveLength(1);
  });

  it("tolerates empty input and tool.end events without a status", () => {
    expect(streaks([])).toEqual([]);
    const noStatus = ends(["ok", "ok", "ok"]).map(({ status: _status, ...rest }) => rest);
    expect(streaks(noStatus)).toEqual([]);
  });
});
