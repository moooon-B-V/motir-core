import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-5752's `motir-core` COVERAGE FLOOR (write a page; MOTIR-7281), and
// STORY MOTIR-5753's (the `/pages` tree; MOTIR-7377), which extends the same lane
// rather than adding a second job: the tree's app files join `STORY_FILES` and its
// gate (`tests/integration/pagesTreeStoryGate.test.ts`) joins `include`. The tree
// story's other app files are gated where they already were — the folder surface
// it moved to `components/folders/` and `folderRepository` / `foldersService` /
// `folderMappers` by the main lane (`vitest.config.ts`), the rest by the entries
// below — and `packages/pages/src/move.ts` by the package's own floor.
//
// ⚠️ WHAT A FLOOR IS FOR HERE, AND WHAT IT IS NOT. It does not decide whether the
// assembled pages layer is correct — `tests/integration/pagesStoryGate.test.ts`
// holds what a percentage cannot see (an editor-shaped update through the save
// door and back out of `getPage`, two stale saves in parallel both surviving,
// the derived formats agreeing with the stored state after every save, a page
// image outliving the orphan sweep, create → rename → list, the tenant and
// project ceilings, and every page door per built-in role). What a floor catches
// is what those cannot: a LATER change that deletes a branch's only test and
// leaves the branch.
//
// ⚠️ PER-FILE, NEVER GLOBAL, and over the files this story CREATED. The package
// half of the story (`packages/pages/src/**`) carries its own per-file floor in
// `packages/pages/vitest.config.ts`, run by the `pages` job.
//
// ⚠️ THE TWO SHARED FILES THE STORY CHANGED ARE REPORTED, NOT GATED.
// `attachmentsService.ts` and `attachmentRepository.ts` belong to the attachments
// surface (Subtask 2.3.7 onward), and this lane runs only the suites that reach
// the PAGE path, so a whole-file floor would measure other stories' lines — the
// hosted-agent-run and review-agent lanes' reason for the same choice. The
// story's own lines in them — the page arm of `getContentRedirect`,
// `uploadPageImage`, `linkToPage` and the orphan predicate's `pageId: null` — are
// covered by this lane's suites (measured on this branch, 2026-10-02): every line
// and every branch arm of them but ONE, `if (!page) throw` in the page arm of
// `getContentRedirect`. That arm is defensive: `attachment.page_id` is
// `ON DELETE SET NULL`, so a row naming a page that does not exist cannot be
// read, only raced (a page deleted between the two reads of one transaction).
// The report's other uncovered ranges in both files fall outside the story's
// lines.
//
// ⚠️ IT RUNS THE SUITES THAT REACH THE SURFACE, NOT THE WHOLE TREE. Measured with:
//   pnpm coverage:pages
// It needs Postgres and the built `@motir/pages` (`pnpm --filter @motir/pages
// build`), which the app resolves from the package's `dist/`.
//
// ⚠️ ROUTE GROUPS AND DYNAMIC SEGMENTS ARE MATCHED WITH `**` / `*`, NEVER THE
// LITERAL `(authed)` or `[pageId]` (MOTIR-2449: both are glob syntax to the
// matcher the coverage provider uses, so a literal path matches no file and its
// threshold passes vacuously).
//
// ⚠️ IT DOES NOT OVERRIDE `resolve` — spread the base config and change only what
// this lane is about (the onboarding-routing lane's comment says why).
const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

const STORY_FILES = [
  'lib/services/pagesService.ts',
  'lib/repositories/pageRepository.ts',
  'lib/mappers/pageMappers.ts',
  'lib/pages/index.ts',
  'lib/pages/pageStoreAdapter.ts',
  'lib/pages/routeErrors.ts',
  // `/api/pages`, `/api/pages/[pageId]`, `…/updates`, `…/images`, `…/versions`,
  // and (MOTIR-5754) `…/versions/[number]` and `…/versions/[number]/restore`.
  'app/api/pages/route.ts',
  'app/api/pages/*/route.ts',
  'app/api/pages/*/*/route.ts',
  'app/api/pages/*/*/*/route.ts',
  'app/api/pages/*/*/*/*/route.ts',
  'lib/repositories/pageVersionRepository.ts',
  // The editor host.
  'components/pages/*.tsx',
  // Story MOTIR-5753 (the `/pages` tree; MOTIR-7377): the tree, its rows, menus,
  // Move to… picker, drag, the page route's sidebar and breadcrumb, and the two
  // hooks — the `*.tsx` glob above stops at `components/pages/`, one level up.
  'components/pages/tree/*.tsx',
  'components/pages/tree/*.ts',
  // Story MOTIR-5755 (archive; MOTIR-7423): the archive / restore / delete
  // client, its two hooks, the confirms and the archived banner.
  'components/pages/archive/*.tsx',
  'components/pages/archive/*.ts',
  // The tree routes' `parent` parser (`?parent=` and the JSON `parent`).
  'lib/pages/parentInput.ts',
  // Story MOTIR-5755 (archive; MOTIR-7420): the Archived pages list's cursor.
  'lib/pages/archivedRootsCursor.ts',
  // `app/(authed)/pages/**` — the index, New page and the page at its address.
  'app/**/pages/page.tsx',
  'app/**/pages/*/page.tsx',
  'app/**/pages/_components/*.tsx',
  'app/**/pages/*/_components/*.tsx',
] as const;

const SHARED_FILES = [
  'lib/services/attachmentsService.ts',
  'lib/repositories/attachmentRepository.ts',
] as const;

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gates — the assembly, on the real doors (MOTIR-5752 · MOTIR-5753).
      'tests/integration/pagesStoryGate.test.ts',
      'tests/integration/pagesTreeStoryGate.test.ts',
      'tests/integration/pageHistoryStoryGate.test.ts',
      // Story MOTIR-5755's (archive, restore and delete; MOTIR-7425).
      'tests/integration/pageArchiveStoryGate.test.ts',
      // The per-card server suites (MOTIR-7276 · 7277 · 7278 · 7279 · 7300).
      'tests/page-schema-rls.test.ts',
      'tests/pages/*.test.ts',
      'tests/pages/*.test.tsx',
      'tests/services/pagesService.*.test.ts',
      'tests/services/attachmentsService.pageImage.integration.test.ts',
      'tests/jobs/attachment-gc.test.ts',
      'tests/api/pages-routes.test.ts',
      'tests/api/pages-routes-refusals.test.ts',
      'tests/api/pages-routes-tree.test.ts',
      // A page's history (Story MOTIR-5754 · MOTIR-7385 · 7386).
      'tests/api/pages-history-routes.test.ts',
      // Archive, restore, delete and the Archived pages list (Story MOTIR-5755 · MOTIR-7422).
      'tests/api/pages-archive-routes.test.ts',
      // The client surfaces (MOTIR-7280 · 7300).
      'tests/components/new-page-button.test.tsx',
      'tests/components/page-view.test.tsx',
      'tests/components/page-view-edges.test.tsx',
      'tests/components/pages-index.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      all: true,
      include: [...STORY_FILES, ...SHARED_FILES],
      thresholds: {
        perFile: true,
        ...Object.fromEntries(STORY_FILES.map((file) => [file, FLOOR])),
      },
    },
  },
});
