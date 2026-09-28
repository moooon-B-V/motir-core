---
'@motir/cli': minor
---

The CLI reads the ready LANES (MOTIR-6835) instead of the flat ready set: `motir next` takes the next leaf and never picks a bug, `motir auto` drains every leaf before it takes the first bug, `motir batch` and a scoped run (`motir run <story>`) read leaves and bugs together so a story's edged bug is still claimed, and `motir ready` shows each row's runnable container. Needs a server serving `/api/v1` contract 1.54.0 or later; an older one is reported as version skew.
