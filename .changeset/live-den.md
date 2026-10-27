---
"@foxhole-hq/agent": minor
"@foxhole-hq/plugin-claude": minor
---

Add `foxhole serve`: a local-only server (127.0.0.1) that streams `~/.foxhole/events.jsonl` to the den page over Server-Sent Events. Opened with `?live`, the den shows one fox per real session, in its repo's room and branch's corner, acting out each event and thinking at its desk while a turn is open. Rooms open only while a repo has an active session and close after 5 minutes without activity; the floor is a basement dug into a lawn, and new foxes arrive through a grass hole and a wall hole.
