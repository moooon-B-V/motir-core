import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ExploreTopBar } from './_components/ExploreTopBar';
import { ExploreFooter } from './_components/ExploreFooter';

// The legal-document shell (Story 8.4 · Subtask MOTIR-1134).
//
// PUBLIC by construction, in the `(public)` route group, calling no
// `getSession()` and gating on nothing. That is not a convenience: GDPR Art. 13
// owes transparency AT COLLECTION, which is the sign-up form — so a Privacy
// Policy a person must first create an account to read would be owed at a moment
// they cannot reach it. The same reasoning puts the Terms here: there is no
// contract with someone who could not read it before agreeing.
//
// ── The chrome is the shipped public chrome, imported not copied ────────────
// `ExploreTopBar` / `ExploreFooter` are what an unauthenticated visitor already
// sees, and `app/(public)/docs/layout.tsx` established this exact composition.
// Reusing it means a legal page cannot drift from the rest of the public site.
//
// ── NO database read ───────────────────────────────────────────────────────
// `topics={[]}` for the same reason the docs shell passes it (MOTIR-2452): the
// footer's topic column degrades to one link into `/explore`, and these pages
// make no query. A legal page that 500s because the database is unreachable is
// a worse failure than a narrowed crawl surface — the copy is on disk and
// nothing about rendering it needs Postgres.
//
// ── ⚠️ NO `loading.tsx` ANYWHERE IN THIS TREE, deliberately ─────────────────
// `app/(public)/explore/(square)/` has one, which is what the card flagged.
// `motir-core/CLAUDE.md`'s boundary rule: a `loading.tsx` may not sit ABOVE a
// route that decides existence. `[slug]/page.tsx` calls `notFound()` for an
// unknown slug, so a loading boundary here would show a skeleton and then a
// 404-that-renders-as-a-page, and the route would stop 404ing correctly for a
// crawler. There is nothing to suspend on anyway: the copy is read from disk at
// build time.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  };
}

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-(--el-page-bg)">
      <ExploreTopBar current="legal" />
      <div className="flex flex-1 flex-col">{children}</div>
      <ExploreFooter topics={[]} />
    </div>
  );
}
