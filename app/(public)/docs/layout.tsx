import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ExploreTopBar } from '@/app/(public)/explore/_components/ExploreTopBar';
import { ExploreFooter } from '@/app/(public)/explore/_components/ExploreFooter';

// The developer-documentation shell (Story 11.4 · Subtask 11.4.7 — MOTIR-2188 ·
// design `design/api-docs/` § "The shell").
//
// PUBLIC by construction. It sits in the `(public)` route group, calls no
// `getSession()` and gates on nothing: documentation a prospective integrator
// cannot read before signing up is not published documentation, and ADR
// Amendment 4 Q4 put the surface here for exactly that reason.
//
// ── The chrome is the SHIPPED marketing chrome, imported not copied ─────────
// `ExploreTopBar` / `ExploreFooter` are the bar and footer an unauthenticated
// visitor already sees (Story 6.13 · design `design/project-square/`). This
// layout REUSES them so the docs surface cannot drift from the rest of the
// public site, and changes nothing about them beyond the two affordances the
// design owns: the `Docs` nav item, which this story makes the first of the
// three future-page labels to RESOLVE, and the footer's "API docs" link.
//
// ── NO DATABASE READ, deliberately (MOTIR-2452) ────────────────────────────
// This layout used to call `projectTagsService.listCategories()` to fill the
// footer's six "Explore by topic" links. The read was already wrapped in a
// `try`/`catch` falling back to an empty list — its own author had declared it
// optional — and it was a live query on every documentation page render, plus
// an import of `lib/db.ts`, which constructs its `PrismaClient` at module scope.
//
// It is gone. The topic column now degrades to ONE link into `/explore` rather
// than to nothing: the square's own footer carries the live per-topic links, so
// every topic page stays two hops from any documentation page and the crawl
// surface is narrowed, not severed.
//
// ⚠️ WHAT THIS DID NOT DO, measured rather than assumed. The traced-function
// count is UNCHANGED at 342 of 350 (`scripts/measure-prisma-traces.mjs`, before
// and after). Removing this import removes a query, not the client: three
// causes put `@prisma/client` in this tree's closure and this was only one.
//
//   1. the ROOT layout's `@/lib/auth` + `appearancePreferenceService` — reaches
//      EVERY route in the product. MOTIR-2381 measured it and kept it: the
//      appearance is applied to `<html>` and to a pre-paint script, so the read
//      cannot move down. That decision governs this tree too.
//   2. this layout's topic read — removed here.
//   3. `lib/api/v1/ready/schema.ts` imports the generated Prisma ENUMS as
//      runtime values, so the OpenAPI registry drags the client into
//      `/docs/api`, `/docs/api/getting-started` and `/docs/api/stability`.
//      Filed as its own card; NOT fixed here.
//
// The 2×2 was run: with (1) and (2) both removed the build measures 328 of 350
// and four of the seven docs functions come clean — the three left are (3).
// So this change is necessary and not sufficient, and the tree comes clean only
// when all three are answered. MOTIR-2381's answer to (1) is "no", which means
// the honest reading is: documentation still ships a client, for a reason
// recorded one level up, and it no longer makes a database CALL to render.
//
// The regression guard is `tests/public-docs-db-imports.test.ts`.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('apiDocs');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  };
}

export default function ApiDocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-(--el-page-bg)">
      <ExploreTopBar current="docs" />
      <div className="flex flex-1 flex-col lg:flex-row">{children}</div>
      {/* No topics: see the note above — documentation makes no database read. */}
      <ExploreFooter topics={[]} />
    </div>
  );
}
