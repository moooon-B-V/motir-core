---
kind: task
type: research
---

Find out whether the search index can serve prefix matches without a rebuild.

## Approach

Read the index configuration, then run three prefix queries against a scratch index and record the timings.

## Scope BOUNDARY

Findings only. Nothing about the index is changed.

## Acceptance criteria

- A findings note states yes or no and the evidence for it.
- The three timings are listed with the command that produced each.

## Context refs

- `lib/search/indexConfig.ts` — the current configuration
- `docs/search.md` — where the note is linked
