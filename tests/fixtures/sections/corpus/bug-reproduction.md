---
kind: bug
type: code
---

Saving a view with an emoji in its name shows a blank list afterwards.

## Reproduction

Open the saved views menu, save a view named with a party emoji, then reopen the menu. The list renders empty until the page is reloaded.

## Approach

Check how the name is stored and how the list key is derived from it.

## Scope BOUNDARY

The saved-views list only. Name validation elsewhere is unchanged.

## Acceptance criteria

- A view with an emoji in its name appears in the list immediately.
- A regression test saves such a view and reads it back.

## Context refs

- `lib/views/savedViews.ts` — where the key is built
- `components/views/SavedViewsMenu.tsx` — the list that goes blank
