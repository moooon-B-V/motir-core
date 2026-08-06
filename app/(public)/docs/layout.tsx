import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { projectTagsService } from '@/lib/services/projectTagsService';
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
// ⚠️ The footer's topic links are an SEO crawl surface fed by a DB read. A
// documentation page must not 500 because that read failed, so it degrades to
// an empty topic column — the footer's other three columns, and the whole page,
// are unaffected.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('apiDocs');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  };
}

export default async function ApiDocsLayout({ children }: { children: ReactNode }) {
  let topics: Array<{ slug: string; label: string }> = [];
  try {
    const categories = await projectTagsService.listCategories();
    topics = categories.slice(0, 6).map((category) => ({
      slug: category.slug,
      label: category.label,
    }));
  } catch {
    // See the note above: the topic column is a nice-to-have crawl surface, and
    // the documentation is not.
    topics = [];
  }

  return (
    <div className="flex min-h-screen flex-col bg-(--el-page-bg)">
      <ExploreTopBar current="docs" />
      <div className="flex flex-1 flex-col lg:flex-row">{children}</div>
      <ExploreFooter topics={topics} />
    </div>
  );
}
