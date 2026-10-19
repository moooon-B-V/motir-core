---
kind: task
type: copy
---

Write the empty-state strings for the saved-views list.

## Strings

- `views.empty.title` (en) — You have no saved views yet
- `views.empty.body` (en) — Save a filter to find it again in one click
- `views.empty.cta` (en) — Save the current filter

## Scope BOUNDARY

The saved-views empty state only. Populated-list strings are untouched.

## Acceptance criteria

- All three strings exist in the English catalogue.
- No string exceeds the width of the empty-state card.

## Context refs

- `locales/en/views.json` — the catalogue to extend
- `components/views/SavedViewsEmpty.tsx` — where the strings render
