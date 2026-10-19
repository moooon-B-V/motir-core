---
kind: task
type: code
---

Support keyboard navigation in the board columns.

## Scope BOUNDARY

The board only. The list view already supports it.

## Acceptance criteria

- Arrow keys move focus between cards.
  - Up and down stay inside a column.
  - Left and right jump to the same row in the next column.
- Enter opens the focused card.

## Context refs

- `components/board/Board.tsx` — the board
- `tests/e2e/board.spec.ts` — the existing board spec
