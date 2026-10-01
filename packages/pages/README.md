# `@motir/pages`

The **pages module**: a project's documents. Created by MOTIR-5757 under
[`docs/decisions/app-shell-over-packages.md`](../../docs/decisions/app-shell-over-packages.md);
the page model is decided in [`docs/decisions/pages.md`](../../docs/decisions/pages.md).

Private to this repository. One consumer: the app.

## What it owns

Per the record's §2, the package owns what is true of a page whatever stores it:

- **The page model types** — `PagePlacement`, `PageTreeNode`, `PageSummary`,
  `PageLevelCursor`, `PagePermissionKey`.
- **The pure tree rules** (§4) — `parsePlacement` (a page's parent is a page, a folder or the
  root, never a work item), `assertNoCycle`, `assertWithinDepth` (10 levels of pages),
  `planPlacement`, which runs all of them and returns the new `ancestor_page_ids`, and
  `rebaseAncestorIds` for a moved subtree.
- **Order within a level** — fractional `position` keys (`positionBetween`,
  `positionsBetween`), the `(position, id)` order and its keyset predicate, and the level page
  size (50 by default, 100 at most).
- **The record's constants** — every number §3–§6 fixes.
- **The typed refusals** — `PageParentNotAllowedError`, `PageCycleError`,
  `PageDepthExceededError`, each carrying its stable `code` and a 422 `status`.

Later stories add the document conversions, the editor schema and editor, link extraction, the
version policy and the save procedure, as §2 lists.

## What the APP binds

Nothing yet. The app does not import the package until the schema story adds its composition
root, `lib/pages/index.ts`, which binds the `PageStore` port to the app's repositories under the
service's transaction (§2). The schema, RLS, repositories, routes and permission gates stay in
the app.

## What it may NOT depend on

No `@/…` import, no Prisma client, no `@motir/*` sibling's internals. The package's
`tsconfig.json` has no `paths`, so an `@/` import fails its type-check, and
`tests/packages/importDirection.test.ts` asserts the same from outside.

## Commands

```sh
pnpm --filter @motir/pages typecheck
pnpm --filter @motir/pages build
pnpm --filter @motir/pages test -- --coverage
```
