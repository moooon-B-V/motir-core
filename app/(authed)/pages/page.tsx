import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { memberPageContext, pageScope } from '@/lib/pages/projectPageContext';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { NewPageButton } from './_components/NewPageButton';
import { PagesIndex } from './_components/PagesIndex';
import { PagesIndexFrame } from './_components/PagesIndexFrame';

// THE PAGES INDEX, `/pages` (Story MOTIR-5752 · MOTIR-7300) — the project's
// pages, newest edit first, drawn by `design/pages/pages.mock.html` states 2–5.
// Mirrors `/my-agents`: the gate, then the header, then an in-page <Suspense>.
//
// ── THE GATE FIRST ─────────────────────────────────────────────────────────
// `memberPageContext()` resolves the reader and their ACTIVE project; a reader
// without `page:view` — the key every `pagesService` read asserts — gets the
// page's `notFound()`, exactly as `/pages/<id>` refuses them, and the list is
// never read. The rail and ⌘K drop the entry for that reader through the same
// key (`projectNavAccess.ts`), so nothing offers a door that answers 404.
//
// ── THEN THE FRAME, AN IN-PAGE <Suspense> — NEVER A `loading.tsx` ──────────
// Both page routes call `notFound()`, so a route-level boundary would flush a
// 200 before either decided (`CLAUDE.md` § A `loading.tsx` may NOT sit above a
// route that decides existence). The header is REAL and paints above the
// boundary — its strings are static and New page's key is already resolved —
// so the frame (§ State 5) is the list's shape alone: five row-shaped blocks in
// the same Card frame, so the list settles with no vertical shift.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pages.index');
  return { title: t('title') };
}

export default async function PagesIndexPage() {
  const ctx = await memberPageContext();
  const [held, t] = await Promise.all([ctx.permissions(), getTranslations('pages.index')]);
  if (!held.has('page:view')) notFound();
  const scope = pageScope(ctx);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('title')}</h1>
          <p className="mt-1 text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
        </div>
        {/* Rendered only for `page:edit` — the button reads `useProjectAccess()`. */}
        <NewPageButton />
      </header>
      <Suspense fallback={<PagesIndexFrame />}>
        <PagesIndexData
          service={scope.service}
          projectId={scope.projectId}
          viewerId={scope.userId}
          canEdit={held.has('page:edit')}
        />
      </Suspense>
    </div>
  );
}

async function PagesIndexData({
  service,
  projectId,
  viewerId,
  canEdit,
}: {
  service: ServiceContext;
  projectId: string;
  viewerId: string;
  canEdit: boolean;
}) {
  const pages = await pagesService.listPages(service, { projectId });
  return <PagesIndex pages={pages} viewerId={viewerId} canEdit={canEdit} now={new Date()} />;
}
