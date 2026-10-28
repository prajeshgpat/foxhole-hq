import { claimNext, frame } from "./assign";
import type { ClaudeHookInput } from "./normalize";

/**
 * What a hook prints back to Claude Code, or null for nothing (the usual case: a hook is silent).
 * - Stop: a task queued for the end of this turn becomes `decision: block`, which keeps Claude going with
 *   the task as its next instruction. `stop_hook_active` is set when this Stop was caused by a Stop hook,
 *   so a task is never handed over twice in a row.
 * - UserPromptSubmit: any queued task rides along as extra context for the prompt the user just sent.
 */
export function deliveryFor(payload: ClaudeHookInput, home: string): string | null {
  if (!payload.session_id) return null;
  if (payload.hook_event_name === "Stop" && !payload.stop_hook_active) {
    const item = claimNext(home, payload.session_id, (i) => i.via === "stop");
    return item ? JSON.stringify({ decision: "block", reason: frame(item) }) : null;
  }
  if (payload.hook_event_name === "UserPromptSubmit") {
    const item = claimNext(home, payload.session_id, () => true);
    return item
      ? JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: frame(item) },
        })
      : null;
  }
  return null;
}
