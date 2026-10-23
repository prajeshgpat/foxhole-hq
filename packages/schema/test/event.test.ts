import { describe, expect, it } from "vitest";
import { MAX_TARGET_LENGTH, parseEvent, safeParseEvent } from "../src";

const base = {
  v: 1,
  id: "6f1c2b9e-3f4a-4b7c-9d2e-1a2b3c4d5e6f",
  ts: "2026-10-22T19:04:11.512Z",
  source: "claude-code",
  machineId: "m_8f2c",
  sessionId: "s_41a",
  parentSessionId: null,
  type: "tool.start",
  tool: "Edit",
  target: "src/auth/session.ts",
  status: "ok",
  usage: { inputTokens: 1200, outputTokens: 340, model: "claude-sonnet" },
  repo: "github.com/acme/web",
  branch: "fix/session-expiry",
} as const;

describe("FoxholeEvent", () => {
  it("accepts a well-formed event", () => {
    expect(parseEvent(base)).toEqual(base);
  });

  it("accepts the minimal session event", () => {
    const { tool: _t, target: _g, status: _s, usage: _u, repo: _r, branch: _b, ...minimal } = base;
    expect(safeParseEvent({ ...minimal, type: "session.start" }).success).toBe(true);
  });

  it("rejects unknown fields so content cannot leak through", () => {
    const result = safeParseEvent({ ...base, prompt: "please refactor the auth module" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields inside usage", () => {
    expect(safeParseEvent({ ...base, usage: { ...base.usage, transcript: "..." } }).success).toBe(false);
  });

  it("caps target length", () => {
    expect(safeParseEvent({ ...base, target: "x".repeat(MAX_TARGET_LENGTH) }).success).toBe(true);
    expect(safeParseEvent({ ...base, target: "x".repeat(MAX_TARGET_LENGTH + 1) }).success).toBe(false);
  });

  it("rejects other schema versions and unknown types", () => {
    expect(safeParseEvent({ ...base, v: 2 }).success).toBe(false);
    expect(safeParseEvent({ ...base, type: "tool.started" }).success).toBe(false);
  });

  it("rejects negative or fractional token counts", () => {
    expect(safeParseEvent({ ...base, usage: { inputTokens: -1, outputTokens: 0 } }).success).toBe(false);
    expect(safeParseEvent({ ...base, usage: { inputTokens: 1.5, outputTokens: 0 } }).success).toBe(false);
  });
});
