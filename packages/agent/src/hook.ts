import { randomUUID } from "node:crypto";
import { safeParseEvent, type FoxholeEvent } from "@foxhole-hq/schema";
import { repoInfo } from "./git";
import { normalizeClaudeHook, type ClaudeHookInput } from "./normalize";
import { appendEvent, machineId, readConfig, readCursor, recordPayloadShape, writeCursor } from "./store";
import { readNewUsage, transcriptSize } from "./usage";

export interface HookOptions {
  home: string;
  now?: () => Date;
  debugShapes?: boolean;
}

/**
 * Handle one Claude Code hook invocation end to end: parse, normalize, attach usage, validate,
 * append. Returns the event that was written, or null when there was nothing to record.
 * Throws only on programmer error; the CLI wrapper swallows everything so a hook never blocks the agent.
 */
export function handleClaudeHook(raw: string, opts: HookOptions): FoxholeEvent | null {
  let payload: ClaudeHookInput;
  try {
    payload = JSON.parse(raw) as ClaudeHookInput;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (opts.debugShapes) recordPayloadShape(opts.home, payload as unknown as Record<string, unknown>);

  const config = readConfig(opts.home);
  const cwd = payload.cwd || process.cwd();
  let usage = null;
  if (payload.hook_event_name === "SessionStart" && payload.transcript_path) {
    // A resumed or compacted session already has history in its transcript. Start counting from
    // here so a quest's tokens are only the ones spent after this point.
    writeCursor(opts.home, payload.session_id, { offset: transcriptSize(payload.transcript_path), seen: [] });
  }
  if (
    (payload.hook_event_name === "Stop" || payload.hook_event_name === "SessionEnd") &&
    payload.transcript_path
  ) {
    const read = readNewUsage(payload.transcript_path, readCursor(opts.home, payload.session_id));
    usage = read.usage;
    writeCursor(opts.home, payload.session_id, read.cursor);
  }

  const event = normalizeClaudeHook(payload, {
    id: randomUUID(),
    ts: (opts.now?.() ?? new Date()).toISOString(),
    machineId: machineId(opts.home),
    targetMode: config.targets,
    repo: repoInfo(cwd),
    usage,
  });
  if (!event) return null;

  // Validate before writing: the schema is the contract with the server and the privacy guarantee.
  const checked = safeParseEvent(event);
  if (!checked.success) return null;
  appendEvent(opts.home, checked.data);
  return checked.data;
}
