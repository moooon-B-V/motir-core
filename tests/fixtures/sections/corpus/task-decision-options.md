---
kind: task
type: decision
---

Decide how exports of more than ten thousand rows are delivered.

## Question

Should a large export download directly or arrive by email as a link?

## Options

- **Direct download** — cost: a long-held connection · forecloses: exports over a few minutes
- **Emailed link** — cost: a mail template and a storage bucket · forecloses: nothing

## Recommendation

Emailed link, because it removes the timeout ceiling.

## Scope BOUNDARY

The choice only. Building either path is a later card.

## Acceptance criteria

- The recommendation and its reason are recorded on this card.
- The losing option's cost is named.

## Context refs

- `lib/export/limits.ts` — where the ceiling is enforced
- `docs/export.md` — the current behaviour
