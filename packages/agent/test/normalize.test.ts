import { safeParseEvent } from "@foxhole-hq/schema";
import { describe, expect, it } from "vitest";
import { normalizeClaudeHook, type ClaudeHookInput, type NormalizeContext } from "../src/normalize";

const ctx: NormalizeContext = {
  id: "6f1c2b9e-3f4a-4b7c-9d2e-1a2b3c4d5e6f",
  ts: "2026-10-22T19:04:11.512Z",
  machineId: "m_test",
  targetMode: "short",
  repo: { repo: "github.com/acme/web", branch: "fix/session-expiry" },
};
const base = { session_id: "abc-123", transcript_path: "/tmp/t.jsonl", cwd: "/home/dev/acme-web" };
const run = (input: Partial<ClaudeHookInput>, c: Partial<NormalizeContext> = {}) =>
  normalizeClaudeHook({ ...base, hook_event_name: "", ...input } as ClaudeHookInput, { ...ctx, ...c });

describe("normalizeClaudeHook", () => {
  it.each([
    ["SessionStart", "session.start"],
    ["UserPromptSubmit", "prompt.submit"],
    ["PreToolUse", "tool.start"],
    ["PostToolUse", "tool.end"],
    ["SubagentStop", "subagent.stop"],
    ["Stop", "turn.end"],
    ["SessionEnd", "session.end"],
  ])("maps %s to %s", (hook, type) => {
    const e = run({
      hook_event_name: hook,
      tool_name: "Read",
      tool_input: { file_path: "/home/dev/acme-web/a.ts" },
    });
    expect(e?.type).toBe(type);
    expect(safeParseEvent(e).success).toBe(true);
  });

  it("ignores hooks it does not track", () => {
    expect(run({ hook_event_name: "PreCompact" })).toBeNull();
  });

  it("never copies the prompt text", () => {
    const e = run({
      hook_event_name: "UserPromptSubmit",
      prompt: "our db password is hunter2",
    } as Partial<ClaudeHookInput>);
    expect(JSON.stringify(e)).not.toContain("hunter2");
  });

  it("labels tool calls and tags repo and branch", () => {
    const e = run({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/home/dev/acme-web/src/auth/session.ts", new_string: "secret" },
    });
    expect(e).toMatchObject({
      tool: "Edit",
      target: "src/auth/session.ts",
      repo: "github.com/acme/web",
      branch: "fix/session-expiry",
      status: "ok",
    });
    expect(JSON.stringify(e)).not.toContain("secret");
  });

  it("marks failed tool calls as errors", () => {
    expect(
      run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { is_error: true } })?.status,
    ).toBe("error");
    expect(
      run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { stdout: "ok" } })?.status,
    ).toBe("ok");
  });

  it("splits notifications into permission requests and plain waiting", () => {
    expect(
      run({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" })?.type,
    ).toBe("permission.request");
    expect(
      run({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "x" })?.type,
    ).toBe("permission.request");
    expect(run({ hook_event_name: "Notification", message: "Claude is waiting for your input" })?.type).toBe(
      "session.waiting",
    );
  });

  it("files a subagent stop under the subagent, linked to its parent session", () => {
    const e = run({ hook_event_name: "SubagentStop", agent_id: "agent-7", agent_type: "Explore" });
    expect(e).toMatchObject({ sessionId: "agent-7", parentSessionId: "abc-123", agentType: "Explore" });
    expect(safeParseEvent(e).success).toBe(true);
  });

  it("never copies the subagent's last message", () => {
    const e = run({
      hook_event_name: "SubagentStop",
      agent_id: "agent-7",
      last_assistant_message: "the api key is hunter2",
    } as Partial<ClaudeHookInput>);
    expect(JSON.stringify(e)).not.toContain("hunter2");
  });

  it("keeps a subagent stop on the parent session when the payload has no agent id", () => {
    const e = run({ hook_event_name: "SubagentStop" });
    expect(e).toMatchObject({ sessionId: "abc-123", parentSessionId: null });
    expect(e).not.toHaveProperty("agentType");
  });

  it("shortens long agent type names so the event still validates", () => {
    const e = run({ hook_event_name: "SubagentStop", agent_id: "agent-7", agent_type: "x".repeat(500) });
    expect(safeParseEvent(e).success).toBe(true);
  });

  it("attaches usage only to stop and end events", () => {
    const usage = { inputTokens: 10, outputTokens: 2 };
    expect(run({ hook_event_name: "Stop" }, { usage })?.usage).toEqual(usage);
    expect(run({ hook_event_name: "PreToolUse", tool_name: "Read" }, { usage })?.usage).toBeUndefined();
  });

  it("leaves repo and branch off outside a git repo", () => {
    const e = run({ hook_event_name: "SessionStart" }, { repo: {} });
    expect(e).not.toHaveProperty("repo");
    expect(e).not.toHaveProperty("branch");
  });
});
