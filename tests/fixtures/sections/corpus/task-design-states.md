---
kind: task
type: design
---

Draw the empty, loading and error states of the notification drawer.

## States

- empty drawer with a quiet prompt
- loading skeleton for three rows
- error banner with a retry control

## Approach

Start from the shipped drawer and change only what the three states need.

## Scope BOUNDARY

The drawer only. The bell icon and its badge are not redrawn here.

## Acceptance criteria

- Each of the three states is drawn at desktop and phone width.
- The error state names the retry control and its copy.

## Context refs

- `design/shell/design-notes.md` — the area notes to extend
- `components/shell/NotificationDrawer.tsx` — the shipped drawer
