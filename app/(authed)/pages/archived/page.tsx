import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { memberPageContext, pageScope } from '@/lib/pages/projectPageContext';
import { pagesService } from '@/lib/services/pagesService';
import type { PageArchivedListDto } from '@/lib/dto/pages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { ArchivedPagesFrame } from './_components/ArchivedPagesFrame';
import { ArchivedPagesList } from './_components/ArchivedPagesList';

// THE ARCHIVED PAGES LIST, `/pages/archived` (Story MOTIR-5755 · MOTIR-7424) —
// design MOTIR-7416, surface 6. A static segment beside `[pageId]`; reached from
// the `/pages` header's **Archived pages** link. Every archive ROOT of the active
// project, newest first, 50 at a time — a sub-page archived with its parent is
// counted on its root's row, never a row of its own. `/items/archived`'s grammar:
// a back link, the serif heading, a subtitle, then the table.
//
// ── THE GATE FIRST ─────────────────────────────────────────────────────────
// `memberPageContext()` and `page:view`, exactly as `/pages` and `/pages/<id>`:
// a reader who cannot read pages gets `notFound()` before anything is read.
//
// ── THEN AN IN-PAGE <Suspense> — NEVER A `loading.tsx` ─────────────────────
// This route decides existence, so a route-level boundary would flush a 200 first
// (`CLAUDE.md` § A `loading.tsx` may NOT sit above a route that decides
// existence). The header is real; the frame is the table's header row and four
// row blocks. The first page is read on the server; a read that fails is not a
// 500 — the list renders its error row with Try again, which reads through
// `GET /api/pages/archived`.
//
// ── ACTIONS BY ROLE ────────────────────────────────────────────────────────
// Restore is `page:edit`, Delete… is `page:delete` (the keys the routes assert);
// a reader with neither — a viewer — gets no actions column at all.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pages.archive.list');
  return { title: t('title') };
}

export default async function ArchivedPagesPage() {
  const ctx = await memberPageContext();
  const [held, t] = await Promise.all([ctx.permissions(), getTranslations('pages.archive.list')]);
  if (!held.has('page:view')) notFound();
  const scope = pageScope(ctx);
  const canRestore = held.has('page:edit');
  const canDelete = held.has('page:delete');

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/pages"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-(--el-link) hover:text-(--el-link-pressed)"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t('back')}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('title')}</h1>
        <p className="text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </header>
      <Suspense fallback={<ArchivedPagesFrame showActions={canRestore || canDelete} />}>
        <ArchivedPagesData
          service={scope.service}
          projectId={scope.projectId}
          projectKey={scope.project.identifier}
          canRestore={canRestore}
          canDelete={canDelete}
        />
      </Suspense>
    </div>
  );
}

async function ArchivedPagesData({
  service,
  projectId,
  projectKey,
  canRestore,
  canDelete,
}: {
  service: ServiceContext;
  projectId: string;
  projectKey: string;
  canRestore: boolean;
  canDelete: boolean;
}) {
  const initial: PageArchivedListDto | null = await pagesService
    .listArchivedPages(service, { projectId })
    .catch((err: unknown) => {
      console.error('[pages] the archived pages could not be read', err);
      return null;
    });
  return (
    <ArchivedPagesList
      initial={initial}
      projectKey={projectKey}
      canRestore={canRestore}
      canDelete={canDelete}
    />
  );
}
