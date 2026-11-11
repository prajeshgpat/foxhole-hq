import type { FoxholeEvent } from "@foxhole-hq/schema";

export const NOW = new Date("2026-11-01T12:00:00.000Z");
const MS_PER_MINUTE = 60_000;

/** ISO timestamp `minutes` before NOW. */
export const ago = (minutes: number): string =>
  new Date(NOW.getTime() - minutes * MS_PER_MINUTE).toISOString();

let counter = 0;

export function ev(overrides: Partial<FoxholeEvent> & Pick<FoxholeEvent, "type">): FoxholeEvent {
  counter += 1;
  return {
    v: 1,
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    ts: ago(60),
    source: "claude-code",
    machineId: "m1",
    sessionId: "s1",
    parentSessionId: null,
    ...overrides,
  };
}

export const toolStart = (target: string | null | undefined, tool = "Read", minutesAgo = 60) =>
  ev({ type: "tool.start", tool, target, ts: ago(minutesAgo) });

export const toolEnd = (status: "ok" | "error", minutesAgo = 60) =>
  ev({ type: "tool.end", tool: "Bash", status, ts: ago(minutesAgo) });

/** Tool calls spaced one minute apart, oldest first, ending `endMinutesAgo` before NOW. */
export function starts(targets: readonly (string | null)[], tool = "Read", endMinutesAgo = 30) {
  return targets.map((target, i) => toolStart(target, tool, endMinutesAgo + targets.length - 1 - i));
}

export function ends(statuses: readonly ("ok" | "error")[], endMinutesAgo = 30) {
  return statuses.map((status, i) => toolEnd(status, endMinutesAgo + statuses.length - 1 - i));
}

export const turnEnd = (
  usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined,
  minutesAgo: number,
) =>
  ev({
    type: "turn.end",
    ts: ago(minutesAgo),
    usage: usage ? { outputTokens: 10, ...usage } : undefined,
  });

export const sessionEnd = (minutesAgo = 1) => ev({ type: "session.end", ts: ago(minutesAgo) });

/** A session that touched `repo` on `branch`, optionally editing files. */
export function session(
  sessionId: string,
  opts: {
    repo?: string;
    branch?: string;
    parent?: string;
    edits?: readonly string[];
    editMinutesAgo?: number;
    /** When the session last did something; defaults to recent so it counts as active. */
    activeMinutesAgo?: number;
    ended?: boolean;
  } = {},
): FoxholeEvent[] {
  const {
    repo = "acme/web",
    branch,
    parent = null,
    edits = [],
    editMinutesAgo = 5,
    activeMinutesAgo = 5,
    ended = false,
  } = opts;
  const base = { sessionId, parentSessionId: parent, repo, branch };
  return [
    ev({ ...base, type: "session.start", ts: ago(90) }),
    ev({ ...base, type: "prompt.submit", ts: ago(activeMinutesAgo) }),
    ...edits.map((target) =>
      ev({ ...base, type: "tool.start", tool: "Edit", target, ts: ago(editMinutesAgo) }),
    ),
    ...(ended ? [ev({ ...base, type: "session.end", ts: ago(1) })] : []),
  ];
}

/** Each call as a tool.start then a tool.end, oldest first, one minute apart per event pair. */
export function calls(
  items: readonly { tool: string; target: string; status?: "ok" | "error" }[],
  endMinutesAgo = 30,
) {
  return items.flatMap(({ tool, target, status = "ok" }, i) => {
    const minutes = endMinutesAgo + (items.length - 1 - i) * 2;
    return [
      ev({ type: "tool.start", tool, target, ts: ago(minutes + 1) }),
      ev({ type: "tool.end", tool, status, ts: ago(minutes) }),
    ];
  });
}
