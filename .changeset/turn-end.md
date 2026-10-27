---
"@foxhole-hq/schema": minor
"@foxhole-hq/agent": minor
"@foxhole-hq/plugin-claude": minor
---

Rename the `session.stop` event to `turn.end`: Claude Code's Stop hook fires at the end of every turn, not the session. Events already logged as `session.stop` are read back as `turn.end` via the new `upgradeEvent`.
