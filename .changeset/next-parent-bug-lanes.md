---
'@motir/cli': minor
---

`motir next --parent` runs the next runnable container (a story, task or bug whose children are all leaves) as a parent run — exactly as `motir run <KEY>` would — and `motir next --bug` takes the next ready bug, running a bug with ready subtasks whole (MOTIR-6837). `motir ready` now prints the leaves grouped under their containers, `motir ready --parent` lists the containers and `motir ready --bug` the bugs. `--parent` refuses `--print`, `--kinds` and `--bug`; an empty lane says so and exits 0.
