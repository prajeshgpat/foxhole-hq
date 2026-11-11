# @foxhole-hq/schema

## 0.1.0

### Minor Changes

- 132bd15: Phase 0: a Claude Code plugin that records metadata-only Foxhole events (tool names, short targets, status, token usage, repo and branch) to `~/.foxhole/events.jsonl`, validated against the shared event schema.
- d07b4b5: Link subagents to their parent session: `subagent.stop` events now use the subagent's `agent_id` as `sessionId`, set `parentSessionId` to the spawning session, and carry a short `agentType` label (e.g. "Explore").
- 952c755: Rename the `session.stop` event to `turn.end`: Claude Code's Stop hook fires at the end of every turn, not the session. Events already logged as `session.stop` are read back as `turn.end` via the new `upgradeEvent`.
