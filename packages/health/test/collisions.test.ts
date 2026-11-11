import { describe, expect, it } from "vitest";
import { evaluateCollisions } from "../src";
import { ago, ev, NOW, session } from "./factory";

describe("evaluateCollisions", () => {
  it("fires for both sessions editing the same file", () => {
    const a = session("a", { edits: ["src/x.ts"] });
    const b = session("b", { edits: ["src/x.ts"] });
    const signals = evaluateCollisions([a, b], NOW);
    expect(signals.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
    expect(signals.find((s) => s.sessionId === "a")?.detail).toEqual({
      otherSessionId: "b",
      sharedFiles: 1,
      sameBranch: 0,
    });
    expect(signals.every((s) => s.kind === "collision" && s.since === ago(5))).toBe(true);
    expect(signals.every((s) => s.severity === "warn")).toBe(true);
  });

  it("fires for two live sessions on the same branch", () => {
    const signals = evaluateCollisions(
      [session("a", { branch: "feat/x" }), session("b", { branch: "feat/x" })],
      NOW,
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]?.detail).toMatchObject({ sameBranch: 1, sharedFiles: 0 });
    expect(signals.every((s) => s.severity === "info")).toBe(true);
  });

  it("keeps warn when sessions share both a file and a branch", () => {
    const a = session("a", { branch: "main", edits: ["x.ts"] });
    const b = session("b", { branch: "main", edits: ["x.ts"] });
    expect(evaluateCollisions([a, b], NOW).every((s) => s.severity === "warn")).toBe(true);
  });

  it("does not fire on a shared branch when a session has been quiet longer than the window", () => {
    const quiet = session("q", { branch: "main", activeMinutesAgo: 31 });
    const busy = session("b", { branch: "main" });
    expect(evaluateCollisions([quiet, busy], NOW)).toEqual([]);
    expect(evaluateCollisions([quiet, busy], NOW, { collisionWindowMinutes: 45 })).toHaveLength(2);
  });

  it("does not treat a week-old session that never ended as live", () => {
    const stale = session("old", {
      branch: "main",
      edits: ["a.ts"],
      editMinutesAgo: 7 * 24 * 60,
      activeMinutesAgo: 7 * 24 * 60,
    });
    const busy = session("b", { branch: "main", edits: ["a.ts"] });
    expect(evaluateCollisions([stale, busy], NOW)).toEqual([]);
  });

  it("does not fire between sibling subagents", () => {
    const one = session("c1", { branch: "main", edits: ["a.ts"], parent: "p" });
    const two = session("c2", { branch: "main", edits: ["a.ts"], parent: "p" });
    expect(evaluateCollisions([one, two], NOW)).toEqual([]);
  });

  it("does not fire between a subagent and its parent's other descendants", () => {
    const parent = session("p", { branch: "main", edits: ["a.ts"] });
    const child = session("c", { branch: "main", edits: ["a.ts"], parent: "p" });
    const grandchild = session("g", { branch: "main", edits: ["a.ts"], parent: "c" });
    expect(evaluateCollisions([parent, child, grandchild], NOW)).toEqual([]);
  });

  it("still fires between subagents of unrelated parents", () => {
    const one = session("c1", { branch: "main", edits: ["a.ts"], parent: "p1" });
    const two = session("c2", { branch: "main", edits: ["a.ts"], parent: "p2" });
    expect(evaluateCollisions([one, two], NOW)).toHaveLength(2);
  });

  it("produces no signals for a parent, two sibling subagents and a week-old session on main", () => {
    const week = 7 * 24 * 60;
    const sessions = [
      session("p", { branch: "main" }),
      session("c1", { branch: "main", parent: "p" }),
      session("c2", { branch: "main", parent: "p" }),
      session("old", { branch: "main", activeMinutesAgo: week, editMinutesAgo: week }),
    ];
    expect(evaluateCollisions(sessions, NOW)).toEqual([]);
  });

  it("does not fire for sessions in the scratch repo", () => {
    const a = session("a", { repo: "scratch", branch: "main", edits: ["notes.md"] });
    const b = session("b", { repo: "scratch", branch: "main", edits: ["notes.md"] });
    expect(evaluateCollisions([a, b], NOW)).toEqual([]);
  });

  it("does not count a session whose last lifecycle event is a subagent.stop as live", () => {
    const stopped = [
      ...session("s", { branch: "main", edits: ["a.ts"] }),
      ev({ sessionId: "s", type: "subagent.stop", repo: "acme/web", ts: ago(1) }),
    ];
    const busy = session("b", { branch: "main", edits: ["a.ts"] });
    expect(evaluateCollisions([stopped, busy], NOW)).toEqual([]);
  });

  it("counts a resumed session as live again", () => {
    const resumed = [
      ...session("s", { branch: "main", edits: ["a.ts"], ended: true }),
      ev({ sessionId: "s", type: "session.start", repo: "acme/web", branch: "main", ts: ago(0) }),
    ];
    const busy = session("b", { branch: "main", edits: ["a.ts"] });
    expect(evaluateCollisions([resumed, busy], NOW)).toHaveLength(2);
  });

  it("does not fire for different files on different branches", () => {
    const a = session("a", { branch: "one", edits: ["a.ts"] });
    const b = session("b", { branch: "two", edits: ["b.ts"] });
    expect(evaluateCollisions([a, b], NOW)).toEqual([]);
  });

  it("does not fire between a parent and its subagent", () => {
    const parent = session("p", { branch: "feat/x", edits: ["a.ts"] });
    const cub = session("c", { branch: "feat/x", edits: ["a.ts"], parent: "p" });
    expect(evaluateCollisions([parent, cub], NOW)).toEqual([]);
  });

  it("does not fire across repos", () => {
    const a = session("a", { repo: "acme/web", branch: "main", edits: ["a.ts"] });
    const b = session("b", { repo: "acme/api", branch: "main", edits: ["a.ts"] });
    expect(evaluateCollisions([a, b], NOW)).toEqual([]);
  });

  it("does not fire when one session has ended", () => {
    const a = session("a", { branch: "main", edits: ["a.ts"] });
    const b = session("b", { branch: "main", edits: ["a.ts"], ended: true });
    expect(evaluateCollisions([a, b], NOW)).toEqual([]);
  });

  it("ignores edits outside the window and honours an overridden window", () => {
    const a = session("a", { edits: ["a.ts"], editMinutesAgo: 31 });
    const b = session("b", { edits: ["a.ts"], editMinutesAgo: 31 });
    expect(evaluateCollisions([a, b], NOW)).toEqual([]);
    expect(evaluateCollisions([a, b], NOW, { collisionWindowMinutes: 45 })).toHaveLength(2);
  });

  it("fires for an edit exactly at the window boundary", () => {
    const a = session("a", { edits: ["a.ts"], editMinutesAgo: 30 });
    const b = session("b", { edits: ["a.ts"], editMinutesAgo: 30 });
    expect(evaluateCollisions([a, b], NOW)).toHaveLength(2);
  });

  it("tolerates empty input, empty sessions and events without repo or branch", () => {
    expect(evaluateCollisions([], NOW)).toEqual([]);
    expect(evaluateCollisions([[], []], NOW)).toEqual([]);
    const bare = session("a").map(({ repo: _r, branch: _b, ...rest }) => rest);
    expect(evaluateCollisions([bare, bare], NOW)).toEqual([]);
  });
});
