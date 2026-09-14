'use client';

import { useCallback, type MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CircleDashed, Pencil } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { IssueListPager } from '../../items/_components/IssueListPager';
import { workbenchTabHref } from '@/lib/workbench/tab';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { useDecidedGateState } from '@/lib/approvals/decidedGates';
import type {
  ApprovalGateStateDTO,
  ApprovalQueueRowDto,
  DesignResultSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';

// THE APPROVALS TAB'S LIST (Story MOTIR-4879 · Subtask MOTIR-4794), built to
// `design/workbench/approvals-row.mock.html` and its § 20 in
// `design/workbench/design-notes.md` — AS AMENDED by § 22 (Story MOTIR-5214).
//
// ⚠️ THE ROW OPENS THE APPROVAL FULL SCREEN (Subtask MOTIR-5225). Until that card
// the row was a DISCLOSURE that grew the shared frame inside the list; § 20's
// amendment supersedes that. Now the whole row is a real `<a href="/items/<key>">`
// whose PLAIN PRIMARY click writes the approval overlay's address
// (`?approval=<key>&approvalKind=<kind>`, § 22) with `shallowPush`, so the tab
// never re-renders and closing returns to exactly this page of it. A modified,
// middle or secondary click opens the card in a new tab — `usePeekRowClick`'s
// exact contract, which the other four tabs' rows already keep. The row writes
// `approval`, never `peek`, so the two cannot collide.
//
// ⚠️ THE LIST RENDERS NO FRAME. The approval overlay (mounted once in the authed
// shell) is where a gate is looked at and decided, so this island holds no gate,
// loads no subject and has no decide path of its own.
//
// ⚠️ A DECIDED ROW SETTLES IN PLACE — it does not vanish under the cursor. This
// is a SHARED queue: routing shows a gate to one person, but ADR §2 lets an
// ADMIN press any gate, so a row can be decided by somebody else while you are
// reading it. A surface that sometimes removes a row silently and sometimes
// explains one teaches that disappearance is ambiguous. So a row whose gate the
// overlay decided swaps its Decide cell for the state pill, through the signal
// in `lib/approvals/decidedGates.ts` (§ 22 planning flag 2) — `router.refresh()`
// cannot reach a client island. The read returns only `awaiting` gates, so the
// next load is what removes it.

/** The Approvals column set — see design-notes § 20. */
const GRID_TEMPLATE = 'minmax(10rem,1fr) 268px 88px 132px';

/** Relative wait — "4 days", in the active locale, with the absolute date on hover. */
function useWaitedLabel(): (iso: string) => string {
  const locale = useLocale();
  return (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    const hours = Math.round(ms / 3_600_000);
    const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
    // Clamped at 0 in both units: a clock skew must not render "in 2 hours" on a
    // queue of things that have been waiting.
    return hours < 48
      ? fmt.format(-Math.max(hours, 0), 'hour')
      : fmt.format(-Math.max(Math.round(hours / 24), 0), 'day');
  };
}

/**
 * Open a row's approval over the page the list is on.
 *
 * The host page's own query — the tab, the page of the list — is kept, so the
 * overlay's close lands back on exactly it.
 */
function useOpenApproval(): (row: ApprovalQueueRowDto) => void {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (row: ApprovalQueueRowDto) => {
      const qs = searchParams.toString();
      shallowPush(
        withApprovalOverlay(`${pathname}${qs ? `?${qs}` : ''}`, {
          itemKey: row.workItem.identifier,
          kind: row.kind,
        }),
      );
    },
    [pathname, searchParams],
  );
}

/** A row's glyph: the shipped design-type mark for the one registered kind. */
function KindGlyph({ row }: { row: ApprovalQueueRowDto }) {
  return row.kind === 'design_result' ? (
    // `lib/issues/workItemTypeMeta.ts`'s own glyph + hue for `design` — a design
    // result IS a design, so the reader already knows this mark.
    <Pencil className="h-4 w-4 shrink-0 text-(--el-type-design)" aria-hidden />
  ) : (
    // Colourless, and deliberately NOT another kind's mark: this row exists to
    // say the kind is not built yet. `--el-text-faint` is legal here because the
    // glyph is `aria-hidden` and the words beside it carry the meaning.
    <CircleDashed className="h-4 w-4 shrink-0 text-(--el-text-faint)" aria-hidden />
  );
}

/** What the row says about the thing being decided, per kind. */
function SubjectMeta({ row }: { row: ApprovalQueueRowDto }) {
  const t = useTranslations('workbench.approvals');
  if (row.subject === null) {
    // The gate's subject no longer resolves — a DIFFERENT fact from not-built-yet
    // (design-notes § 20). The first is a feature that has not shipped; the
    // second is a gate worth withdrawing, and collapsing them would report a
    // shipped kind as unbuilt.
    return <span className="truncate text-xs text-(--el-text-secondary)">{t('subjectGone')}</span>;
  }
  if (row.subject.kind !== 'design_result') {
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">{t('notRenderable')}</span>
    );
  }
  const subject: DesignResultSubjectSummaryDTO = row.subject;
  return (
    <span className="truncate text-xs text-(--el-text-secondary)">
      {t('subjectMeta', {
        files: subject.assetCount,
        version: subject.commitSha ? subject.commitSha.slice(0, 8) : t('noVersion'),
      })}
    </span>
  );
}

/** The state pill a SETTLED row carries in its Decide cell. */
function StatePill({ state }: { state: ApprovalGateStateDTO }) {
  const t = useTranslations('approvalGate.state');
  switch (state) {
    // ⚠️ THE SAME PILL RECIPES THE FRAME PICKS, so a settled row and the frame
    // in the overlay above it cannot disagree about what a state looks like.
    case 'approved':
      return <Pill severity="success">{t('approved')}</Pill>;
    case 'changes_requested':
      return <Pill severity="warning">{t('changesRequested')}</Pill>;
    // ⚠️ COLOURLESS, and that is the design's decision rather than a fallback.
    // `superseded` is written by the PRODUCT, never by a person, so a tinted
    // pill would let the audit read a withdrawn question as somebody's answer.
    // `tone="archived"` is the frame's own choice for the same row.
    case 'superseded':
      return <Pill tone="archived">{t('withdrawn')}</Pill>;
    default:
      return null;
  }
}

/** ONE row — and the door to its approval. */
function ApprovalRow({ row }: { row: ApprovalQueueRowDto }) {
  const t = useTranslations('workbench.approvals');
  const tGate = useTranslations('approvalGate');
  const waitedLabel = useWaitedLabel();
  const openApproval = useOpenApproval();
  const decidedState = useDecidedGateState(row.gateId);

  // A kind with no renderer, or a subject that is gone, still HAS the door — the
  // overlay draws both (§ 22 Panels 4a / 4b). What they lack is anything to
  // decide, so their Decide cell keeps § 20's treatment.
  const renderable = row.subject !== null && row.subject.kind === 'design_result';
  const settled = decidedState !== null;

  function onRowClick(e: MouseEvent<HTMLAnchorElement>) {
    // `usePeekRowClick`'s exact condition (`IssueQuickView.tsx`): a modifier or
    // non-primary click keeps its native meaning — the card, in a new tab —
    // which is why the row's href has to be real. Keyboard Enter on the anchor
    // dispatches a primary click, so it takes this same path.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openApproval(row);
  }

  return (
    <div
      role="row"
      data-testid={`approval-row-${row.gateId}`}
      className={cn(
        'group relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0',
        'hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
        'md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0 md:py-0 md:pr-4 md:pl-4',
      )}
      style={{ gridTemplateColumns: GRID_TEMPLATE }}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        {/* THE DOOR (§ 22 Panel 9), stretched behind the cells. The one link that
            visibly leaves the queue is the work-item cell, which sits ABOVE this
            on `z-10` so it survives.
            ⚠️ NAMED FOR THE ROW, not "Review". The Decide cell carries a visible
            Review button, and two controls with the SAME accessible name in one
            row is a screen reader reading "Review, Review" with no way to tell
            them apart — the same reason `WorkbenchList`'s row link is labelled
            with the item. */}
        <Link
          href={`/items/${row.workItem.identifier}`}
          aria-haspopup="dialog"
          aria-label={t('reviewRow', { key: row.workItem.identifier, title: row.workItem.title })}
          onClick={onRowClick}
          className="absolute inset-0 z-0 focus:outline-none"
        />
        <KindGlyph row={row} />
        <span
          className={cn(
            'shrink-0 text-sm font-medium',
            // ⚠️ `--el-text-secondary`, NOT the `--el-text-muted` the design's
            // token map names for a settled row. Muted is 4.12–4.34:1 on
            // `--el-surface` — which is THIS row's hover fill — so the ink
            // would drop below AA exactly while the pointer is on it. The
            // sibling `WorkbenchList` records the identical pair for its own
            // identifier cell. The ASSET is amended to match (§ 20's token
            // map); the guard found this before a reader did.
            settled || !renderable ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
          )}
        >
          {t(`kind.${row.kind}`)}
        </span>
        <SubjectMeta row={row} />
      </div>

      <div role="presentation" className="flex flex-wrap items-center gap-2 pl-6 md:contents">
        <div role="cell" className="flex min-w-0 items-center">
          <Link
            href={`/items/${row.workItem.identifier}`}
            className="relative z-10 flex min-w-0 items-center gap-2 hover:underline"
          >
            {/* `--el-text-secondary`, not muted: this row's hover fill is
                `--el-surface`, where muted is 4.17:1 and fails AA — the same
                pair `WorkbenchList` records for its own identifier cell. */}
            <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
              {row.workItem.identifier}
            </span>
            <span
              className={cn(
                'truncate text-sm',
                settled || !renderable ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
              )}
            >
              {row.workItem.title}
            </span>
          </Link>
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          {/* Relative in the cell, ABSOLUTE in the title — the absolute one is
              what a person quotes. */}
          <span
            className="truncate text-xs text-(--el-text-secondary)"
            title={new Date(row.waitingSince).toLocaleString()}
          >
            {waitedLabel(row.waitingSince)}
          </span>
        </div>
        <div role="cell" className="flex min-w-0 items-center md:justify-end">
          {settled ? (
            <StatePill state={decidedState} />
          ) : !renderable ? (
            <Pill tone="archived">{t('notBuiltYet')}</Pill>
          ) : !row.canDecide ? (
            /* SEE but not DECIDE — the row states what it is and carries no
               decide control. The door STAYS: what is withheld is the DECISION,
               never the look, and the overlay draws the frame's state `B`. */
            <Pill tone="awaiting">{tGate('state.awaiting')}</Pill>
          ) : (
            /* The labelled door a keyboard and a screen reader find (§ 22
               Panel 9) — the same address as the row. */
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-haspopup="dialog"
              className="relative z-10"
              onClick={() => openApproval(row)}
            >
              {t('review')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ApprovalsList({
  rows,
  label,
  pagination,
}: {
  rows: ApprovalQueueRowDto[];
  label: string;
  pagination: { total: number; page: number; pageSize: number };
}) {
  const t = useTranslations('workbench.approvals');
  const router = useRouter();

  return (
    <div
      data-surface="card"
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
    >
      <div role="table" aria-label={label} className="w-full text-sm">
        {/* Hidden below `md`: it labels a grid that does not exist at that width,
            and a header reading "Work item" above something that is not a column
            is worse than no header (design-notes § 20). */}
        <div role="rowgroup" className="hidden md:block">
          <div
            role="row"
            className="sticky top-0 z-20 grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-4 pl-4"
            style={{ gridTemplateColumns: GRID_TEMPLATE, height: 40 }}
          >
            {[t('columns.subject'), t('columns.workItem'), t('columns.waited'), ''].map((c, i) => (
              <div key={c || `c${i}`} role="columnheader" className="flex min-w-0 items-center">
                <span className="truncate text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
                  {c}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {rows.map((row) => (
            <ApprovalRow key={row.gateId} row={row} />
          ))}
        </div>
      </div>
      {/* The shipped pager, inherited unchanged — `design/workbench/design-notes.md`
          records that this tab gets it "for free the moment MOTIR-4794 renders
          rows into the shared list". */}
      <IssueListPager
        total={pagination.total}
        page={pagination.page}
        pageSize={pagination.pageSize}
        onPage={(page) => router.push(workbenchTabHref('approvals', page))}
      />
    </div>
  );
}
