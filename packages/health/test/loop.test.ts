import { describe, expect, it } from "vitest";
import { evaluateSession } from "../src";
import { calls, NOW, starts } from "./factory";

const loops = (events: ReturnType<typeof starts>, overrides = {}) =>
  evaluateSession(events, NOW, overrides).filter((s) => s.kind === "loop");

describe("loop", () => {
  it("fires on three identical consecutive calls", () => {
    const signals = loops(starts(["a.ts", "a.ts", "a.ts"]));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ sessionId: "s1", detail: { pattern: 1, calls: 3 } });
  });

  it("reports the start of the run as since", () => {
    const events = starts(["x.ts", "a.ts", "a.ts", "a.ts"]);
    expect(loops(events)[0]?.since).toBe(events[1]?.ts);
  });

  it("does not fire on two identical calls", () => {
    expect(loops(starts(["a.ts", "a.ts"]))).toEqual([]);
  });

  it("does not fire when the same target is used by different tools", () => {
    const events = [
      ...starts(["a.ts"], "Read", 32),
      ...starts(["a.ts"], "Edit", 31),
      ...starts(["a.ts"], "Read", 30),
    ];
    expect(loops(events)).toEqual([]);
  });

  it("fires on A-B-A-B-A-B over six calls", () => {
    const signals = loops(starts(["a", "b", "a", "b", "a", "b"]));
    expect(signals[0]?.detail).toMatchObject({ pattern: 2, calls: 6 });
  });

  it("does not fire on five alternating calls", () => {
    expect(loops(starts(["a", "b", "a", "b", "a"]))).toEqual([]);
  });

  it("clears once a different call breaks the pattern", () => {
    expect(loops(starts(["a", "a", "a", "c"]))).toEqual([]);
    expect(loops(starts(["a", "b", "a", "b", "a", "b", "c"]))).toEqual([]);
  });

  it("never treats null or missing targets as a loop", () => {
    expect(loops(starts([null, null, null, null]))).toEqual([]);
    expect(loops(starts([null, "a", null, "a", null, "a"]))).toEqual([]);
  });

  it("respects overridden thresholds", () => {
    expect(loops(starts(["a", "a"]), { loopRepeatCount: 2 })).toHaveLength(1);
    expect(loops(starts(["a", "b", "a", "b"]), { loopAlternationLength: 4 })).toHaveLength(1);
  });

  it("escalates to alert at twice the repeat count", () => {
    expect(loops(starts(["a", "a", "a", "a", "a", "a"]))[0]?.severity).toBe("alert");
  });

  it("fires on Read A / Read B repeated three times", () => {
    expect(loops(starts(["a", "b", "a", "b", "a", "b"], "Read"))).toHaveLength(1);
  });

  it("tolerates empty input", () => {
    expect(loops([])).toEqual([]);
  });
});

describe("loop: normal work", () => {
  it.each([3, 6])("does not fire on %i edits of one file", (count) => {
    expect(loops(starts(Array<string>(count).fill("a.ts"), "Edit"))).toEqual([]);
  });

  it("does not count Write, MultiEdit or NotebookEdit either", () => {
    for (const tool of ["Write", "MultiEdit", "NotebookEdit"]) {
      expect(loops(starts(["a", "a", "a"], tool))).toEqual([]);
    }
  });

  it("does not fire on the edit-test rhythm repeated three times", () => {
    const rhythm = Array.from({ length: 3 }, () => [
      { tool: "Edit", target: "src/a.ts" },
      { tool: "Bash", target: "pnpm test" },
    ]).flat();
    expect(loops(calls(rhythm))).toEqual([]);
  });

  it("does not fire on an alternation that includes an edit", () => {
    expect(loops(starts(["a", "a", "a", "a", "a", "a"], "Edit"))).toEqual([]);
    const mixed = Array.from({ length: 3 }, () => [
      { tool: "Read", target: "a.ts" },
      { tool: "Edit", target: "a.ts" },
    ]).flat();
    expect(loops(calls(mixed))).toEqual([]);
  });
});

describe("loop: command repeats", () => {
  const bash = (count: number, status: "ok" | "error") =>
    calls(Array.from({ length: count }, () => ({ tool: "Bash", target: "pnpm test", status })));

  it("fires on the same failing command three times", () => {
    expect(loops(bash(3, "error"))[0]?.detail).toMatchObject({ pattern: 1, calls: 3 });
  });

  it("does not fire on the same passing command three or four times", () => {
    expect(loops(bash(3, "ok"))).toEqual([]);
    expect(loops(bash(4, "ok"))).toEqual([]);
  });

  it("fires on the same passing command five times", () => {
    expect(loops(bash(5, "ok"))).toHaveLength(1);
  });

  it("needs every finished call in the run to have failed", () => {
    const mixed = calls([
      { tool: "Bash", target: "t", status: "error" },
      { tool: "Bash", target: "t", status: "ok" },
      { tool: "Bash", target: "t", status: "error" },
    ]);
    expect(loops(mixed)).toEqual([]);
  });

  it("treats calls with no tool.end as unknown, so three need five repeats", () => {
    expect(loops(starts(["t", "t", "t"], "Bash"))).toEqual([]);
    expect(loops(starts(["t", "t", "t", "t", "t"], "Bash"))).toHaveLength(1);
  });

  it("respects an overridden extra", () => {
    expect(loops(bash(3, "ok"), { loopPassingRepeatExtra: 0 })).toHaveLength(1);
  });
});
