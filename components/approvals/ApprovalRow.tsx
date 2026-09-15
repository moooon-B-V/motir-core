'use client';

import { useCallback, type MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { CircleDashed, Pencil } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { useDecidedGateState } from '@/lib/approvals/decidedGates';
import type {
  ApprovalGateKindDTO,
  ApprovalGateStateDTO,
  ApprovalGateSubjectSummaryDTO,
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
  DesignResultSubjectSummaryDTO,
  PullRequestMergeSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';

// THE APPROVALS ROW — the ONE row both approval lists render: the Workbench's
// To-approve tab (Story MOTIR-4879 · MOTIR-4794) and the Approval records room
// (Story MOTIR-5299 · MOTIR-5302). Built to `design/workbench/approvals-row.mock.html`
// and § 20 of `design/workbench/design-notes.md`, as amended by § 22 (the row OPENS
// the approval overlay), and — for the room — `design/approvals/design-notes.md`
// § The ROW, which COMPOSES this row rather than redrawing it.
//
// ⚠️ EXTRACTED FROM `ApprovalsList.tsx`, NOT WRITTEN BESIDE IT (MOTIR-5302). A
// second row grammar for one object is how two views start disagreeing about what
// a settled gate looks like. An `awaiting` row with no person column renders
// exactly the markup the tab rendered before the move; the room's additions are
// CONDITIONAL ELEMENTS of this one row:
//   · a `decided` record — the decided time in the time cell, *on <version>* in the
//     subject meta, and its state pill in the Decide cell;
//   · a PERSON cell before the Decide cell, only when the list passes `person`
//     (the room's full view: *Asked of* / *Decided by*).
//
// ⚠️ THE ROW OPENS THE APPROVAL FULL SCREEN (Subtask MOTIR-5225). The whole row is a
// real `<a href="/items/<key>">` whose PLAIN PRIMARY click writes the approval
// overlay's address (`?approval=<key>&approvalKind=<kind>`, § 22) with
// `shallowPush`, so the host list never re-renders and closing returns to exactly
// this page of it. A modified, middle or secondary click opens the card in a new
// tab — `usePeekRowClick`'s exact contract. The row writes `approval`, never
// `peek`, so the two cannot collide. A DECIDED row opens it too (§ 22 Panels 8a–8b
// draw the decided states); nothing in either list decides.
//
// ⚠️ AN AWAITING ROW DECIDED IN THE OVERLAY SETTLES IN PLACE — it does not vanish
// under the cursor. A row whose gate the overlay decided swaps its Decide cell for
// the state pill, through the signal in `lib/approvals/decidedGates.ts` (§ 22
// planning flag 2) — `router.refresh()` cannot reach a client island.

/** The tab's column set — see design-notes § 20. The room's own-records view uses it unchanged. */
export const APPROVALS_GRID_TEMPLATE = 'minmax(10rem,1fr) 268px 88px 132px';

/**
 * The room's FULL-VIEW column set (`design/approvals` § The grid): the tab's, with
 * the work-item track narrowed 268px → 228px and a 144px person track before the
 * Decide cell, so a decided row's version is not truncated away.
 */
export const APPROVALS_FULL_VIEW_GRID_TEMPLATE = 'minmax(10rem,1fr) 228px 88px 144px 132px';

/** What one row renders: a live question, or a decided record. */
export type ApprovalRowRecord =
  | { section: 'awaiting'; row: ApprovalQueueRowDto }
  | { section: 'decided'; row: ApprovalRecordDecidedRowDto };

/** Relative time — "4 days", in the active locale; the absolute date goes on hover. */
function useRelativeLabel(): (iso: string) => string {
  const locale = useLocale();
  return (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    const hours = Math.round(ms / 3_600_000);
    const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
    // Clamped at 0 in both units: a clock skew must not render "in 2 hours" on a
    // list of things that have already happened.
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
function useOpenApproval(): (row: {
  workItem: { identifier: string };
  kind: ApprovalGateKindDTO;
}) => void {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (row) => {
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
function KindGlyph({ kind }: { kind: ApprovalGateKindDTO }) {
  return kind === 'design_result' ? (
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
function SubjectMeta({
  subject,
  decidedVersion,
}: {
  subject: ApprovalGateSubjectSummaryDTO | null;
  /** Set on a DECIDED record: the version the decision was made against. */
  decidedVersion?: string | null;
}) {
  const t = useTranslations('workbench.approvals');
  if (subject === null) {
    // The gate's subject no longer resolves — a DIFFERENT fact from not-built-yet
    // (design-notes § 20). The first is a feature that has not shipped; the
    // second is a gate worth withdrawing, and collapsing them would report a
    // shipped kind as unbuilt.
    return <span className="truncate text-xs text-(--el-text-secondary)">{t('subjectGone')}</span>;
  }
  if (decidedVersion !== undefined) {
    // A RECORD says WHICH bytes were decided (`design/approvals` § The ROW,
    // addition 3): the first 8 characters, the whole value on hover. The tab's
    // meta reads the subject's CURRENT sha, which is wrong for a decision made
    // against an earlier one.
    return (
      <span
        className="truncate text-xs text-(--el-text-secondary)"
        title={decidedVersion ?? undefined}
      >
        {decidedVersion
          ? t.rich('decidedOn', {
              version: decidedVersion.slice(0, 8),
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })
          : t('noVersion')}
      </span>
    );
  }
  if (subject.kind === 'pull_request_merge') {
    // A REGISTERED kind with a real subject (MOTIR-4793): the row names the pull
    // request. Its decide surface is MOTIR-4909's frame, so the Decide cell still
    // takes the no-renderer treatment — but the SUBJECT is known, and "Motir cannot
    // show this kind" would be false about it.
    const merge: PullRequestMergeSubjectSummaryDTO = subject;
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">
        {t('mergeSubjectMeta', { pr: `${merge.repo}#${merge.number}` })}
      </span>
    );
  }
  if (subject.kind !== 'design_result') {
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">{t('notRenderable')}</span>
    );
  }
  const design: DesignResultSubjectSummaryDTO = subject;
  return (
    <span className="truncate text-xs text-(--el-text-secondary)">
      {t('subjectMeta', {
        files: design.assetCount,
        version: design.commitSha ? design.commitSha.slice(0, 8) : t('noVersion'),
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
    /* v8 ignore next 2 -- UNREACHABLE: `awaiting` is the one state left, and
       `announceGateDecided` refuses it (`tests/approvals/decidedGates.test.tsx`,
       "does not treat `awaiting` as a decision"). */
    default:
      return null;
  }
}

/** ONE row — and the door to its approval. */
export function ApprovalRow({
  record,
  gridTemplate = APPROVALS_GRID_TEMPLATE,
  person,
}: {
  record: ApprovalRowRecord;
  gridTemplate?: string;
  /**
   * The room's full-view PERSON cell (`design/approvals` § The ROW, addition 1).
   * `undefined` renders no cell at all — the tab, and the room's own-records view.
   */
  person?: { label: string; value: string };
}) {
  const t = useTranslations('workbench.approvals');
  const tGate = useTranslations('approvalGate');
  const relativeLabel = useRelativeLabel();
  const openApproval = useOpenApproval();
  const { row } = record;
  const announcedState = useDecidedGateState(row.gateId);

  // A kind with no renderer, or a subject that is gone, still HAS the door — the
  // overlay draws both (§ 22 Panels 4a / 4b). What they lack is anything to
  // decide, so their Decide cell keeps § 20's treatment.
  const renderable = row.subject !== null && row.subject.kind === 'design_result';
  const settledState: ApprovalGateStateDTO | null =
    record.section === 'decided' ? record.row.state : announcedState;
  const settled = settledState !== null;
  const timeIso = record.section === 'decided' ? record.row.decidedAt : record.row.waitingSince;

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
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        {/* THE DOOR (§ 22 Panel 9), stretched behind the cells. The one link that
            visibly leaves the list is the work-item cell, which sits ABOVE this
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
        <KindGlyph kind={row.kind} />
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
        {record.section === 'decided' ? (
          <SubjectMeta subject={row.subject} decidedVersion={record.row.subjectVersion} />
        ) : (
          <SubjectMeta subject={row.subject} />
        )}
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
              what a person quotes. A record's time is when it was DECIDED; a
              question's is how long it has waited. */}
          <span
            className="truncate text-xs text-(--el-text-secondary)"
            title={new Date(timeIso).toLocaleString()}
          >
            {relativeLabel(timeIso)}
          </span>
        </div>
        {person === undefined ? null : (
          <div role="cell" className="flex min-w-0 items-center">
            {/* Below `md` the column header is gone, so the cell carries its own
                label and is never an unlabelled name (`design/approvals` § Narrow). */}
            <span className="truncate text-xs text-(--el-text-secondary)" title={person.value}>
              <span className="md:sr-only">{person.label}: </span>
              {person.value}
            </span>
          </div>
        )}
        <div role="cell" className="flex min-w-0 items-center md:justify-end">
          {settled ? (
            <StatePill state={settledState} />
          ) : !renderable ? (
            <Pill tone="archived">{t('notBuiltYet')}</Pill>
          ) : record.section === 'awaiting' && !record.row.canDecide ? (
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
