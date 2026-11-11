import type { FoxholeEvent } from "@foxhole-hq/schema";
import type { Signal } from "./types";
import { COMMAND_TOOLS, EDIT_TOOLS } from "./tools";
import { escalate, lastOf, type Events } from "./util";
import type { Thresholds } from "./thresholds";

/** A tool.start and the status of the tool.end that followed it, when one did. */
interface Call {
  readonly start: FoxholeEvent;
  readonly status: FoxholeEvent["status"];
  readonly finished: boolean;
}

/**
 * Schema v1 has no id linking a tool.start to its tool.end, so each tool.start is paired with
 * the first tool.end that comes after it and before the next tool.start. With parallel tool calls
 * the pairing can be wrong or missing (an unpaired call is "not finished"); the rules below only
 * use it to tell a failing repeat from a passing one, never to decide a loop on its own.
 */
function pairCalls(events: Events): Call[] {
  const calls: Call[] = [];
  for (const event of events) {
    if (event.type === "tool.start") {
      calls.push({ start: event, status: undefined, finished: false });
      continue;
    }
    const open = lastOf(calls);
    if (event.type === "tool.end" && open && !open.finished) {
      calls[calls.length - 1] = { ...open, status: event.status, finished: true };
    }
  }
  return calls;
}

/**
 * A tool.start with no target (WebSearch, TodoWrite, Task and similar) cannot be told apart from
 * another call to the same tool, and edit-type tools are making changes, so neither counts
 * towards a loop, in either pattern.
 */
function callKey(call: Call): string | null {
  const { tool, target } = call.start;
  if (!tool || target == null || EDIT_TOOLS.has(tool)) return null;
  return JSON.stringify([tool, target]);
}

function trailingRun(calls: readonly Call[]): readonly Call[] {
  const last = lastOf(calls);
  const key = last ? callKey(last) : null;
  if (key === null) return [];
  let begin = calls.length - 1;
  while (begin > 0 && callKey(calls[begin - 1]!) === key) begin--;
  return calls.slice(begin);
}

/** Commands that did not fail are usually progress (re-running tests), so they need more repeats. */
function repeatsNeeded(run: readonly Call[], t: Thresholds): number {
  const tool = run[0]?.start.tool;
  if (!tool || !COMMAND_TOOLS.has(tool)) return t.loopRepeatCount;
  const known = run.filter((call) => call.finished);
  const allFailed = known.length > 0 && known.every((call) => call.status === "error");
  return allFailed ? t.loopRepeatCount : t.loopRepeatCount + t.loopPassingRepeatExtra;
}

function alternatingWindow(calls: readonly Call[], length: number): readonly Call[] {
  if (length < 4 || calls.length < length) return [];
  const window = calls.slice(-length);
  const keys = window.map(callKey);
  const [a, b] = keys;
  if (a == null || b == null || a === b) return [];
  return keys.every((key, i) => key === (i % 2 === 0 ? a : b)) ? window : [];
}

export function detectLoop(events: Events, t: Thresholds): Signal | null {
  const calls = pairCalls(events);
  const run = trailingRun(calls);
  if (run.length > 0 && run.length >= repeatsNeeded(run, t)) {
    return {
      kind: "loop",
      sessionId: run[0]!.start.sessionId,
      severity: escalate(run.length, t.loopRepeatCount, t.alertMultiple),
      since: run[0]!.start.ts,
      detail: { pattern: 1, calls: run.length },
    };
  }
  const window = alternatingWindow(calls, t.loopAlternationLength);
  if (window.length === 0) return null;
  return {
    kind: "loop",
    sessionId: window[0]!.start.sessionId,
    severity: "warn",
    since: window[0]!.start.ts,
    detail: { pattern: 2, calls: window.length },
  };
}
