# Foxhole HQ — Project Plan

> See your agents work, know when they need you, and watch them level up.

Foxhole HQ is a plugin + website that turns AI coding agents (Claude Code, Codex, and others) into animated foxes living in isometric dens dug into one shared hillside: one den per repo, one corner per branch. Each fox shows what its agent is doing in real time, raises a paw when it needs you, earns XP for verified work, and competes on a global leaderboard that rewards **impact per token** — efficient agents rank highest.

---

## 1. Goals

| Goal                         | What success looks like                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| **Ambient awareness**        | One glance tells you which agents are busy, stuck, done, or waiting on you, across every repo. |
| **Never miss a "needs you"** | Permission requests surface instantly (den + phone push).                                      |
| **Fun**                      | A game-like world people leave open all day and show their friends.                            |
| **Efficiency benchmark**     | A fair, verified global ranking of impact vs. token cost.                                      |
| **Trust**                    | Metadata only by default — never code, prompts, or file contents.                              |

### Non-goals (for now)

- Controlling agents from the website beyond simple approve/deny hand-offs.
- Storing or analyzing source code.
- Replacing an agent's own UI or terminal.

---

## 2. Users & use cases

**Solo developer**

- Runs several agents in parallel; glances at the den on a second screen.
- Gets a phone alert when a fox raises its paw.
- Reviews an end-of-day recap: quests done, time, tokens, cost.

**Team**

- Shared den showing everyone's agents.
- Team leaderboard and cost-per-task insights for leads.
- Great for demos and onboarding people onto agent workflows.

**Global community**

- Opt-in world ladder ranked by verified impact over normalized token cost.
- Seasons, leagues, profile cards, shareable "most efficient quest" highlights.

---

## 3. Architecture overview

```
 ┌──────────────── User's machine ────────────────┐
 │  Claude Code ──hooks──┐                         │
 │  Codex ──notify/logs──┼──▶ foxhole agent (plugin/CLI)
 │  Other agents ──SDK───┘     • normalize events  │
 │                             • batch + debounce  │
 │                             • sign with token   │
 └────────────────────────────────┬───────────────┘
                                  │ HTTPS (batched)
                                  ▼
 ┌──────────────── Cloud (Cloudflare) ────────────┐
 │  Worker API  ──▶  Dens (1 Durable Object/repo) │
 │      │              • live state + WebSocket   │
 │      │              • session history (SQLite) │
 │      ▼                                         │
 │  Scoring service ◀── GitHub App (verification) │
 │      │                                         │
 │      ▼                                         │
 │  Leaderboard (D1 / Postgres)                   │
 └────────────────────────────────┬───────────────┘
                                  │ WebSocket
                                  ▼
            Website (canvas den page; React app shell later)
            isometric den · HUD · stats · ladder
```

**Key principle:** the **den** is the persistent object. Each repo gets its own den, owned by the user's account (or team). Sessions come and go inside it. The website connects to dens, never to a single session — so they stay live after any agent session ends.

An account's dens sit side by side on one **HQ floor**: a single explorable isometric hillside where every den is a department, so you can see every repo at work at a glance and move between them without switching views. Inside a den, each **branch** gets its own corner. The HQ floor is a thin aggregate that subscribes to a small summary feed from each den (awake/asleep counts, who needs you, current quest per branch), not to every event.

---

## 4. Tech stack

### Capture (local)

- **Claude Code plugin** bundling hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `SubagentStop`, `Stop`, `SessionEnd`.
- **Codex adapter**: uses Codex's `notify` setting and/or tails its local session logs (verify current Codex docs for the best hook point).
- **Generic adapter**: small HTTP/SDK API so any agent framework can send events.
- Written in **TypeScript (Node/Bun)**, shipped as a single small CLI (`foxhole`) the hooks call.

### Backend

- **Cloudflare Workers** — API + auth endpoints.
- **Durable Objects** (SQLite-backed) — one den per repo per user/team; holds live state, fans out WebSocket updates. One lightweight HQ object per account aggregates den summaries for the floor overview.
- **D1 or Supabase Postgres** — accounts, verified tasks, leaderboard.
- **GitHub App** — verifies PRs, merges, CI status, reverts.
- **Auth** — GitHub OAuth.
- **Push** — Web Push + ntfy.sh for phone alerts.

### Frontend

- **Canvas 2D renderer, no dependencies** — the prototype page, served by `foxhole serve`.
- **React + Vite + TypeScript** — the hosted app shell (HUD, stats, ladder), wrapping the canvas.
- **Zustand** — fox state store later.
- **Tailwind** — panels, dashboards.
- **Assets** — sprites drawn in code (pixel grids); no glTF yet.
- **Pathfinding** — breadth-first search over each den's tile grid.
- WebGL / React Three Fiber only if the criteria in §7 trigger.

### Hosting (free tier to start)

| Piece               | Service                                          |
| ------------------- | ------------------------------------------------ |
| Website             | Cloudflare Pages                                 |
| API + dens          | Cloudflare Workers + Durable Objects (free plan) |
| DB                  | D1 or Supabase free                              |
| Plugin distribution | This GitHub repo (plugin marketplace)            |
| Waitlist            | Tally form or a DB table                         |
| Domain              | ~$10/yr (only real cost)                         |

---

## 5. Event model

All adapters normalize into one schema:

```jsonc
{
  "v": 1,
  "id": "6f1c2b9e-…", // UUID, so retries and replays can be de-duplicated
  "ts": "2026-10-21T19:04:11.512Z",
  "source": "claude-code", // claude-code | codex | sdk | ...
  "machineId": "m_8f2…",
  "sessionId": "s_41a…",
  "parentSessionId": null, // set for subagents ("cubs")
  "type": "tool.start", // see table below
  "tool": "Edit", // Read | Edit | Write | Bash | WebSearch | Task | ...
  "target": "src/auth/session.ts", // file name or short label only (configurable / hashable)
  "status": "ok", // ok | error | waiting
  "usage": { "inputTokens": 1200, "outputTokens": 340, "model": "…" },
  "repo": "github.com/owner/name", // picks the den; also used for verification
  "branch": "feat/csp-headers", // picks the branch corner inside the den
}
```

**Den routing:** the local agent fills `repo` from the session's working directory (its git remote). Every session for the same repo, from any machine or agent tool, lands in that repo's den. The local agent also reads the current git branch, which picks the branch corner inside the den; a subagent inherits its parent's branch. A repo with no remote gets a den named after its folder (hashed if targets are hidden), and sessions outside any repo go to a shared **scratch den**.

| Event type                      | Fox behavior                                                               |
| ------------------------------- | -------------------------------------------------------------------------- |
| `session.start`                 | Fox wakes up / walks into the den                                          |
| `prompt.submit`                 | Fox receives a scroll (new quest)                                          |
| `tool.start` Read/Grep/Glob     | Walks to bookshelf, reading animation                                      |
| `tool.start` Edit/Write         | Sits at desk, typing loop, monitor glows                                   |
| `tool.start` Bash               | Walks to server rack, rack blinks                                          |
| `tool.start` WebSearch/WebFetch | Walks to window / telescope                                                |
| `tool.start` Task (subagent)    | A cub pops out of a burrow and runs off                                    |
| `permission.request`            | Stands, raises paw, bouncing "!", light beam, push alert                   |
| `session.waiting`               | Agent is idle waiting for your next message: fox sits and looks toward you |
| `tool.end` status=error         | Small stumble + puff of smoke                                              |
| `turn.end`                      | A turn finished: confetti + floating XP, then idles until the next prompt  |
| `session.end`                   | Fox sleeps; history stays                                                  |

**Privacy defaults:** only tool names, short targets, status, and token usage are sent. No code, prompts, diffs, or file contents — ever. A setting can hash or hide `target` entirely, and dens for private repos can show an alias instead of the repo name. A **local-only mode** runs the den on `localhost` with nothing leaving the machine.

**Volume control:** the local agent batches and debounces (e.g., flush once per second, collapse repeated Read events) to keep traffic tiny.

---

## 6. Connecting & staying connected

### One-time pairing (device flow)

1. Install plugin → run `/foxhole connect`.
2. Plugin prints a one-time link, e.g. `foxhole-hq.com/pair/K7F-29Q`.
3. User clicks, signs in with GitHub, confirms.
4. Plugin stores a long-lived token at `~/.foxhole/token`. The link expires immediately.
5. Every future session on that machine auto-connects. Nothing to redo.

### Links

- **Pairing link** — one-time, connects a machine, then expires.
- **HQ link** — permanent, bookmarkable view of your whole floor (`foxhole-hq.com/<handle>`).
- **Den link** — permanent, bookmarkable, one per repo (`foxhole-hq.com/<handle>/<repo>`).
- **Share link** — read-only, revocable; for one den or the whole HQ floor, e.g. a team TV or a phone without login.

### Persistence

- Each den's state lives in its own Durable Object; history in SQLite/DB.
- When sessions end, foxes go to bed; the page stays connected and shows a quiet "night" state + daily recap.
- New sessions wake foxes without a page refresh. A session in a repo you haven't used before creates its den automatically, and it appears on the HQ floor. A session on a new branch gets a new branch corner in that den.
- Claude Code and Codex agents working on the same repo share that repo's den (Codex agents could be a different animal).

---

## 7. The isometric world

### Rendering

- **Plain Canvas 2D, no WebGL and no dependencies.** The den is one page (`apps/web/prototype/index.html`) that loads instantly and runs all day on a laptop.
- **Fixed 2:1 isometric projection** (tiles 64×32 px, heights in px). The camera has one viewing angle and does not rotate: the hillside, back walls and holes are drawn for that angle.
- **Painter's order:** lawn → rooms back to front → glass fronts → outdoor scenery → fox labels → particles → floating signs.
- **Look:** flat-shaded polygons with a few tones per surface, pixel-art foxes drawn from character grids, a night palette, warm lantern glows (additive blending), no real-time shadows.
- **Decision: keep the canvas renderer for now.** Revisit WebGL (e.g. React Three Fiber) only if the performance work below cannot hold 60 fps with ~20 open dens on a mid-range laptop, free camera rotation becomes a must, or we move to 3D assets. The world model (grid, rooms, foxes, events) is renderer-independent, so a later port keeps it.

### The HQ floor and dens

- **A hillside.** The lawn slopes gently down toward the viewer; every room is dug into it.
- **The Commons and a pyramid of dens.** Rooms tile one rectangle of 13×11-tile cells. The Commons takes the back corner; each repo's den takes the next cell in a fixed order (1, 3, 2, 4, 7, 5, 6, 8, then the pattern repeats) that grows the grid a row, then a column, alternating: 1×1, 2×1, 2×2, 3×2, 3×3, 4×3, … up to 6×6 (35 dens). Foxes from later repos wait in the Commons.
- **Always a full rectangle.** A cell no den has taken yet is absorbed by the room to its left, which simply runs wider. When that den opens it takes its cell back.
- **Floors step down.** Each ring of cells (same distance from the back corner) sits one step lower than the ring behind it, so the Commons is the top of the pyramid.
- **Walls and edges.**
  - Only the back sides of the grid (top and left) have earth retaining walls that follow the grass, dressed with stones, roots and timber posts.
  - Between rooms there is a retaining face down to a lower neighbour, or a low divider with a two-tile gap beside a neighbour on the same level.
  - Open front edges show the floor slab and a faint (10% opaque) glass wall, so you can see the den is underground.
- **Ways in.** A top-row den has a hole in its back wall under a hole in the grass; a left-column den uses its left wall; an inner den has a hatch in its floor, linked by a tunnel to a grass hole on the lawn behind the grid. Foxes climb down shafts and vanish into holes.
- **Opening and closing.** A den is dug open (the pit mouth widens, the hole deepens, dust and clods fly on landing) when one of its foxes wakes, unless its cell is already floor, in which case it just takes the cell over. It fills back in after 5 minutes with every fox asleep. Rooms close only last-in-first-out, so the grid stays a rectangle.
- **Moving around.** Drag to pan (edges rubber-band), scroll or pinch to zoom, arrow keys and +/− when focused. Clicking a den's sign, its floor or a fox flies the camera there. The **[ ] fit button** (or `0`) centres every den and zooms one step closer than a tight fit, and keeps them framed as rooms open and close until you move the camera; one zoom-out step shows every den whole.
- **Signs and corners.** Each den has a floating sign (repo name or alias, status, gold when a fox needs you). Each branch gets a rug corner (up to four per den) in its own colour with a floor tag (`⎇ feat/csp-headers`) that steps aside to avoid overlaps, and desks for the agents on that branch.
- **The Commons.** A lounge with a bar and stools, arcade cabinets, a TV with a console, a pong table, a couch and a reading nook. Resident foxes live there. A session that goes quiet sends its fox up its den's hole, across the lawn and down into the Commons; it walks back when the session wakes.
- **Outdoors.** A river with a bridge down the left of the grid, trees, bushes, flowers, rocks and wildlife.

### Stations

- **Per den:** bookshelf (Read/Grep/Glob) · server rack (Bash) · window, with a telescope on back-wall dens (web search and fetch) · burrow at the hole (Task: subagent cubs pop out) · beds · quest board · plant.
- **Per branch corner:** that branch's desks, with glowing monitors while a fox types.
- **In the Commons:** hangout spots. Still to come: trophy cabinet (achievements) and a status board for every den.

### Fox behavior

- **States:** idle, walking, working (at the tool's station), waiting (paw up, light beam), celebrating, stumbling (error, puff of smoke), sleeping (drifting z's), plus climbing and diving for the holes.
- **Movement:** foxes walk tile paths (breadth-first search over each den's grid, stations blocked) and routes across the lawn for trips to the Commons.
- **Live mode:** one fox per Claude Code session, fed by Server-Sent Events from `foxhole serve`; subagents are cubs; on load the backlog is replayed so everyone is already in place.
- **Demo mode:** scripted quests per den.
- **Labels:** drawn on the canvas above each fox (name, current target, status pill), stacked so they don't overlap, shown when zoomed in.

### Juice

- Rooms dug open with dust and flying clods; confetti and floating +XP on a finished quest; tap a fox and it hops and spins, and the side panel shows its task, timeline, tokens and cost; toasts for level-ups and arrivals.
- Later: day/night tied to local time, achievement toasts, unlockable decor (plants, rugs, lamps, seasonal items), and a den panel with tasks and pull requests (see §11, Phase 1.5).

### Performance (runs all day)

- **Done:** device pixel ratio capped at 2; grass, flowers, rocks, trees and wildlife drawn only for tiles on screen; grass tufts, flowers and floor tiles batched into single fills; room neighbours looked up once per frame; label stacking capped per frame; side panel refreshed four times a second; drawing drops to ~30 fps when the view is still; the browser pauses drawing in hidden tabs.
- **Next:** reuse gradients (lantern, desk glow), skip rooms that are off screen, measure sign text once.
- **Later:** a low-power toggle (1× pixel ratio, 20 fps, no small scenery), a light list view for phones, offscreen bitmaps for the lawn and floors only if the above is not enough.

---

## 8. Gamification

### Personal progression (your den)

- **XP** for completed quests, files touched, tests passing.
- **Levels** unlock cosmetics.
- **Streaks** for consecutive active days.
- **Achievements**, e.g. _First Quest_, _100 Edits_, _Zero-Error Shift_, _Cub Wrangler_ (5 subagents in one quest), _Night Owl_, _Lean Machine_ (top-10% efficiency on a quest).

Personal XP counts every completed task — fun and motivating, but **not** used for global rank.

### Global ranking: impact over tokens

Ranking spans **all users worldwide** and rewards efficient agents.

#### Verified impact (via GitHub App — never self-reported)

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
task_score   = impact_points / normalized_token_cost
impact_points = base × ci_mult × survival_mult × issue_bonus × log(1 + difficulty)
```

**Safeguards**

- **Normalize tokens** to a cost-equivalent per model, and/or rank within **model-tier leagues**.
- **Log-scale impact** + minimum impact threshold, so trivial one-liners can't dominate.
- **Bayesian smoothing**: player rating shrinks toward the global mean until ~20+ verified tasks.
- **Seasons**: monthly ladders with resets.

#### Leagues

Kit → Red Fox → Silver Fox → Arctic Fox → Nine-Tailed Kitsune.

#### Anti-gaming

- Events signed with the pairing token; token usage read from local session data.
- Cross-check token totals against verified outcome size (huge PR + tiny usage = flag).
- Detect farm repos, self-merged PRs in solo repos, sudden efficiency spikes → reduced weight or excluded.
- Public repos only for the world ladder by default.

#### Privacy

- Global ranking is **opt-in**, pseudonymous (fox names).
- Private repos can count toward a **private team board** only.

---

## 9. Website screens

1. **Landing page** — hero animation of the den, waitlist, "how it works", privacy promise.
2. **HQ floor (home)** — the Commons and a pyramid of dens on one explorable hillside, a department list in the side panel, a [ ] button that fits every den on screen, and "needs you" alerts with approve/go-there actions. Clicking a den opens its den panel (tasks and open PRs, see §11).
3. **Den (per repo)** — the den up close + HUD; its side panel lists the repo's tasks (`TASKS.md`) and open pull requests, and a task can be dragged onto a fox: level/XP bar, live indicator, "needs you" alert bar with approve/open actions.
4. **Fox detail panel** — current task, timeline, tokens, cost.
5. **Stats** — daily/weekly recap, time and tokens per quest, cost trends, wait-for-you time; filter by repo or see all.
6. **Quests & achievements** — quest board, trophy shelf.
7. **World ladder** — season, league, rank, efficiency score, filters by model tier.
8. **Profile card** — shareable: verified PRs, avg cost per task, badges.
9. **Team HQ** (paid) — one shared floor with dens for the team's repos, team leaderboard, manager insights.
10. **Settings** — machines, tokens, privacy (hide targets, repo aliases, local-only), notifications, share links.
11. **Mobile** — alerts-first view: who needs you across all dens, quick approve/open, compact HQ floor.

---

## 10. Monetization

| Tier           | Price (draft)  | Includes                                                                                       |
| -------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| **Free**       | $0             | Local mode, one den, basic animations, 7-day history, world ladder                             |
| **Pro**        | $5–8/mo        | Hosted den from any device, phone push alerts, unlimited history, all achievements & cosmetics |
| **Team**       | $10–15/user/mo | Shared den, team ladder, manager dashboard (cost/time per task), Slack alerts                  |
| **Enterprise** | Custom         | Self-hosting, SSO, audit logs, data retention controls                                         |

Extras: cosmetic packs/seasonal items, cost analytics reports, sponsored integrations.

**Positioning:** lead with fun for adoption; sell teams visibility and cost insights. Supporting many agent frameworks is the moat against platform-native status views.

---

## 11. Roadmap

### Phase 0 — Prove the data (week 1)

- [x] Claude Code hooks log normalized events to a local file (`packages/plugin-claude`, verified in a real session).
- [x] Confirm token usage can be read per session (incremental transcript reader in `packages/agent`).
- [x] Run on a few real working sessions; confirm Notification (permission) and SubagentStop payloads (`permission_prompt` notifications map to `permission.request`; subagent stops are filed under the subagent's id, linked to the parent session).

### Phase 1 — Local MVP (weeks 2–4)

- [ ] `foxhole` CLI + plugin packaging.
- [ ] Local server + WebSocket, plain live event list.
- [ ] Iso room with one fox: walk, sit, type, raise paw, sleep.
- [ ] Multiple foxes, branch corners (one desk per agent), stations, subagent cubs.
- [x] Route sessions to a den per repo and a corner per branch; one local HQ floor with all dens (canvas prototype: pyramid grid, [ ] fit button, glass fronts).
- [ ] Performance pass (batching, per-frame geometry, frame cap).
- [ ] Personal XP, levels, achievements (local SQLite).
- [ ] Publish plugin from this repo.

### Phase 1.5 — Den panel (manage from the dashboard)

Clicking a den opens a side panel with the repo's tasks and open pull requests; a task can be dragged onto a fox. Local only, user-initiated, nothing runs without an explicit drop and confirm.

- [ ] Server hardening before any write route: per-run token, Origin check, JSON-only writes, body cap.
- [ ] The hook records each repo's local path on `SessionStart` (local file only, never in the event stream).
- [ ] `GET /api/prs` via the `gh` CLI (cached, no secrets in the repo); `GET /api/tasks` from `TASKS.md` (`- [ ]` items grouped by `## Ready / Doing / Done`, optional `<!-- id:… -->`, `#labels`, `~S/M/L`).
- [ ] Read-only den panel: Tasks and Pull requests tabs; clicking a PR jumps to its branch corner.
- [ ] Assign a task: inbox file per session, delivered by the `Stop` hook (`decision: block` with the task text, guarded by `stop_hook_active`) or the next `UserPromptSubmit`; an "Assign to…" button first, for keyboard users.
- [ ] Drag a task card onto a fox (pointer events, valid-target rings, confirm popover, scroll and confetti on drop).
- [ ] Later: a Foxhole MCP server in the plugin (`foxhole_next_task`), GitHub issues and Linear as task sources, hosted assignment via the GitHub App.

Task text and PR titles are untrusted input: capped, framed as a user request, never assigned automatically, and never written to `events.jsonl`.

### Phase 2 — Hosted (weeks 5–8)

- [ ] Landing page + waitlist (Cloudflare Pages).
- [ ] GitHub OAuth, one-time pairing flow, tokens.
- [ ] Durable Object dens (one per repo) + HQ aggregate, persistent history.
- [ ] HQ/den/share links, Web Push alerts.
- [ ] Codex adapter.

### Phase 3 — Global ladder (weeks 9–12)

- [ ] GitHub App verification (merge, CI, survival, issues).
- [ ] Scoring service, normalization, smoothing.
- [ ] Seasons, leagues, profile cards.
- [ ] Anti-gaming checks.

### Phase 4 — Teams & monetization

- [ ] Team dens, team ladder, manager insights.
- [ ] Billing (Stripe), Pro/Team tiers.
- [ ] Cosmetic shop, seasonal events.
- [ ] Generic SDK adapter for other agent frameworks.

---

## 12. Proposed repo structure

```
foxhole-hq/
├── PLAN.md
├── README.md
├── packages/
│   ├── agent/          # foxhole CLI: normalize, batch, sign, send
│   ├── plugin-claude/  # Claude Code plugin (hooks config + commands)
│   ├── adapter-codex/  # Codex notify/log watcher
│   ├── schema/         # shared event + scoring types (TS)
│   └── scoring/        # impact & efficiency scoring logic + tests
├── apps/
│   ├── web/            # den page (canvas prototype now; React app shell later)
│   ├── api/            # Cloudflare Worker + Durable Objects
│   └── github-app/     # verification webhooks
└── assets/             # CC0 models, textures, sounds (with licenses)
```

Monorepo with **pnpm workspaces** + **Turborepo**, TypeScript everywhere, Zod for the event contract, Vitest, ESLint + Prettier, tsup for bundles, Changesets for versioning, GitHub Actions for CI and releases. Work lands on `dev`; `main` only moves through reviewed PRs with green CI, and every push to `main` runs the release workflow.

---

## 13. Risks & open questions

- **Platform risk** — agent tools may ship their own status views → stay multi-framework and lean into the ladder/benchmark.
- **Impact measurement** — merged PRs miss non-PR work (research, ops); consider later signals (deploys, closed tickets) via integrations.
- **Token data access** — confirm reliable per-session usage for each agent tool.
- **Codex hook surface** — verify the best current integration point.
- **Free-tier limits** — monitor Cloudflare/Supabase quotas; batching keeps usage low. One den per repo means more Durable Objects; idle dens hibernate, and the HQ floor reads summaries rather than full event streams.
- **Many dens** — the grid grows a row then a column up to 6×6 (35 dens); later repos wait in the Commons, and idle dens close after 5 minutes, last in first out. Still open: pinning favourites near the Commons, and folding away stale branch corners.
- **Asset licensing** — use CC0 only; track licenses in `assets/`.
- **Trust** — publish the plugin source openly so users can verify exactly what is sent.

---

## 14. Next steps

1. Finish the performance pass (§7).
2. Read-only den panel: tasks from `TASKS.md` and open PRs via `gh` (§11, Phase 1.5).
3. Task hand-off to a running session via the Stop hook.
4. Put up the landing page + waitlist.
