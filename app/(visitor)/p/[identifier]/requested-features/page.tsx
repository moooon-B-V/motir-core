import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import { isVisitorContext } from '@/lib/visitor/readScope';
import { renderVisitorView } from '../_render';
import { RequestedFeaturesList } from './_components/RequestedFeaturesList';

/**
 * `/p/<identifier>/requested-features` — a public project's PENDING feature
 * requests, read by its Visitor (Story MOTIR-6171 · MOTIR-6769; design MOTIR-6767;
 * `docs/decisions/public-request-board-retired.md` Decision 2).
 *
 * Page one renders here, on the server, from the read MOTIR-6768 shipped; "Load
 * more" pages through its door. The layout has already settled the reader
 * (not-found → sign-in → consent), and a member following this address is sent
 * to their own `/triage` by `proxy.ts` through `lib/visitor/routes.ts`.
 * The ONE write offered is the upvote, on the existing public-request act route —
 * no Manager action exists on this page.
 */
export default async function VisitorRequestedFeaturesPage({
  params,
}: {
  params: Promise<{ identifier: string }>;
}) {
  return renderVisitorView(params, async (ctx) => {
    // `renderVisitorView` only ever hands a Visitor's context; a member never
    // reaches this page body (they are redirected into their own inbox).
    if (!isVisitorContext(ctx.reader)) notFound();
    const [page, t] = await Promise.all([
      publicRequestsService.listPendingForVisitorContext(ctx.reader),
      getTranslations('visitor.requestedFeatures'),
    ]);
    return (
      <div className="mx-auto max-w-[56rem]">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
            <p className="mt-1 text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
          </div>
          <span className="text-sm whitespace-nowrap text-(--el-text-secondary)">
            {t('total', { count: page.total })}
          </span>
        </header>
        <RequestedFeaturesList identifier={ctx.project.identifier} initial={page} />
      </div>
    );
  });
}
