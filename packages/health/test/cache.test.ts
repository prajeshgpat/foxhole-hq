import { describe, expect, it } from "vitest";
import { evaluateSession } from "../src";
import { NOW, turnEnd } from "./factory";

const HIGH = { inputTokens: 100, cacheReadTokens: 900 }; // share 0.9
const LOW = { inputTokens: 700, cacheReadTokens: 300 }; // share 0.3
const BORDER = { inputTokens: 550, cacheReadTokens: 450 }; // share 0.45 = exactly half of 0.9

const drops = (events: ReturnType<typeof turnEnd>[], overrides = {}) =>
  evaluateSession(events, NOW, { zombieMinutes: Infinity, ...overrides }).filter(
    (s) => s.kind === "cache-drop",
  );

const history = [turnEnd(HIGH, 30), turnEnd(HIGH, 26), turnEnd(HIGH, 22)];

describe("cache-drop", () => {
  it("fires when the latest share is under half the earlier mean", () => {
    const signals = drops([...history, turnEnd(LOW, 19)]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      sessionId: "s1",
      detail: { latestSharePercent: 30, earlierMeanSharePercent: 90, earlierTurns: 3 },
    });
  });

  it("does not fire when the latest share is exactly half the mean", () => {
    expect(drops([...history, turnEnd(BORDER, 19)])).toEqual([]);
  });

  it("clears when a later turn recovers", () => {
    expect(drops([...history, turnEnd(LOW, 19), turnEnd(HIGH, 15)])).toEqual([]);
  });

  it("needs at least three earlier turns with usage", () => {
    expect(drops([turnEnd(HIGH, 25), turnEnd(HIGH, 22), turnEnd(LOW, 19)])).toEqual([]);
  });

  it("needs a nonzero earlier mean", () => {
    const zero = { inputTokens: 500 };
    expect(drops([turnEnd(zero, 40), turnEnd(zero, 30), turnEnd(zero, 20), turnEnd(zero, 19)])).toEqual([]);
  });

  it("skips turns without usage", () => {
    expect(
      drops([turnEnd(undefined, 60), ...history, turnEnd(undefined, 21), turnEnd(LOW, 19)]),
    ).toHaveLength(1);
  });

  it("counts cache writes in the denominator", () => {
    const withWrites = { inputTokens: 0, cacheReadTokens: 300, cacheWriteTokens: 700 }; // 0.3
    expect(drops([...history, turnEnd(withWrites, 20)])).toHaveLength(1);
  });

  it("respects overridden thresholds", () => {
    expect(drops([turnEnd(HIGH, 22), turnEnd(LOW, 19)], { cacheDropMinEarlierTurns: 1 })).toHaveLength(1);
    expect(drops([...history, turnEnd(BORDER, 19)], { cacheDropFraction: 0.6 })).toHaveLength(1);
  });

  it("skips the comparison after a pause longer than the turn window", () => {
    expect(drops([...history, turnEnd(LOW, 10)])).toEqual([]);
  });

  it("compares turns exactly at the window boundary and honours an overridden window", () => {
    expect(drops([...history, turnEnd(LOW, 17)])).toHaveLength(1);
    expect(drops([...history, turnEnd(LOW, 10)], { cacheTurnWindowMinutes: 15 })).toHaveLength(1);
  });

  it("tolerates empty input", () => {
    expect(drops([])).toEqual([]);
  });
});
