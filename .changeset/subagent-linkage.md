---
"@foxhole-hq/schema": minor
"@foxhole-hq/agent": minor
"@foxhole-hq/plugin-claude": minor
---

Link subagents to their parent session: `subagent.stop` events now use the subagent's `agent_id` as `sessionId`, set `parentSessionId` to the spawning session, and carry a short `agentType` label (e.g. "Explore").
