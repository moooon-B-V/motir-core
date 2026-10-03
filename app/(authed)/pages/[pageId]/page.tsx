import { cache, Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { memberPageContext, pageScope } from '@/lib/pages/projectPageContext';
import { pagesService } from '@/lib/services/pagesService';
import { PAGE_TITLE_MAX_LENGTH, PageNotFoundError } from '@/lib/pages';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { PageDto } from '@/lib/dto/pages';
import { PageSkeleton } from '@/components/ui/PageSkeleton';
import { PageView } from './_components/PageView';

// The page at its own address, `/pages/<id>` (Story MOTIR-5752 · MOTIR-7280),
// drawn by `design/pages/page.mock.html` states 6–12.
//
// ── THE GATE IS THE READ ──────────────────────────────────────────────────
// `memberPageContext()` resolves the reader and their ACTIVE project, then
// `pagesService.getPage` decides everything else in one transaction: whether
// the reader may browse the project (`page:view`), whether the page exists, and
// whether it lives in THIS project. Each refusal — `ProjectAccessDeniedError`
// (either kind), `PageNotFoundError` (an unknown id AND an id from another
// project), `ProjectNotFoundError` — calls `notFound()`, so the three cases the
// card names render the same screen under the same 404: the shared
// `app/(authed)/not-found.tsx`, unchanged (design-notes § State 12 — a
// page-specific message would itself be the leak, so no `not-found.tsx` is
// added under `pages/`). A page id from another project is never a silent
// project switch.
//
// ── THE FRAME IS AN IN-PAGE <Suspense>, AFTER THE GATE ────────────────────
// No `loading.tsx` above this route (it decides existence). The read settles the
// status first; the boundary below then covers the editor's code arriving
// (`PageView` loads it lazily). The "← Pages" link is static, so it paints above
// the boundary; the frame draws the generic header pair and paragraph bars, and
// NO toolbar block — whether there is a toolbar is `canEdit`'s answer (state 11).

type Params = { params: Promise<{ pageId: string }> };

/** Read the page as the signed-in member, or `null` for every not-found case. */
const loadPage = cache(
  async (pageId: string): Promise<{ page: PageDto; viewerId: string } | null> => {
    const ctx = await memberPageContext();
    const scope = pageScope(ctx);
    try {
      const page = await pagesService.getPage(scope.service, {
        projectId: scope.projectId,
        pageId,
      });
      return { page, viewerId: scope.userId };
    } catch (err) {
      // ⚠️ BOTH kinds of `ProjectAccessDeniedError` are a not-found here (MOTIR-7281).
      // `getPage` asserts `page:view`, and a reader who may BROWSE the project but
      // does not hold it — a workspace custom role, which holds `page:view` only
      // when an admin ticks it — is refused with kind 'edit'. Rethrowing that sent
      // them to the error boundary, while `/pages` answers the same reader with its
      // `notFound()`. The page they cannot read is one they cannot see.
      if (
        err instanceof ProjectAccessDeniedError ||
        err instanceof PageNotFoundError ||
        err instanceof ProjectNotFoundError
      ) {
        return null;
      }
      throw err;
    }
  },
);

/** The browser tab reads the page's title, or the untitled copy. */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { pageId } = await params;
  const loaded = await loadPage(pageId);
  if (!loaded) return {};
  const { page } = loaded;
  const t = await getTranslations('pages');
  return { title: page.title || t('untitled') };
}

export default async function PageAtItsAddress({ params }: Params) {
  const { pageId } = await params;
  const loaded = await loadPage(pageId);
  if (!loaded) notFound();
  const { page, viewerId } = loaded;

  const t = await getTranslations('pages.page');
  return (
    // History open (`data-history-open`, MOTIR-7387) widens the column at `xl`, where
    // the panel sits BESIDE the page instead of over it.
    <div className="mx-auto w-full max-w-[760px] xl:has-[[data-history-open]]:max-w-[1180px]">
      <Link
        href="/pages"
        aria-label={t('backLabel')}
        className="inline-flex items-center gap-1.5 text-[13px] text-(--el-text-secondary) hover:text-(--el-text)"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        {t('back')}
      </Link>
      <Suspense fallback={<PageFrame />}>
        <PageView
          key={page.id}
          viewerId={viewerId}
          page={{
            id: page.id,
            title: page.title,
            bodyState: page.bodyState,
            canEdit: page.canEdit,
          }}
          titleMaxLength={PAGE_TITLE_MAX_LENGTH}
        />
      </Suspense>
    </div>
  );
}

/** State 11: the generic header pair and paragraph bars — no toolbar block. */
function PageFrame() {
  return (
    <div className="mt-3">
      <PageSkeleton>
        <div className="flex flex-col gap-2.5">
          <div className="h-3.5 w-[92%] rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-3.5 w-[86%] rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-3.5 w-[64%] rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-3.5 w-[90%] rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-3.5 w-[40%] rounded-(--radius-control) bg-(--el-muted)" />
        </div>
      </PageSkeleton>
    </div>
  );
}
