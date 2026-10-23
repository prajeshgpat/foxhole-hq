import type { EventType, FoxholeEvent, Usage } from "@foxhole-hq/schema";
import type { RepoInfo } from "./git";
import { targetFor, type TargetMode } from "./target";

/**
 * The fields Claude Code passes to every hook on stdin. Only the ones Foxhole reads are typed;
 * notably `prompt`, `tool_response` contents and `message` text are read for routing at most and
 * never copied into an event.
 */
export interface ClaudeHookInput {
  hook_event_name: string;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  message?: string;
  notification_type?: string;
}

export interface NormalizeContext {
  id: string;
  ts: string;
  machineId: string;
  targetMode: TargetMode;
  repo: RepoInfo;
  /** Usage since the last Stop, read from the transcript by the caller. */
  usage?: Usage | null;
}

function toolFailed(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const r = response as Record<string, unknown>;
  return r.is_error === true || r.isError === true || (typeof r.error === "string" && r.error.length > 0);
}

function isPermissionNotice(input: ClaudeHookInput): boolean {
  if (input.notification_type) return input.notification_type === "permission_prompt";
  return typeof input.message === "string" && /permission/i.test(input.message);
}

function typeFor(input: ClaudeHookInput): { type: EventType; status?: FoxholeEvent["status"] } | null {
  switch (input.hook_event_name) {
    case "SessionStart":
      return { type: "session.start" };
    case "UserPromptSubmit":
      return { type: "prompt.submit" };
    case "PreToolUse":
      return { type: "tool.start", status: "ok" };
    case "PostToolUse":
      return { type: "tool.end", status: toolFailed(input.tool_response) ? "error" : "ok" };
    case "PostToolUseFailure":
      return { type: "tool.end", status: "error" };
    case "Notification":
      return isPermissionNotice(input)
        ? { type: "permission.request", status: "waiting" }
        : { type: "session.waiting", status: "waiting" };
    case "SubagentStop":
      return { type: "subagent.stop", status: "ok" };
    case "Stop":
      return { type: "session.stop", status: "ok" };
    case "SessionEnd":
      return { type: "session.end" };
    default:
      return null;
  }
}

/** Map one Claude Code hook payload to a Foxhole event, or null for hooks Foxhole does not track. */
export function normalizeClaudeHook(input: ClaudeHookInput, ctx: NormalizeContext): FoxholeEvent | null {
  const mapped = typeFor(input);
  if (!mapped || !input.session_id) return null;
  const event: FoxholeEvent = {
    v: 1,
    id: ctx.id,
    ts: ctx.ts,
    source: "claude-code",
    machineId: ctx.machineId,
    sessionId: input.session_id,
    parentSessionId: null,
    type: mapped.type,
  };
  if (mapped.status) event.status = mapped.status;
  if (input.tool_name && (mapped.type === "tool.start" || mapped.type === "tool.end")) {
    event.tool = input.tool_name;
    event.target = targetFor(input.tool_name, input.tool_input, input.cwd ?? process.cwd(), ctx.targetMode);
  }
  if ((mapped.type === "session.stop" || mapped.type === "session.end") && ctx.usage) event.usage = ctx.usage;
  if (ctx.repo.repo) event.repo = ctx.repo.repo;
  if (ctx.repo.branch) event.branch = ctx.repo.branch;
  return event;
}
