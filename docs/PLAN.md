# Foxhole HQ — Project Plan

> See every agent at work, know the moment one needs you, and answer from wherever you are.

Foxhole HQ is a monitoring system for AI coding agents (Claude Code, Codex, and other harnesses). It has two faces over one data model:

- **The den**: an isometric hillside where each repo is a den, each branch a corner, and each agent session an animated fox. It is the ambient, leave-it-open view.
- **The board**: a plain, fast list of every session grouped by what it needs from you. It is the working view, and the default on a phone.

Both show the same things: who is busy, who is stuck, who is waiting on you, what it is costing, and what just finished. Foxes earn XP for verified work, and an opt-in ladder ranks **impact per token**.

Last revised 2026-11-10. Statements about other tools' behaviour come from a documentation survey on that date and are marked _(verify)_ where they have not been tried against a real session.

---

## 1. Goals

| Goal                         | What success looks like                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Ambient awareness**        | One glance tells you which agents are busy, stuck, done, or waiting on you, across every repo and machine. |
| **Never miss a "needs you"** | A permission request reaches you within about two seconds on the den and as a push on your phone.          |
| **Answer from anywhere**     | Approve, deny or hand off a task from the den or the phone, with the terminal still working as usual.      |
| **Catch trouble early**      | Loops, stalls, runaway spend, a full context window and two agents on the same file are flagged for you.   |
| **Any harness**              | Claude Code and Codex first; the same schema takes other harnesses through thin adapters.                  |
| **Fun**                      | A game-like world people leave open all day and show their friends.                                        |
| **Trust**                    | Metadata only by default: never code, prompts, or file contents. Local mode sends nothing off the machine. |

### Non-goals

- **Running agents.** Foxhole observes sessions you started. It does not launch, schedule, or sandbox them, and it does not manage worktrees.
- **Storing or analysing source code, prompts, or responses.**
- **Replacing an agent's own UI.** The terminal prompt always keeps working; Foxhole is a second place to answer.
- **A trace or eval platform.** No prompt replay, no model evals. Langfuse-style tools already do that.
- **Raw token leaderboards.** Token volume is never ranked or rewarded (see §10).
- **Acting without you.** Nothing is approved, assigned, or sent to an agent without an explicit action from you.

---

## 2. Users & use cases

**Solo developer**

- Runs several agents in parallel; the den sits on a second screen.
- Gets a phone push when a fox raises its paw, taps it, reads what is being asked, approves.
- Sees that one session has repeated the same failing command six times and stops it.
- Reviews an end-of-day recap: quests done, time, tokens, cost, time spent waiting on them.

**Developer away from the desk**

- Opens the board on the phone: three working, one waiting, one stuck.
- Answers the waiting one, drops the next task from `TASKS.md` on an idle fox.

**Team**

- Shared HQ floor showing everyone's agents; a wall display in "TV mode".
- Budgets and cost per task for leads; alerts into Slack or Discord.

**Global community**

- Opt-in ladder ranked by verified impact over normalised cost. Seasons, leagues, profile cards.

---

## 3. What exists today

So the rest of this plan can be read against the code as it is:

| Area            | State                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture         | Claude Code plugin with nine hooks, each running `foxhole hook`. One event is appended to `~/.foxhole/events.jsonl` per hook call; there is no batching yet.                                                                             |
| Schema          | `packages/schema`, version 1, strict Zod. Nine event types, three sources (`claude-code`, `codex`, `sdk`).                                                                                                                               |
| Token usage     | Read incrementally from the Claude Code transcript; attached to `turn.end` and `session.end` only.                                                                                                                                       |
| Local server    | `foxhole serve` on `127.0.0.1:4317`. Live updates are **Server-Sent Events** from a 500 ms file poll, with a 500-event backlog replay and resume by event id. `GET /api/state` returns a folded snapshot of every session. No WebSocket. |
| API             | `/api/tasks`, `/api/prs`, `/api/assign` with a per-run token, Origin and Host checks, JSON-only writes and an 8 KB body cap.                                                                                                             |
| Task hand-off   | Inbox file per session, delivered by the `Stop` or `UserPromptSubmit` hook. Built and unit-tested; not yet tried against a real session.                                                                                                 |
| Den page        | `apps/web/prototype/index.html`, one 2,600-line file, Canvas 2D, no build step. Demo and live modes, den panel, drag-to-assign, pinch zoom, keyboard pan and zoom, some ARIA.                                                            |
| Not built       | Persistence beyond the event file, XP storage (the page shows fixed demo values), any other harness, anything hosted, anything push. The health rules package exists but nothing uses it yet.                                            |
| Not phone-ready | No manifest, service worker, notifications, list view, or narrow-screen panel layout. Fonts load from Google Fonts, so the page is not offline-capable.                                                                                  |
| Tests           | Vitest across `agent`, `schema` and `health`. No browser or end-to-end tests.                                                                                                                                                            |

Known gaps to close before building on top:

- **The page token is readable by any local process.** `GET /` returns the page with the token in it and `/events` needs no token. This is acceptable on loopback only, and must be fixed before the server is reachable from a phone (§9).
- The page changes for scratch and folder-named dens have not been run in a browser.
- The README disagrees with this plan in places (it lists React + Vite for the web page, says the CLI prints nothing, and says `.claude/settings.json` is committed). Bring it in line when Phase 1 closes.

---

## 4. Architecture overview

```
 ┌───────────────────────── Your machine ─────────────────────────┐
 │                                                                 │
 │  Claude Code ──hooks────────┐                                   │
 │  Codex ──hooks──────────────┤                                   │
 │  Copilot CLI / Cursor ──────┼──▶ adapters ──▶ foxhole daemon    │
 │  opencode ──event stream────┤   (normalise)   • event store     │
 │  anything else ──HTTP/OTel──┘                 • session state   │
 │                                               • health rules    │
 │            answers ◀── approvals broker ◀──── • approvals       │
 │                                               • local API + SSE │
 └──────────────┬──────────────────────────────────┬──────────────┘
                │ loopback / tailnet (HTTPS)       │ HTTPS, batched,
                ▼                                  ▼ metadata only (opt-in)
      Den · Board · Phone (PWA)        ┌──── Cloud (Cloudflare) ────┐
                                       │ Worker API                 │
                                       │ Dens (1 Durable Object/repo)│
                                       │ HQ aggregate per account   │
                                       │ Push · Scoring · Ladder    │
                                       └────────────┬───────────────┘
                                                    ▼
                                   Hosted den · board · phone · ladder
```

**Key principles**

- **The den is the persistent object.** Each repo gets a den; sessions come and go inside it. Clients connect to dens, never to one session.
- **State, not just events.** The daemon folds the event stream into a current state per session (status, current tool, health, tokens, context fill). Clients fetch a **snapshot** and then apply **deltas**, so a phone that slept for an hour catches up in one request instead of replaying history.
- **Local first.** Everything in Phases 1 to 3 works with nothing leaving the machine. The cloud is an optional relay for reach (any device, push, teams), and it receives the same metadata-only events.
- **Adapters are thin.** An adapter turns one harness's native signals into the shared schema and, where the harness allows, carries an answer back. All logic after that is harness-independent.
- **Fail open to the terminal.** If the daemon is down or slow, hooks return quickly with no decision and the agent behaves exactly as if Foxhole were not installed.

An account's dens sit side by side on one **HQ floor**. The floor subscribes to a small summary feed from each den (awake and asleep counts, who needs you, current quest per branch), not to every event.

---

## 5. Tech stack

### Capture (local)

- **TypeScript on Node**, shipped as one small CLI (`foxhole`) that hooks call.
- **Claude Code plugin** bundling the hooks (§7.1).
- **Codex adapter** installing user-level hooks (§7.2).
- **Generic intake**: a local HTTP endpoint for hook JSON, and an OTLP receiver for harnesses that export OpenTelemetry (§7.4).

### Local daemon

- `foxhole serve` grows from a file follower into the daemon: event store, state folding, health rules, approvals broker, API.
- **Storage:** `events.jsonl` stays the append-only source of truth. A local **SQLite** file holds the folded state, history rollups, XP and achievements, and is rebuildable from the event file. (New dependency; confirm before adding. `node:sqlite` avoids one if the Node floor allows it.)
- **Transport:** SSE for the stream, plain HTTP for snapshot and actions. SSE reconnects by itself and resumes with `Last-Event-ID`, which suits phones. WebSocket is used only in the hosted Durable Objects, where hibernation makes it cheap.

### Backend (hosted, later)

- **Cloudflare Workers** for API and auth.
- **Durable Objects** (SQLite-backed, WebSocket Hibernation API) for one den per repo per account, plus one HQ aggregate per account.
- **D1** for accounts, verified tasks, ladder.
- **GitHub App** for verification; **GitHub OAuth** for sign-in.
- **Web Push** (VAPID) for alerts.

### Frontend

- **Canvas 2D renderer, no dependencies**, for the den.
- **The board and phone views** are plain HTML and CSS over the same state store, so they work without the canvas and stay light.
- The single prototype file is split into modules (world model, renderer, state store, panels) before the board is added; it is already past the size where changes are safe.
- A framework (React + Vite) is adopted only when the hosted app shell needs routing and auth screens. WebGL only if the criteria in §8 trigger.

### Hosting (free tier to start)

| Piece               | Service                                          |
| ------------------- | ------------------------------------------------ |
| Website             | Cloudflare Pages                                 |
| API + dens          | Cloudflare Workers + Durable Objects (free plan) |
| DB                  | D1                                               |
| Plugin distribution | This GitHub repo (plugin marketplace)            |
| Waitlist            | Tally form or a DB table                         |
| Domain              | ~$10/yr                                          |

---

## 6. Event model

### 6.1 Schema

All adapters normalise into one schema. Version 2 extends version 1; old events are upgraded on read, as `session.stop` → `turn.end` already is.

```jsonc
{
  "v": 2,
  "id": "6f1c2b9e-…", // UUID, so retries and replays de-duplicate
  "seq": 418, // per-session counter, so order survives clock skew   (new)
  "ts": "2026-11-10T19:04:11.512Z",
  "source": "claude-code", // see §7 for the list
  "sourceVersion": "2.1.140", // harness version, for adapter fixes          (new)
  "machineId": "m_8f2…",
  "sessionId": "s_41a…",
  "parentSessionId": null, // set for subagents ("cubs")
  "turnId": "t_07", // groups a prompt with its tool calls                  (new)
  "type": "tool.start",
  "tool": "Edit", // normalised name, see 6.3
  "toolUseId": "tu_9c…", // pairs tool.start with tool.end                  (new)
  "target": "src/auth/session.ts", // short label only; hashable or hidden
  "status": "ok", // ok | error | waiting
  "usage": { "inputTokens": 1200, "outputTokens": 340, "cacheReadTokens": 9000, "model": "…" },
  "context": { "usedPct": 62 }, // context window fill, where known           (new)
  "repo": "github.com/owner/name",
  "branch": "feat/csp-headers",
  "worktree": "wt_3", // label when the session runs in a git worktree       (new)
}
```

### 6.2 Event types

| Event type            | Meaning                                             | Fox behaviour                                       | v   |
| --------------------- | --------------------------------------------------- | --------------------------------------------------- | --- |
| `session.start`       | Session began or resumed                            | Wakes up, walks into the den                        | 1   |
| `prompt.submit`       | You sent a prompt                                   | Receives a scroll (new quest)                       | 1   |
| `tool.start`          | A tool call began                                   | Walks to that tool's station and works              | 1   |
| `tool.end`            | A tool call finished (`status` ok or error)         | Error: small stumble and a puff of smoke            | 1   |
| `permission.request`  | The agent is blocked on an approval                 | Stands, raises paw, bouncing "!", light beam, alert | 1   |
| `permission.resolved` | The approval was answered (allow, deny, or timeout) | Paw down, nod or head-shake, back to work           | 2   |
| `session.waiting`     | Idle, waiting for your next message                 | Sits and looks toward you                           | 1   |
| `subagent.start`      | A subagent was spawned                              | A cub pops out of the burrow and runs off           | 2   |
| `subagent.stop`       | A subagent finished                                 | The cub heads home                                  | 1   |
| `context.compact`     | The context window was compacted                    | Shakes off dust; a small "tidied up" mark           | 2   |
| `usage.update`        | Mid-turn token, context, or rate-limit reading      | None; feeds the HUD and health rules                | 2   |
| `turn.end`            | A turn finished                                     | Confetti and floating XP, then idles                | 1   |
| `turn.error`          | A turn ended on an API or harness error             | Sits down dizzy; flagged on the board               | 2   |
| `session.end`         | Session closed                                      | Sleeps; history stays                               | 1   |

`permission.resolved` matters more than it looks: without it a fox keeps its paw up until the next tool call, and "time waiting on you" cannot be measured.

### 6.3 Normalised tools

Harnesses name tools differently. Adapters map them to a small set, which also picks the station:

| Normalised | Examples from harnesses                      | Station     |
| ---------- | -------------------------------------------- | ----------- |
| `read`     | Read, Grep, Glob, `beforeReadFile`           | Bookshelf   |
| `edit`     | Edit, Write, MultiEdit, `apply_patch`        | Desk        |
| `shell`    | Bash, `shell`, `beforeShellExecution`        | Server rack |
| `web`      | WebSearch, WebFetch                          | Window      |
| `agent`    | Task, Agent, `spawn_agent`                   | Burrow      |
| `mcp`      | Any MCP tool (the target is the server name) | Mailbox     |
| `plan`     | TodoWrite, plan updates                      | Quest board |
| `other`    | Anything unmapped (the raw name is kept)     | Desk        |

The raw tool name is kept alongside, so nothing is lost and a new station can be added later.

### 6.4 Den routing

- The adapter fills `repo` from the session's working directory (its git remote) and `branch` from the current branch. A subagent inherits its parent's.
- A repo with no remote gets a den named after its folder, keyed `local/<folder>~<tag>`. The tag is a keyed hash of the repo path (secret in `~/.foxhole/local-key`), so two folders with the same name stay separate and the key is not guessable or linkable across machines. In `hash` and `hidden` target modes the key is the hash alone, with no folder name.
- Sessions outside any repo go to a shared **scratch den** (`scratch`). A git failure or timeout leaves `repo` unset, and the session stays in its last known den.
- Sessions in **git worktrees** of the same repo land in the same den, each on its own branch corner, tagged with the worktree label.

### 6.5 Privacy defaults

- Only tool names, short targets, status, and token counts are recorded. No code, prompts, diffs, tool output, or file contents.
- Target modes: `short` (default), `hash`, `hidden`. Private repos can show an alias.
- Adapters receive more than they keep. Codex and Claude Code hook payloads include prompt text and tool responses; the adapter drops them before anything is written, and tests assert that for every adapter.
- **Local-only mode** is the default until you pair with the hosted service.
- Approval details are the one deliberate exception, and they stay local (§9.3).

### 6.6 Volume control

Not built yet. Needed before the hosted relay, not before: the daemon batches uploads (flush about once a second), collapses runs of identical `read` events, and drops `usage.update` readings that change nothing.

---

## 7. Harness support

### 7.1 Claude Code (built; to extend)

Registered today: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStop`, `Stop`, `SessionEnd`.

To add, in order of value:

| Hook                       | Gives us                                                   |
| -------------------------- | ---------------------------------------------------------- |
| `PermissionRequest`        | Exact approval moment, and a place to return allow or deny |
| `SubagentStart`            | Cubs appear when spawned, not when they finish             |
| `PreCompact`/`PostCompact` | `context.compact`                                          |
| `StopFailure`              | `turn.error`                                               |
| `WorktreeCreate`/`Remove`  | Worktree labels and stale-worktree hints                   |

Other signals worth using _(verify each against a real session)_:

- **Status line JSON** carries context window fill, cost, and rate-limit percentages. It is only available to the configured status line command, so Foxhole would offer an optional wrapper that forwards it and then runs your existing status line.
- **HTTP hooks** (`type: "http"`) would let the hook POST straight to the daemon instead of spawning Node per event. Worth measuring; the command hook stays as the fallback because it works with the daemon down.
- **Channels** (an MCP server that pushes into a running session, research preview) include a permission relay where the terminal and the remote answer both stay live and the first answer wins. This is the cleaner route for remote approval if it leaves preview; the hook route (§9.3) is the one to build first.
- Notification matchers `idle_prompt`, `agent_needs_input` and `agent_completed` can replace the current "anything that is not a permission prompt is waiting" rule.

### 7.2 Codex (next)

Codex has a lifecycle hook system close to Claude Code's _(verify: field names below come from the docs, not a real session)_.

- **Primary: user-level hooks** in `~/.codex/hooks.json`. Events include `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PostModelRequest` (with `token_usage`), `Stop`, and `Interrupt`. Every payload carries `session_id`, `cwd`, `model`, and `transcript_path`.
- **Approvals:** a `PermissionRequest` hook can return allow or deny, or decline so the normal prompt shows.
- **Install:** `foxhole install codex` writes the hooks and tells you to review them with `/hooks`. Codex skips new or changed hooks until you trust them, so the installer must say so plainly, and `foxhole doctor` must detect "installed but not trusted".
- **Fallback: tail the rollout files** under `~/.codex/sessions/`. No setup and it would also catch IDE and desktop sessions, but the format is undocumented and reported to change between releases. Build it only if hooks prove insufficient, behind a version check that degrades to "session seen, details unavailable".
- **Not enough alone:** `notify` fires only on turn completion.
- **Out of reach:** Codex cloud tasks have no local hooks or files.
- A Codex plugin that bundles hooks is not eligible for the public plugin directory, so plain user-level hooks are the distribution route.

Codex sessions share the repo's den with Claude Code sessions and appear as a different animal (§8.5).

### 7.3 Other harnesses

From the documentation survey. "Answer" means a hook or API can return an approval decision.

| Harness            | Integration point                          | See approvals | Answer  | Tokens          | Effort | When        |
| ------------------ | ------------------------------------------ | ------------- | ------- | --------------- | ------ | ----------- |
| Claude Code        | Hooks (built)                              | Yes           | Yes     | Yes             | Done   | Now         |
| Codex              | Hooks                                      | Yes           | Yes     | Yes             | S      | Phase 2     |
| GitHub Copilot CLI | Hooks (command or HTTP)                    | Yes           | Yes     | Unknown         | M      | Phase 4     |
| Cursor             | Hooks (JSON over stdio)                    | Partly        | Yes     | At compact only | M      | Phase 4     |
| opencode           | Server event stream + permissions endpoint | Yes           | Yes     | Unknown         | M      | Phase 4     |
| Qwen Code, Kimi    | Claude-style hooks                         | Qwen yes      | Partly  | Unknown         | S      | Phase 4     |
| Gemini CLI         | OpenTelemetry + hooks                      | Yes           | Unknown | Yes             | M      | On demand   |
| Cline              | `--json` stream, hooks                     | Unknown       | Unknown | Unknown         | M      | On demand   |
| Aider              | Log files only                             | No            | No      | No              | L      | Not planned |

Gemini CLI's docs say it has been replaced by a successor CLI, so it waits until that settles.

### 7.4 The generic path

Three ways in for anything not in the table, cheapest first:

1. **Hook receiver.** `POST /ingest/hook?source=<name>` on the daemon accepts the Claude-style hook JSON that Codex, Copilot CLI, Qwen and Kimi all resemble, with a small per-source field map. A new harness with similar hooks is a config file, not a package.
2. **OTLP receiver.** The daemon accepts OpenTelemetry logs and metrics on loopback and maps known names (`claude_code.*`, `codex.*`, `gemini_cli.*`, `gen_ai.*`) to events. It is coarser than hooks and cannot answer approvals, but it needs no per-harness code and prompts are redacted at the source by default.
3. **SDK.** `@foxhole/sdk` with `session()`, `tool()`, `needsYou()`, `done()` for people building their own agents.

An **Agent Client Protocol proxy** would reach the widest set of agents with one adapter, since the protocol has standard tool-call and permission messages. Nothing documents proxying, so it starts as a time-boxed spike, not a commitment.

An MCP "report status" tool is not a monitoring mechanism: it only fires when the model chooses to call it.

### 7.5 Adapter contract

Each adapter is one package that provides:

- `install()` / `uninstall()`: write and remove the harness config, never touching unrelated entries.
- `normalise(payload) → Event | null`: pure, with fixture tests from real payloads.
- `redact`: a test that prompt text, tool input bodies and tool output never reach an event.
- `answer(permissionId, decision)`: optional; only where the harness supports it.
- `doctor()`: is it installed, trusted, the right version, and has an event arrived recently.

A capability record per adapter (`approvals: see | answer | none`, `tokens`, `subagents`, `context`) drives the UI, so a harness that cannot answer approvals shows "open terminal" instead of Approve.

---

## 8. The views

### 8.1 Session status

Every view uses one status per session, folded from events by the daemon:

| Status        | Meaning                                     | Colour | Fox                    |
| ------------- | ------------------------------------------- | ------ | ---------------------- |
| **Needs you** | Blocked on an approval or a question        | Gold   | Paw up, light beam     |
| **Stuck**     | A health rule fired (§8.3)                  | Red    | Dizzy, smoke           |
| **Working**   | A turn is in progress                       | Green  | At a station           |
| **Idle**      | Turn finished, waiting for your next prompt | Blue   | Sitting, looking up    |
| **Done**      | Finished and its PR is open or merged       | Teal   | Celebrating, then rest |
| **Asleep**    | Session ended or quiet for a long time      | Grey   | In bed or the Commons  |

Status is never colour alone: each has an icon and a word.

### 8.2 The board

A list of sessions grouped by status, in the order above, so what needs you is always at the top.

- **Row:** animal and name, repo and branch, harness badge, status, current tool and target, a one-line activity summary built from metadata ("editing 3 files in `src/auth`, 2 test runs, 1 failure"), time in status, tokens and cost this turn, context fill bar, health badges, PR and CI state.
- **Actions on a row:** approve or deny, assign a task, go to its den, copy a `resume` command for its terminal, mute, pin.
- **Filters:** repo, branch, harness, machine, status. Search by name or branch. Saved filters.
- **Sort:** by status, by longest waiting, by cost.
- Works with the canvas off, with a screen reader, and at 360 px wide.

The **approvals inbox** is the board filtered to "needs you", oldest first, with the wait time on each. It is the landing screen on a phone.

### 8.3 Health signals

Computed by the daemon from metadata only. Each has a default threshold in config, a badge on the board, a visible effect on the fox, and an optional alert. Thresholds below are starting points to tune against real sessions.

| Signal               | Rule (default)                                                                 | Shown as                   |
| -------------------- | ------------------------------------------------------------------------------ | -------------------------- |
| **Loop**             | The same `(tool, target)` 3 times in a row, or an A-B-A-B pattern over 6 calls | Fox paces in a circle      |
| **Error streak**     | 3 failed tool calls in a row, or over half failing in the last 10              | Repeated stumbles          |
| **Stall**            | A tool call open for 10 minutes with no other event                            | Fox frozen, clock icon     |
| **Long wait**        | "Needs you" for more than 5 minutes                                            | Beam pulses faster         |
| **Context high**     | Context window over 80% full                                                   | Backpack overflowing       |
| **Compaction churn** | 3 compactions in one turn                                                      | Dust cloud                 |
| **Burn rate**        | Tokens per minute over 3× the session's own median for 5 minutes               | Lantern burning bright     |
| **Budget**           | Session, repo, or daily spend past 80% and 100% of a budget you set            | Coin purse icon            |
| **Rate limit near**  | Five-hour or weekly limit over 80% (where the harness reports it)              | Hourglass on the HUD       |
| **Cache drop**       | Cache-read share of input falls by half against the session's earlier average  | Badge only                 |
| **Collision**        | Two live sessions in one repo editing the same file, or on the same branch     | A thread between the foxes |
| **Zombie**           | Idle for 2 hours, or working with no commits and no file edits for 30 minutes  | Cobweb                     |

Collision detection needs real paths, so it runs in `short` target mode and on salted hashes in `hash` mode, and is off in `hidden` mode.

Rules are pure functions over a session's recent events, in their own package with fixture tests. No model call is involved.

As built against schema v1 (`packages/health/README.md` has the detail):

- **Loop** ignores edit tools and calls with no target, and for shell commands needs the repeats to be failing, or five in a row.
- **Stall** sees only "the latest event is a tool start"; there is no tool-call id to pair a start with its end until schema v2.
- **Zombie** covers the idle half only; "working with no commits" needs commit events.
- **Collision** needs both sessions active in the last 30 minutes, ignores a parent and its cubs, and skips the scratch den. Same branch alone is informational.
- Context, compaction, burn rate, budget and rate limit wait for schema v2.

### 8.4 Session detail

- **Timeline:** turns as rows, tool calls as segments coloured by normalised tool, errors and approvals marked, waiting time shaded. This is the same data as the fox's walk, laid flat.
- **Numbers:** tokens in, out, cached; cost; context fill over time; time working against time waiting on you.
- **Lineage:** parent and cubs as a small tree.
- **Links:** the prompt-to-PR trail. The session is tied to its branch, the branch to its PR (via `gh`), so a PR shows which sessions produced it and what they cost.
- **Actions:** approve, assign, copy resume command, mute, export this session's events as JSON.

### 8.5 The isometric world

#### Rendering

- **Plain Canvas 2D, no WebGL and no dependencies.**
- **Fixed 2:1 isometric projection** (tiles 64×32 px, heights in px). One viewing angle; the camera does not rotate.
- **Painter's order:** lawn → rooms back to front → glass fronts → outdoor scenery → fox labels → particles → floating signs.
- **Look:** flat-shaded polygons, pixel-art animals drawn from character grids, a night palette, warm lantern glows, no real-time shadows.
- **Decision: keep the canvas renderer.** Revisit WebGL only if the performance work cannot hold 60 fps with ~20 open dens on a mid-range laptop, free camera rotation becomes a must, or we move to 3D assets. The world model is renderer-independent.

#### The HQ floor and dens

- **A hillside.** The lawn slopes gently down toward the viewer; every room is dug into it.
- **The Commons and a pyramid of dens.** Rooms tile one rectangle of 13×11-tile cells. The Commons takes the back corner; each repo's den takes the next cell in a fixed order (1, 3, 2, 4, 7, 5, 6, 8, then the pattern repeats) that grows the grid a row, then a column, alternating, up to 6×6 (35 dens). Foxes from later repos wait in the Commons.
- **Always a full rectangle.** A cell no den has taken is absorbed by the room to its left, which runs wider.
- **Floors step down.** Each ring of cells sits one step lower than the ring behind it, so the Commons is the top of the pyramid.
- **Walls and edges.** Earth retaining walls on the back sides only; retaining faces or low dividers between rooms; glass fronts (20% opaque) on open edges so you can see the den is underground.
- **Ways in.** A hole in the back wall, the left wall, or a floor hatch linked by a tunnel to a hole on the lawn. Foxes climb down shafts and vanish into holes.
- **Opening and closing.** A den is dug open when one of its foxes wakes and fills back in after 5 minutes with every fox asleep, last in first out. **Pinned dens** stay open and take the cells nearest the Commons.
- **Moving around.** Drag to pan, scroll or pinch to zoom, arrow keys and +/− when focused. Clicking a sign, floor or fox flies the camera there. The **fit button** (or `0`) frames every den.
- **Signs and corners.** Each den has a floating sign (repo name or alias, status, gold when a fox needs you, red when one is stuck). Each branch gets a rug corner in its own colour with a floor tag. More than four branches fold the quietest into a "more" rug.
- **The Commons.** A lounge with a bar, arcade cabinets, a TV, a pong table, a couch and a reading nook. A session that goes quiet sends its fox there; it walks back when the session wakes.
- **Outdoors.** A river with a bridge, trees, bushes, flowers, rocks and wildlife.

#### Animals

One species per harness, so a mixed den reads at a glance: **foxes** for Claude Code, **raccoons** for Codex, and others (otter, badger, owl, hedgehog) assigned as adapters arrive. Subagents are always cubs of their parent's species. Species is cosmetic and can be overridden per machine.

#### Stations

- **Per den:** bookshelf (`read`) · server rack (`shell`) · window, with a telescope on back-wall dens (`web`) · burrow (`agent`) · mailbox (`mcp`) · quest board (`plan`, and the den's tasks) · beds · plant.
- **Per branch corner:** that branch's desks, with glowing monitors while an animal edits.
- **In the Commons:** hangout spots, a **status board** mirroring the board view for every den, and a trophy cabinet.

#### Behaviour

- **States:** idle, walking, working, waiting (paw up), celebrating, stumbling, dizzy (stuck), sleeping, climbing and diving, plus the health effects in §8.3.
- **Movement:** breadth-first search over each den's tile grid; routes across the lawn for trips to the Commons.
- **Labels:** drawn above each animal (name, current target, status pill), stacked so they don't overlap, shown when zoomed in.
- **Demo mode:** scripted quests per den, including a stuck fox and an approval, so the demo shows the monitoring and not only the scenery.

#### Juice

- Rooms dug open with dust and clods; confetti and floating +XP on a finished quest; tap a fox and it hops, and the panel opens on its detail.
- **Sound, off by default:** a soft chime for "needs you", distinct from "done".
- **Replay:** scrub back through the day and watch the hillside at speed. The data is already in the event store.
- Later: day and night tied to local time, weather tied to CI (rain over a den with a failing main), unlockable decor.

#### Performance (runs all day)

- **Done:** device pixel ratio capped at 2; scenery culled to the screen; tufts, flowers and floor tiles batched; ~30 fps when the view is still; drawing paused in hidden tabs. _(Listed as done in the previous plan; re-measure when the file is split.)_
- **Next:** reuse gradients, skip off-screen rooms, measure sign text once.
- **Low-power mode:** 1× pixel ratio, 20 fps, no small scenery. Automatic on battery saver and when `prefers-reduced-motion` is set, and the default on phones.

---

## 9. Acting from the dashboard

### 9.1 Task hand-off (built)

Clicking a den opens its panel with the repo's tasks (`TASKS.md`) and open pull requests. A task can be dragged onto an animal or assigned from a menu. It is queued in that session's inbox and delivered by the `Stop` or `UserPromptSubmit` hook. Local only, user-initiated, with a confirm step.

Next: GitHub issues and Linear as task sources; a Foxhole MCP server (`foxhole_next_task`) so an agent can ask for its next task; assignment to Codex sessions through the same inbox once its `Stop` hook is confirmed to continue a turn.

Task text and PR titles are untrusted input: capped, framed as a user request, never assigned automatically, never written to `events.jsonl`.

### 9.2 Reaching the daemon from other devices

The fix for the readable page token comes first, because every option below widens who can reach the server.

**Pairing replaces the embedded token.**

1. `foxhole pair` prints a one-time code and a QR code, valid for two minutes.
2. The device opens the link; the daemon exchanges the code for a session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`).
3. Every route requires it, including `/` and `/events`. The local browser pairs the same way on first run, automatically.
4. Each paired device has a name, a role, and a revoke button. Roles: **view** (see status), **act** (approve, deny, assign). A phone is paired as **view** unless you choose otherwise.

**Routes to the phone, safest first:**

| Route                           | HTTPS | Exposure          | Push works | Verdict                                       |
| ------------------------------- | ----- | ----------------- | ---------- | --------------------------------------------- |
| Tailscale Serve                 | Yes   | Your tailnet only | Yes        | **Default.** `foxhole serve --tailnet`        |
| Hosted relay (Phase 5)          | Yes   | Your account      | Yes        | For people without a tailnet, and for teams   |
| Named Cloudflare Tunnel         | Yes   | Public URL        | Yes        | Documented, opt-in, behind pairing            |
| LAN bind + QR                   | No    | Your network      | No         | View only; no service worker, no push         |
| Quick tunnels, Tailscale Funnel | Yes   | Public            | —          | Not supported: public by default, SSE-hostile |

The daemon keeps binding to loopback. Tailnet mode lets Tailscale terminate TLS and forward to it; the Host allow-list gains exactly the tailnet name, and Origin checks stay.

### 9.3 Approvals

The flow, harness-independent:

1. The harness fires its permission hook. The adapter records `permission.request` and asks the daemon for a decision, holding the hook open.
2. The daemon shows it in the approvals inbox, raises the paw, and alerts you.
3. You open it and see **what is being asked**: the tool, the full command or file path, the session, repo and branch. You tap Approve or Deny.
4. The daemon returns the decision to the hook, records `permission.resolved`, and the agent continues.
5. If nobody answers within the hold time (default 60 seconds, configurable), or the daemon is unreachable, the hook returns **no decision** and the harness shows its normal terminal prompt. The inbox entry changes to "answer in terminal".

Rules that do not bend:

- **Never allow by default.** Timeouts, errors and a dead daemon all fall through to the terminal prompt, never to "allow".
- **No standing approvals from Foxhole.** There is no "always allow" from the dashboard; that stays a decision made in the harness's own settings. Harness deny rules still win over an allow.
- **Approval details stay local.** Seeing a full command conflicts with "metadata only", so the detail is held in daemon memory, shown only to paired devices with the **act** role, never written to `events.jsonl`, and never sent to the hosted service. Hosted push says "a fox needs you in `repo`" and deep-links to your own daemon. End-to-end encrypted detail through the relay is a later, opt-in feature.
- **One request, one answer.** Each request has a single-use id that expires with the hold; a replayed answer is rejected.
- **Confirm on the phone.** A notification never approves by itself. Tapping it opens a confirm sheet; an Android action button opens the same sheet.
- **Audit log.** Every decision is written locally: when, which device, which session, allow or deny (not the command).

Open point to settle with a real session: whether the terminal prompt is usable while the hook is held, for each harness. If it is not, a 60-second hold delays the person at the keyboard, and the hold must drop to a few seconds unless a remote device is actually connected.

### 9.4 Other actions

- **Nudge:** send a short message to an idle session (through the same inbox as tasks).
- **Mute / snooze** a session, a den, or everything for an hour.
- **Stop** is deliberately absent. Foxhole does not kill processes; it shows the command to do it yourself.

---

## 10. Notifications

A paw nobody sees is the failure this product exists to prevent; an alert for everything is the failure that gets it uninstalled.

**What can alert** (each on or off, per channel): needs you · stuck (any health signal, individually selectable) · long wait · budget reached · turn finished · PR checks failed · session ended with an error.

**Defaults:** "needs you" and "budget reached" push immediately. "Stuck" pushes after it has held for two minutes. "Turn finished" is a den toast only.

**Policy controls**

- Per repo and per session overrides; mute and snooze.
- **Quiet hours** and a **focus mode** that holds everything except "needs you".
- **Grouping:** several alerts from one den within 30 seconds become one notification with a count.
- **Escalation:** a "needs you" unanswered for 5 minutes repeats once, then stops.
- **Presence:** if the den tab is focused and visible, the phone is not pushed.
- The app badge shows the count of sessions that need you.

**Channels**

| Channel              | Needs                        | Actions                      | Notes                                                 |
| -------------------- | ---------------------------- | ---------------------------- | ----------------------------------------------------- |
| Den toast + sound    | The page open                | Full                         | Built for toasts; sound to add                        |
| Desktop notification | Browser permission           | Click to focus               | Local                                                 |
| Web Push             | PWA installed, secure origin | Deep link (Android: buttons) | Primary phone channel                                 |
| ntfy (self-hosted)   | Your ntfy server             | Link button                  | No command text in messages; random topic             |
| Slack / Discord      | A webhook                    | Link                         | Team tier                                             |
| Command hook         | A script path                | Yours                        | `notify.command` gets the alert JSON; covers the rest |

Messages contain the repo alias, session name and reason. Never a command, path, or prompt.

---

## 11. Mobile

The phone is a first-class client, not a shrunken den.

### 11.1 Layout

- **Bottom tab bar** (thumb reach): **Inbox** · **Board** · **Den** · **Stats**. Inbox is the default and shows a count.
- **Inbox:** approval cards, oldest first. Card → bottom sheet with the detail and two large buttons.
- **Board:** the same list as desktop, one column, swipe a row for actions.
- **Den:** the canvas in low-power mode, one den at a time with a den switcher; pan, pinch, tap. The side panel becomes a bottom sheet with three heights.
- **Stats:** today's recap first.
- Touch targets at least 44×44 px. `env(safe-area-inset-*)` on all edges. Heights in `svh`, not `vh`. No hover-only affordances; drag-to-assign has the menu alternative it already has.
- Landscape and tablets get the desktop two-pane layout from 900 px.

### 11.2 Installable app (PWA)

- `manifest.webmanifest` with a stable `id`, `display: standalone`, maskable icons, theme colour, and shortcuts to Inbox and Board.
- **Service worker:** precache the app shell only (HTML, JS, CSS, fonts served locally instead of from Google Fonts). `/events`, `/api/*` and pairing are always network-only and never cached.
- **Install prompt:** on iOS, a one-time explainer ("Share → Add to Home Screen"), because push only works for an installed app there. On Android, the native prompt.
- **Wake lock** toggle for desk-stand use; re-acquired on return to the tab.
- **Offline:** the last snapshot is shown greyed with "last updated 4 min ago". Actions are disabled, not queued; an approval sent late is worse than none.

### 11.3 Staying live

- On open, on `visibilitychange`, and on `online`: fetch `GET /api/state` (the snapshot, with a version), then open the stream with `Last-Event-ID`.
- If the server no longer has that id, it sends `resync` and the client refetches the snapshot.
- The stream is per account (or per daemon), not per den, so a phone holds one connection.
- No reliance on background sync or background connections; phones kill them. Push is what wakes you, the snapshot is what catches you up.

### 11.4 Push

- **Web Push with VAPID.** Permission is asked from a tap on "Turn on alerts", never on load.
- Every push shows a notification (required on iOS) and deep-links to `/inbox/<id>`.
- **Android:** Approve and Deny buttons, both opening the confirm sheet.
- **iOS:** notification action buttons appear not to be supported for web apps _(verify on a device)_; the tap-through path is the design, so nothing depends on them.
- Local mode can push too: the daemon holds the VAPID key and calls the browser push services directly, sending only "needs you in `alias`".

### 11.5 What needs a native app

Live Activities and lock-screen widgets, alerts that break through Focus, watch complications, and iOS action buttons all need a native shell. None are needed for the core loop. Revisit after the PWA has real use; a thin wrapper around the same web views is the route if so.

---

## 12. Stats, cost and budgets

- **Daily recap:** quests finished, PRs opened and merged, time working, **time agents spent waiting on you**, tokens, cost, the costliest session, anything that got stuck.
- **Cost:** per session, repo, branch, harness and model, from token counts and a price table in config (editable; dated; flagged when a model is missing from it). Subscription plans show tokens and a notional cost, labelled as such.
- **Budgets:** per day, per repo, per session. Soft (alert at 80%) and hard-looking (alert at 100%, fox sits down) but never enforcing; Foxhole cannot stop a session.
- **Limit forecast:** where the harness reports rate-limit usage, show the five-hour and weekly bars and a projected time to the limit at the current burn across all sessions.
- **Trends:** cost per merged PR, cache-read share, error rate, approvals per hour and median time to answer.
- **Export:** CSV and JSON of rollups; the raw event file is already yours.

---

## 13. Gamification

### Personal progression

- **XP** for completed quests, tests passing, PRs merged. Stored locally (not built yet; the page shows fixed demo values).
- **Levels** unlock cosmetics. **Streaks** for consecutive active days.
- **Achievements**, e.g. _First Quest_, _Zero-Error Shift_, _Cub Wrangler_ (5 subagents in one quest), _Night Owl_, _Lean Machine_ (top-10% efficiency on a quest), _Quick Draw_ (answered ten approvals in under a minute each), _Mixed Litter_ (two harnesses in one den).

XP never rewards token volume, session count, or hours. It rewards finished, verified work.

### Global ranking: impact over cost

Opt-in, and deliberately last on the roadmap. Company token leaderboards have been gamed with busy-work agents and withdrawn; the design below exists to avoid that, and the ladder ships only if it holds up in a closed season first.

#### Verified impact (via GitHub App, never self-reported)

| Signal                                    | Role                                     |
| ----------------------------------------- | ---------------------------------------- |
| PR merged                                 | Base unit of impact                      |
| CI/tests green on merge                   | Multiplier                               |
| Survives 14 days (not reverted/rewritten) | Points confirmed after a delay           |
| Linked issue closed                       | Bonus, weighted by labels (bug, feature) |
| Change size & repo size                   | Log-scaled difficulty factor             |

Tasks without a verifiable outcome earn personal XP only.

#### Score

```
task_score    = impact_points / normalized_token_cost
impact_points = base × ci_mult × survival_mult × issue_bonus × log(1 + difficulty)
```

**Safeguards**

- Tokens normalised to cost per model; ranking within **model-tier leagues**.
- Log-scaled impact and a minimum threshold, so trivial one-liners cannot dominate.
- Bayesian smoothing toward the global mean until ~20 verified tasks.
- Monthly seasons with resets.
- More spend can only lower a score. There is no metric anywhere that rises with tokens used.

#### Leagues

Kit → Red Fox → Silver Fox → Arctic Fox → Nine-Tailed Kitsune.

#### Anti-gaming

- Events signed with the pairing token; usage read from local session data.
- Cross-check token totals against outcome size (huge PR + tiny usage = flag).
- Farm repos, self-merged PRs in solo repos and sudden efficiency spikes get reduced weight or exclusion.
- Public repos only for the world ladder.

#### Privacy

- Pseudonymous (fox names), opt-in.
- Private repos count toward a **private team board** only.
- **Team boards rank dens and quests, not people**, by default. Per-person views are visible to that person only. A monitoring tool that becomes a way to rank colleagues will be turned off by the people it is installed for.

---

## 14. Screens

1. **Landing page** — the den in demo mode as the hero, "how it works", the privacy promise, the harness list, waitlist.
2. **First run** — `foxhole` with no arguments: detects installed harnesses, offers to install each adapter, opens the den, shows the demo until the first real event arrives.
3. **HQ floor** — the Commons and the pyramid of dens, a den list in the side panel, the fit button, the "needs you" bar.
4. **Board** — §8.2.
5. **Approvals inbox** — §9.3.
6. **Den** — one den up close; its panel has Tasks, Pull requests, and Sessions tabs.
7. **Session detail** — §8.4.
8. **Stats** — §12.
9. **Quests & achievements** — quest board, trophy shelf.
10. **Settings** — harnesses (with doctor results), devices and roles, privacy (target mode, aliases), notifications, budgets, thresholds, appearance (low-power, reduced motion, sound).
11. **TV mode** — full-screen floor, no panels, auto-cycles dens that have activity, large status strip. Read-only share link.
12. **World ladder**, **Profile card**, **Team HQ** — hosted, later.

### Ease of use

- **Two commands to value:** install the plugin, run `foxhole serve`. Everything else is optional.
- **`foxhole doctor`** answers "why is my fox not moving": hooks installed and trusted, daemon running, last event per harness, port, pairing, push subscription.
- **`foxhole status`** prints the board in the terminal, for people who never open the page.
- **Empty states teach:** an empty den says which command to run next.
- **Command palette** (`Ctrl/Cmd+K`): jump to a den, session or branch; run any action.
- **Keyboard:** `g i` inbox, `g b` board, `j/k` move, `a` approve, `d` deny, `/` search, `?` help.
- **Deep links** for every den, session and approval, so a notification, a chat message, and a terminal line all land in the same place.
- **Accessibility:** WCAG 2.2 AA. The board is the accessible equivalent of the canvas: every state the den shows is in it as text. Status never by colour alone; reduced motion respected; live regions for "needs you".
- **Plain words** in the UI: "needs you", "stuck", "working". The fox vocabulary (quests, cubs, dens) decorates; it never replaces the plain label.

---

## 15. Security model

| Surface                            | Risk                                            | Control                                                                                                           |
| ---------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Local API                          | Another process or web page drives it           | Loopback bind, Host allow-list, Origin check, paired-device cookie on **every** route, JSON-only writes, body cap |
| Page token (today)                 | Readable by any local process                   | Replaced by pairing (§9.2) before any non-loopback access                                                         |
| Remote approval                    | Someone else approves a command on your machine | **act** role per device, single-use request ids, confirm sheet, never-allow-by-default, audit log, revoke         |
| Hook payloads                      | Prompts and code leak into events               | Adapters drop content before writing; a redaction test per adapter; strict schema rejects unknown fields          |
| Task text, PR titles, issue bodies | Prompt injection into an agent session          | Capped, framed as a user request, never auto-assigned, shown to you before delivery                               |
| `gh` and `git` calls               | Command injection                               | `execFile` with argument arrays, validated repo keys, timeouts                                                    |
| Repo file reads                    | Path traversal, symlinks out of the repo        | Root-only `TASKS.md`, symlink refusal, size cap                                                                   |
| Harness config edits               | Installer breaks or hijacks someone's hooks     | Idempotent, additive, backed up, shown as a diff before writing, clean uninstall                                  |
| Hosted relay                       | A breach exposes activity                       | Metadata only, aliases for private repos, no approval details, per-machine revocable tokens, retention limits     |
| Push messages                      | Third-party push services read content          | Reason and alias only                                                                                             |
| Share links                        | A leaked link shows your floor                  | Read-only, revocable, expiring, aliases enforced, no targets                                                      |

Reviewed with the `security-review` and `agent-security-hardening` checklists at each phase gate; the approvals flow gets a dedicated review before it ships.

---

## 16. Connecting & staying connected (hosted)

### One-time pairing (device flow)

1. Install plugin → run `/foxhole connect`.
2. It prints a one-time link, e.g. `foxhole-hq.com/pair/K7F-29Q`.
3. You click, sign in with GitHub, confirm.
4. A long-lived, revocable machine token is stored at `~/.foxhole/token` (mode 0600).
5. Every future session on that machine connects automatically.

### Links

- **Pairing link** — one-time, connects a machine, then expires.
- **HQ link** — permanent view of your whole floor (`foxhole-hq.com/<handle>`).
- **Den link** — one per repo (`foxhole-hq.com/<handle>/<repo>`).
- **Share link** — read-only, revocable; one den or the whole floor.

### Persistence

- Each den's state lives in its own Durable Object; history in SQLite.
- When sessions end, foxes go to bed; the page stays connected and shows a quiet night state and the daily recap.
- New sessions wake foxes without a refresh; a new repo creates its den automatically.
- **Multi-machine:** sessions from every paired machine land in the same dens; each fox carries a small machine tag, and the board filters by machine.

---

## 17. Monetization

| Tier           | Price (draft)  | Includes                                                                                                        |
| -------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| **Free**       | $0             | Everything local: all harnesses, den, board, health signals, approvals, phone over your tailnet, 30-day history |
| **Pro**        | $5–8/mo        | Hosted relay (any device, no tailnet), hosted push, multi-machine floor, unlimited history, all cosmetics       |
| **Team**       | $10–15/user/mo | Shared floor, budgets, cost per task, Slack and Discord alerts, TV mode links, audit log                        |
| **Enterprise** | Custom         | Self-hosting, SSO, retention controls                                                                           |

**Positioning:** local is complete and free, which is what earns the trust to pay for reach. Lead with "never miss a needs-you" and the fun of the den; sell teams visibility and cost insight. Supporting many harnesses in one view is the moat against each vendor's own status screen, which will only ever show its own agents.

---

## 18. Roadmap

Phases are ordered so each one is usable by itself.

### Phase 0 — Prove the data ✅

- [x] Claude Code hooks log normalised events to a local file.
- [x] Token usage read per session from the transcript.
- [x] Permission and subagent payloads confirmed on real sessions.

### Phase 1 — Local den (closing)

- [x] `foxhole` CLI and plugin bundle.
- [x] Local server with a live event stream (SSE).
- [x] Den per repo, corner per branch, HQ floor (pyramid grid, fit button, glass fronts).
- [x] Foxes, stations, branch corners, cubs in the prototype _(stations to re-check when the file is split)_.
- [x] Register `PostToolUseFailure`.
- [x] Scratch den and folder-named dens for sessions without a remote _(page changes not yet run in a browser)_.
- [ ] Performance pass: finish the "next" items in §8.5 and measure.
- [x] Bring the README in line with this plan.
- [ ] Publish the plugin from this repo.

### Phase 1.5 — Den panel ✅ (one check left)

- [x] Server hardening, repo path recording, `/api/prs`, `/api/tasks`, den panel, assign, drag-to-assign.
- [ ] Try hand-off against a real Claude Code session (`Stop` with `decision: block`, `UserPromptSubmit` with `additionalContext`).

### Phase 2 — Monitor core and Codex

The step from "animated den" to "monitoring system". Schema v2 is designed against two harnesses at once so it does not fit only one.

- [ ] Schema v2 (§6): `seq`, `turnId`, `toolUseId`, normalised tools, new event types, upgrade-on-read.
- [x] State folding in memory, `GET /api/state` snapshot, stream resume with `Last-Event-ID` or `?since=`.
- [ ] Local SQLite for folded state and history; the page using the snapshot and handling `resync`.
- [ ] Claude Code: `PermissionRequest`, `SubagentStart`, compaction, `StopFailure` hooks.
- [ ] **Codex adapter** (hooks), `foxhole install codex`, raccoons in the den.
- [ ] Adapter contract and `foxhole doctor`.
- [ ] Split the prototype into modules; add the **board** and **session detail**.
- [x] Health rules package (`packages/health`): loop, error streak, stall, long wait, zombie, cache drop, collision.
- [ ] Wire health signals into the snapshot; badges and fox effects; the rules that need schema v2 (context, compaction, burn rate, budget, rate limit).
- [ ] Cost: price table, per-session and per-repo totals, budgets, daily recap.
- [ ] Personal XP, levels and achievements stored locally.
- [ ] Browser tests (Playwright) for the board and the assign flow.

### Phase 3 — Phone and approvals

- [ ] Pairing with device roles; cookie on every route; remove the embedded token.
- [ ] `foxhole serve --tailnet`.
- [ ] Mobile layout: tab bar, inbox, bottom sheets, low-power den.
- [ ] PWA: manifest, service worker, local fonts, install prompt.
- [ ] Approvals broker and inbox; Claude Code first, then Codex. Dedicated security review.
- [ ] Web Push from the local daemon; notification policy (§10); app badge.
- [ ] Test on real iOS and Android devices: push delivery, action buttons, reconnect after sleep.

### Phase 4 — More harnesses

- [ ] Generic hook receiver and field maps.
- [ ] Copilot CLI, Cursor, opencode adapters.
- [ ] OTLP receiver.
- [ ] `@foxhole/sdk`.
- [ ] Agent Client Protocol proxy spike (two days; go or no-go).
- [ ] Task sources: GitHub issues, Linear. Foxhole MCP server (`foxhole_next_task`).

### Phase 5 — Hosted

- [ ] Landing page and waitlist (can start any time; it only needs the demo).
- [ ] GitHub OAuth, machine pairing, tokens.
- [ ] Batching uploader in the daemon.
- [ ] Durable Object dens with hibernating WebSockets, HQ aggregate, history.
- [ ] HQ, den and share links; TV mode; hosted push.
- [ ] Multi-machine floor.

### Phase 6 — Teams and billing

- [ ] Shared floor, team budgets, cost per task, Slack and Discord alerts, audit log.
- [ ] Billing (Stripe), Pro and Team tiers.
- [ ] Cosmetic shop, seasonal events.

### Phase 7 — Ladder

- [ ] GitHub App verification (merge, CI, survival, issues).
- [ ] Scoring service, normalisation, smoothing, anti-gaming checks.
- [ ] One closed season with volunteers; publish what was gamed and what held.
- [ ] Seasons, leagues, profile cards — only if the closed season holds up.

---

## 19. Repo structure

```
foxhole-hq/
├── docs/               # PLAN.md, CONTRIBUTING.md, adr/
├── README.md
├── packages/
│   ├── schema/         # event contract (Zod), capability records
│   ├── agent/          # foxhole CLI + daemon: store, state, API, approvals
│   ├── health/         # health rules (pure functions + fixtures)
│   ├── plugin-claude/  # Claude Code plugin (hooks config + bundle)
│   ├── adapter-codex/  # Codex hooks installer + normaliser
│   ├── adapter-*/      # copilot, cursor, opencode, otlp
│   ├── sdk/            # @foxhole/sdk for custom agents
│   └── scoring/        # impact and efficiency scoring + tests
├── apps/
│   ├── web/            # den, board, phone (PWA)
│   ├── api/            # Cloudflare Worker + Durable Objects
│   └── github-app/     # verification webhooks
└── assets/             # CC0 art and sounds, with licences
```

Monorepo with **pnpm workspaces** + **Turborepo**, TypeScript everywhere, Zod for the event contract, Vitest, Playwright for the web app, ESLint + Prettier, tsup for bundles, Changesets for versioning, GitHub Actions for CI and releases. Work lands on `dev`; `main` moves only through reviewed PRs with green CI.

Decisions worth recording as ADRs when they are made: SSE locally and WebSocket in the cloud; approval details stay local; pairing over embedded tokens; no process control.

---

## 20. Risks & open questions

**To verify against real sessions before building on them**

- Whether a held `PermissionRequest` hook leaves the terminal prompt usable, in Claude Code and in Codex (§9.3).
- Codex hook payload field names and the trust step, on the current release.
- Whether notification action buttons work for iOS web apps.
- What the Claude Code status line wrapper can carry without slowing the status line.
- That Claude Code HTTP hooks are faster than spawning the bundle, by measurement.

**Risks**

- **Platform risk.** Harnesses ship their own agent views and phone clients. Claude Code already has both for its own sessions. The answer is the cross-harness view, the health signals none of them compute, and the den.
- **Hook surfaces change.** Every adapter pins the versions it was tested on, `doctor` warns on a newer one, and unknown fields are ignored instead of failing.
- **Remote approval is the highest-risk feature.** It ships behind a flag, after its own review, with the never-allow-by-default rule as a tested invariant.
- **Hook latency.** A Node process per event adds delay to every tool call. Budget: under 50 ms at the median; measure in CI; move to HTTP hooks or a tiny native shim if it is exceeded.
- **Alert fatigue.** Defaults are conservative, and time-to-answer is tracked so a rising number shows up before people mute everything.
- **Health false positives.** A fox marked "stuck" while working normally erodes trust in every signal. Each rule ships with fixtures from real sessions and a per-rule off switch.
- **Ladder gaming and surveillance optics.** Covered in §13; the ladder is last and conditional.
- **Impact measurement.** Merged PRs miss research and ops work; later signals (deploys, closed tickets) need integrations.
- **Free-tier limits.** One Durable Object per repo; hibernation and summary feeds keep it small. Watch quotas.
- **Many dens.** 35 on the grid, the rest in the Commons. Pinning and folding stale corners are designed (§8.5) but untested at that scale; the board is the fallback view for large setups.
- **Asset licensing.** CC0 only; licences tracked in `assets/`.

**Open questions**

- Should the hold time for remote approvals adapt to whether a remote device is connected?
- Is a per-account stream enough for large teams, or does the floor need paging?
- Do Codex sessions started from its desktop app or IDE extension run user-level hooks?

---

## 21. Next steps

1. Close Phase 1: check the scratch and folder-named dens in a browser, finish and measure the performance pass, publish the plugin.
2. Try task hand-off against a real Claude Code session.
3. Spike the Codex hooks adapter against a real Codex session and record the actual payloads as fixtures. This settles most of the _(verify)_ marks in §7.2.
4. Write schema v2 from those two sets of fixtures.
5. Wire the health signals into the snapshot, then build the board on top of it.
6. Put up the landing page and waitlist in parallel; it needs only the demo.
