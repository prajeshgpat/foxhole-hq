# @foxhole-hq/plugin-claude

## 0.1.0

### Minor Changes

- 83afcd1: Add `foxhole serve`: a local-only server (127.0.0.1) that streams `~/.foxhole/events.jsonl` to the den page over Server-Sent Events. Opened with `?live`, the den shows one fox per real session, in its repo's room and branch's corner, acting out each event and thinking at its desk while a turn is open. Rooms open only while a repo has an active session and close after 5 minutes without activity; the floor is a basement dug into a lawn, and new foxes arrive through a grass hole and a wall hole.
- 132bd15: Phase 0: a Claude Code plugin that records metadata-only Foxhole events (tool names, short targets, status, token usage, repo and branch) to `~/.foxhole/events.jsonl`, validated against the shared event schema.
- d07b4b5: Link subagents to their parent session: `subagent.stop` events now use the subagent's `agent_id` as `sessionId`, set `parentSessionId` to the spawning session, and carry a short `agentType` label (e.g. "Explore").
- 952c755: Rename the `session.stop` event to `turn.end`: Claude Code's Stop hook fires at the end of every turn, not the session. Events already logged as `session.stop` are read back as `turn.end` via the new `upgradeEvent`.

### Patch Changes

- Updated dependencies [83afcd1]
- Updated dependencies [132bd15]
- Updated dependencies [d07b4b5]
- Updated dependencies [952c755]
  - @foxhole-hq/agent@0.1.0
