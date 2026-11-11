# @foxhole-hq/health

Pure functions that turn a session's Foxhole events into health signals (docs/PLAN.md section 8.3).
No I/O, no clock (pass `now`), no mutation of inputs.

```ts
import { evaluateSession, evaluateCollisions } from "@foxhole-hq/health";

evaluateSession(events, new Date()); // Signal[] for one session's events, in order
evaluateCollisions([eventsA, eventsB], new Date()); // Signal[] across sessions
```

Thresholds default to `DEFAULT_THRESHOLDS`; pass a `Partial<Thresholds>` as the last argument to override.

## Rules (schema v1)

"Ended" and "needs you" come from `@foxhole-hq/schema` (`isEnded`, `pendingPermission`), the same
definitions the agent's state snapshot uses. A session is ended after a `session.end` or
`subagent.stop` until a later `session.start` or `prompt.submit` revives it. A permission request is
pending until the next `tool.start`, `tool.end`, `prompt.submit`, `turn.end` or ending event; an idle
`session.waiting` does not answer it.

- `loop` (warn, alert at twice the count)
  - Identical repeat: the same (tool, target) `loopRepeatCount` (3) times in a row at the end of the
    session. Edit-type tools (`EDIT_TOOLS`: Edit, Write, MultiEdit, NotebookEdit) never count.
    For a command tool (Bash) the repeat must also look stuck: every call in the run that has a
    matching `tool.end` reported `status: "error"`, or the run has at least `loopRepeatCount +
loopPassingRepeatExtra` (5) repeats whatever the status.
  - Alternation: A-B-A-B-A-B over `loopAlternationLength` (6) calls. Does not fire when A or B is an
    edit-type tool (edit, test, edit, test is normal work).
  - A `tool.start` with no target (WebSearch, TodoWrite, Task) never counts.
- `error-streak`: `errorStreakLength` (3) failed `tool.end` in a row, or more than half of the last
  10 failing (needs all 10). Cleared by a later `turn.end`, `prompt.submit` or ending event.
- `stall`: the latest event is a `tool.start` older than `stallMinutes` (10), session not ended.
  Parallel tool calls can hide a stuck one.
- `long-wait`: a pending permission request older than `longWaitMinutes` (5); `since` is the request.
- `zombie` (info): latest event is `turn.end` or `session.waiting`, older than `zombieMinutes`
  (120), session not ended.
- `cache-drop` (info): the latest turn's cache-read share is under half the mean of earlier turns
  with usage, compared only when its `turn.end` is within `cacheTurnWindowMinutes` (5) of the
  previous turn with usage. After a longer pause a cold cache is normal.
- `collision`: two sessions of one repo, both open and with an event within
  `collisionWindowMinutes` (30) of `now`. Same file edited in the window: warn. Same branch only:
  info (often intended). Sessions of one family (parent, its subagents, their descendants, as far as
  the given events show the parent links) never collide with each other, and neither do sessions in
  the `scratch` repo (unrelated folders). Collision `detail` carries `otherSessionId`, the only
  string in any signal detail.

Snapshot "asleep" versus `zombie`: the state snapshot calls a session "asleep" after 30 quiet
minutes, which is a display state. `zombie` fires at 120 minutes idle and not ended, a "you probably
forgot this" hint. They are different things and do not need to agree.

## Approximations schema v1 forces

- No tool-call id. A `tool.start` is paired with the first `tool.end` after it and before the next
  `tool.start`. With parallel tool calls the pairing can be wrong or missing; it is used only to
  tell a failing command repeat from a passing one, and a call with no tool.end counts as unknown
  (so it does not count as a failure).
- No commit events, so the "working with no commits" half of `zombie` is not implemented.
- In hidden mode targets are null, so `loop` and the file half of `collision` cannot fire there
  (branch collisions still can).
- `permission.request` has no "answered" event; the next sign of progress stands in for it.

## Needs schema v2

Not computable from v1 events, so not implemented:

- Context high (no context-window fill)
- Compaction churn (no compaction events)
- Burn rate (no per-turn token timing beyond turn.end usage)
- Budget and cost (no price or budget data)
- Rate limit near (no rate-limit data)
- Zombie's "working with no commits and no file edits for 30 minutes" half (no commit events)
