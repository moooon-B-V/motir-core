---
kind: task
type: code
---

Show the member count in the workspace header.

## Scope BOUNDARY

The header only.

## Acceptance criteria

- The header shows the number of members.

## Acceptance criteria

- The count updates when a member joins.

## Context refs

- `components/shell/WorkspaceHeader.tsx` — the header
- `lib/workspaces/members.ts` — where the count comes from
