import { describe, expect, it } from "vitest";
import { evaluateCollisions, evaluateSession } from "../src";
import { ago, calls, ev, NOW, session, starts } from "./factory";

describe("purity", () => {
  it("evaluateSession leaves its input deeply unchanged", () => {
    const events = [
      ...starts(["a", "a", "a"], "Read", 40),
      ...calls([{ tool: "Bash", target: "t", status: "error" }], 30),
      ev({ type: "permission.request", tool: "Bash", ts: ago(20) }),
    ];
    const before = structuredClone(events);
    const signals = evaluateSession(events, NOW);
    expect(signals.length).toBeGreaterThan(0);
    expect(events).toEqual(before);
  });

  it("evaluateCollisions leaves its input deeply unchanged", () => {
    const sessions = [
      session("a", { branch: "main", edits: ["x.ts"] }),
      session("b", { branch: "main", edits: ["x.ts"] }),
    ];
    const before = structuredClone(sessions);
    expect(evaluateCollisions(sessions, NOW).length).toBeGreaterThan(0);
    expect(sessions).toEqual(before);
  });
});

describe("evaluateSession", () => {
  it("returns no signals for an empty session", () => {
    expect(evaluateSession([], NOW)).toEqual([]);
  });

  it("returns every signal that applies", () => {
    const kinds = evaluateSession(starts(["a", "a", "a"], "Read", 15), NOW).map((s) => s.kind);
    expect(kinds).toEqual(["loop", "stall"]);
  });
});
