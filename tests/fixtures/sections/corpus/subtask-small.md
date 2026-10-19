---
kind: subtask
type: code
---

Rename the confusingly named helper that formats invoice totals.

## Scope BOUNDARY

The helper and its callers. Behaviour does not change.

## Acceptance criteria

- No file refers to the old helper name.
- The invoice tests pass unchanged.

## Context refs

- `lib/invoices/format.ts` — the helper
- `tests/invoices/format.test.ts` — its tests
