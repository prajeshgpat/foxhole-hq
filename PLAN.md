# Foxhole HQ — Project Plan

> See your agents work, know when they need you, and watch them level up.

Foxhole HQ is a plugin + website that turns AI coding agents (Claude Code, Codex, and others) into animated foxes living in a 3D isometric den. Each fox shows what its agent is doing in real time, raises a paw when it needs you, earns XP for verified work, and competes on a global leaderboard that rewards **impact per token** — efficient agents rank highest.

---

## 1. Goals

| Goal | What success looks like |
|---|---|
| **Ambient awareness** | One glance tells you which agents are busy, stuck, done, or waiting on you. |
| **Never miss a "needs you"** | Permission requests surface instantly (den + phone push). |
| **Fun** | A game-like world people leave open all day and show their friends. |
| **Efficiency benchmark** | A fair, verified global ranking of impact vs. token cost. |
| **Trust** | Metadata only by default — never code, prompts, or file contents. |

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
 │  Worker API  ──▶  Den (Durable Object, 1/user) │
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
            Website (React + React Three Fiber)
            3D isometric den · HUD · stats · ladder
```

**Key principle:** the **den** is the persistent object, owned by the user's account. Sessions come and go inside it. The website connects to the den, never to a single session — so it stays live after any agent session ends.

---

## 4. Tech stack

### Capture (local)
- **Claude Code plugin** bundling hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `SubagentStop`, `Stop`, `SessionEnd`.
- **Codex adapter**: uses Codex's `notify` setting and/or tails its local session logs (verify current Codex docs for the best hook point).
- **Generic adapter**: small HTTP/SDK API so any agent framework can send events.
- Written in **TypeScript (Node/Bun)**, shipped as a single small CLI (`foxhole`) the hooks call.

### Backend
- **Cloudflare Workers** — API + auth endpoints.
- **Durable Objects** (SQLite-backed) — one den per user/team; holds live state, fans out WebSocket updates.
- **D1 or Supabase Postgres** — accounts, verified tasks, leaderboard.
- **GitHub App** — verifies PRs, merges, CI status, reverts.
- **Auth** — GitHub OAuth.
- **Push** — Web Push + ntfy.sh for phone alerts.

### Frontend
- **React + Vite + TypeScript**
- **React Three Fiber + drei** — 3D scene, orthographic isometric camera, map controls, HTML labels.
- **Zustand** — fox state store driven by WebSocket events.
- **Tailwind** — HUD, panels, dashboards.
- **Assets** — CC0 low-poly packs (Quaternius animated animals incl. fox; Kenney furniture/room kits), glTF with animation clips.
- **Pathfinding** — tile grid + A*.

### Hosting (free tier to start)
| Piece | Service |
|---|---|
| Website | Cloudflare Pages |
| API + dens | Cloudflare Workers + Durable Objects (free plan) |
| DB | D1 or Supabase free |
| Plugin distribution | This GitHub repo (plugin marketplace) |
| Waitlist | Tally form or a DB table |
| Domain | ~$10/yr (only real cost) |

---

## 5. Event model

All adapters normalize into one schema:

```jsonc
{
  "v": 1,
  "ts": "2026-10-21T19:04:11.512Z",
  "source": "claude-code",          // claude-code | codex | sdk | ...
  "machineId": "m_8f2…",
  "sessionId": "s_41a…",
  "parentSessionId": null,          // set for subagents ("cubs")
  "type": "tool.start",             // see table below
  "tool": "Edit",                   // Read | Edit | Write | Bash | WebSearch | Task | ...
  "target": "src/auth/session.ts",  // file name or short label only (configurable / hashable)
  "status": "ok",                   // ok | error | waiting
  "usage": { "inputTokens": 1200, "outputTokens": 340, "model": "…" },
  "repo": "github.com/owner/name"   // optional, used for verification
}
```

| Event type | Fox behavior |
|---|---|
| `session.start` | Fox wakes up / walks into the den |
| `prompt.submit` | Fox receives a scroll (new quest) |
| `tool.start` Read/Grep/Glob | Walks to bookshelf, reading animation |
| `tool.start` Edit/Write | Sits at desk, typing loop, monitor glows |
| `tool.start` Bash | Walks to server rack, rack blinks |
| `tool.start` WebSearch/WebFetch | Walks to window / telescope |
| `tool.start` Task (subagent) | A cub pops out of a burrow and runs off |
| `permission.request` | Stands, raises paw, bouncing "!", light beam, push alert |
| `tool.end` status=error | Small stumble + puff of smoke |
| `session.stop` | Confetti + floating XP, then curls up in bed |
| `session.end` | Fox sleeps; history stays |

**Privacy defaults:** only tool names, short targets, status, and token usage are sent. No code, prompts, diffs, or file contents — ever. A setting can hash or hide `target` entirely. A **local-only mode** runs the den on `localhost` with nothing leaving the machine.

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
- **Den link** — permanent, bookmarkable (`foxhole-hq.com/den/<handle>`).
- **Share link** — read-only, revocable; for a team TV or a phone without login.

### Persistence
- Den state lives in a Durable Object; history in SQLite/DB.
- When sessions end, foxes go to bed; the page stays connected and shows a quiet "night" state + daily recap.
- New sessions wake foxes without a page refresh.
- Claude Code and Codex agents on the same account share one den (Codex agents could be a different animal).

---

## 7. The 3D isometric world

### Rendering
- Three.js via React Three Fiber, **orthographic camera** at the classic isometric angle (rotate in 90° steps, zoom, pan).
- Soft directional light + shadows, warm lamps.
- Low-poly / voxel aesthetic, cozy den interior.

### Stations
Desk row · bookshelf · server rack · window/telescope · burrow (subagents) · beds · quest board (task list) · trophy shelf (achievements).

### Fox behavior
- Each fox runs a **state machine**: `idle → walking → working(tool) → waiting → celebrating → sleeping`.
- **Event queue per fox**: animations finish their walk before the next action, so rapid hook events never cause flicker.
- A* pathfinding over the tile grid.
- Floating HTML label above each fox: name, current task, status pill.

### Juice
- Day/night cycle tied to local time.
- Floating XP numbers, confetti on quest completion, achievement toasts.
- Click a fox → camera eases in, side panel shows its task, timeline, tokens.
- Unlockable decor as you level up (plants, rugs, lamps, bigger den, seasonal items).

### Performance (runs all day)
- Cap device pixel ratio, instanced props, pause render loop when the tab is hidden, low-power mode toggle.
- Lightweight 2D fallback view for low-end devices / mobile.

---

## 8. Gamification

### Personal progression (your den)
- **XP** for completed quests, files touched, tests passing.
- **Levels** unlock cosmetics.
- **Streaks** for consecutive active days.
- **Achievements**, e.g. *First Quest*, *100 Edits*, *Zero-Error Shift*, *Cub Wrangler* (5 subagents in one quest), *Night Owl*, *Lean Machine* (top-10% efficiency on a quest).

Personal XP counts every completed task — fun and motivating, but **not** used for global rank.

### Global ranking: impact over tokens
Ranking spans **all users worldwide** and rewards efficient agents.

#### Verified impact (via GitHub App — never self-reported)
| Signal | Role |
|---|---|
| PR merged | Base unit of impact |
| CI/tests green on merge | Multiplier |
| Survives 14 days (not reverted/rewritten) | Points confirmed after a delay |
| Linked issue closed | Bonus, weighted by labels (bug, feature) |
| Change size & repo size | Log-scaled difficulty factor |

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
2. **Den (main view)** — 3D world + HUD: level/XP bar, live indicator, "needs you" alert bar with approve/open actions.
3. **Fox detail panel** — current task, timeline, tokens, cost.
4. **Stats** — daily/weekly recap, time and tokens per quest, cost trends, wait-for-you time.
5. **Quests & achievements** — quest board, trophy shelf.
6. **World ladder** — season, league, rank, efficiency score, filters by model tier.
7. **Profile card** — shareable: verified PRs, avg cost per task, badges.
8. **Team den** (paid) — shared world, team leaderboard, manager insights.
9. **Settings** — machines, tokens, privacy (hide targets, local-only), notifications, share links.
10. **Mobile** — alerts-first view: who needs you, quick approve/open, compact den.

---

## 10. Monetization

| Tier | Price (draft) | Includes |
|---|---|---|
| **Free** | $0 | Local mode, one den, basic animations, 7-day history, world ladder |
| **Pro** | $5–8/mo | Hosted den from any device, phone push alerts, unlimited history, all achievements & cosmetics |
| **Team** | $10–15/user/mo | Shared den, team ladder, manager dashboard (cost/time per task), Slack alerts |
| **Enterprise** | Custom | Self-hosting, SSO, audit logs, data retention controls |

Extras: cosmetic packs/seasonal items, cost analytics reports, sponsored integrations.

**Positioning:** lead with fun for adoption; sell teams visibility and cost insights. Supporting many agent frameworks is the moat against platform-native status views.

---

## 11. Roadmap

### Phase 0 — Prove the data (week 1)
- [ ] Claude Code hooks log normalized events to a local file.
- [ ] Confirm token usage can be read per session.

### Phase 1 — Local MVP (weeks 2–4)
- [ ] `foxhole` CLI + plugin packaging.
- [ ] Local server + WebSocket, plain live event list.
- [ ] Iso room with one fox: walk, sit, type, raise paw, sleep.
- [ ] Multiple foxes, stations, subagent cubs.
- [ ] Personal XP, levels, achievements (local SQLite).
- [ ] Publish plugin from this repo.

### Phase 2 — Hosted (weeks 5–8)
- [ ] Landing page + waitlist (Cloudflare Pages).
- [ ] GitHub OAuth, one-time pairing flow, tokens.
- [ ] Durable Object dens, persistent history.
- [ ] Den/share links, Web Push alerts.
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
│   ├── web/            # React + R3F site (den, stats, ladder)
│   ├── api/            # Cloudflare Worker + Durable Objects
│   └── github-app/     # verification webhooks
└── assets/             # CC0 models, textures, sounds (with licenses)
```

Monorepo with **pnpm workspaces** (or Bun workspaces) + Turborepo.

---

## 13. Risks & open questions

- **Platform risk** — agent tools may ship their own status views → stay multi-framework and lean into the ladder/benchmark.
- **Impact measurement** — merged PRs miss non-PR work (research, ops); consider later signals (deploys, closed tickets) via integrations.
- **Token data access** — confirm reliable per-session usage for each agent tool.
- **Codex hook surface** — verify the best current integration point.
- **Free-tier limits** — monitor Cloudflare/Supabase quotas; batching keeps usage low.
- **Asset licensing** — use CC0 only; track licenses in `assets/`.
- **Trust** — publish the plugin source openly so users can verify exactly what is sent.

---

## 14. Next steps

1. Scaffold the monorepo.
2. Build Phase 0 hooks logger and verify the event + token data.
3. Prototype the iso room with one animated fox.
4. Put up the landing page + waitlist.
