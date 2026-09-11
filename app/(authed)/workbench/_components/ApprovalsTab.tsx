import { getTranslations } from 'next-intl/server';
import { Inbox } from 'lucide-react';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import type { HomeActorContext } from '@/lib/services/homeService';
import { EmptyState } from '@/components/ui/EmptyState';
import { ApprovalsList } from './ApprovalsList';

// The Approvals TAB's content (Story MOTIR-4879 · Subtask MOTIR-4794), built to
// `design/workbench/approvals-row.mock.html`.
//
// ⚠️ IT DOES ITS OWN READ, AND THAT IS WHAT PUTS A BOUNDARY AROUND IT. The four
// work tabs are read in the page's own `Promise.all`, so nothing can suspend
// around them; this one awaits HERE, which is what lets the page mount a
// `<Suspense>` between its GATE and this content — window 2 of
// `design/shell/design-notes.md`'s navigation-pending grammar, *"an in-page
// `<Suspense>` placed AFTER the page's gate"*.
//
// ⚠️ AND A `loading.tsx` IS THE WRONG INSTRUMENT HERE, not merely a different
// one. That grammar's whole constraint is that a route boundary can flush the
// response head before the page's gate has run, fixing the status at 200 — which
// is why this repo has no `loading.tsx` anywhere and
// `tests/navigation/loading-boundary-guard.test.ts` keeps it that way. The
// boundary belongs INSIDE the page, below the reads that decide who may see it.
//
// ⚠️ SCOPED TO THIS TAB. The other four tabs keep the page's existing shape
// untouched — this card's boundary is the Approvals tab, and making all five
// suspend would be a page-shell change it is scoped away from.

/** The empty state — drawn by `design/workbench/`, not by this card. */
async function NothingWaiting() {
  const t = await getTranslations('workbench');
  return (
    <EmptyState
      icon={<Inbox className="h-12 w-12" aria-hidden />}
      title={t('empty.approvals.title')}
      description={t('empty.approvals.body')}
    />
  );
}

export async function ApprovalsTab({ ctx, page }: { ctx: HomeActorContext; page: number }) {
  const t = await getTranslations('workbench');
  const window = await approvalGatesService.listAwaitingMe(ctx, { page });

  if (window.items.length === 0) return <NothingWaiting />;

  return (
    <ApprovalsList
      rows={window.items}
      label={t('tabs.toApprove')}
      pagination={{ total: window.total, page: window.page, pageSize: window.pageSize }}
    />
  );
}
