'use client';

import { useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, CircleDashed, Pencil } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import { DesignResultPanel } from '../../items/[key]/_components/DesignResultPanel';
import { IssueListPager } from '../../items/_components/IssueListPager';
import { decideApprovalGateAction } from '../../items/[key]/approvalGateActions';
import { loadApprovalSubjectAction } from '../approvalsActions';
import { workbenchTabHref } from '@/lib/workbench/tab';
import type {
  ApprovalGateDTO,
  ApprovalQueueRowDto,
  DesignResultSubjectSummaryDTO,
  GateDecision,
} from '@/lib/dto/approvalGate';
import type { DesignGateSubjectDTO } from '@/lib/dto/designEvidence';
import type { GateRefusal } from '@/lib/approvalGates/refusals';

// THE APPROVALS TAB'S LIST (Story MOTIR-4879 · Subtask MOTIR-4794), built to
// `design/workbench/approvals-row.mock.html` and its § 20 in
// `design/workbench/design-notes.md`.
//
// ⚠️ THE ROW IS A DISCLOSURE, and that is the design's central decision rather
// than an interaction detail. The shipped `ApprovalGateControl` is a THREE-BAND
// panel built for an item page, and N of those stacked in a paged list is not a
// row. Three shapes were live and two are wrong for reasons already on the
// record: verbs on the row would be approving something you have not looked at
// (the control's own first cut was rejected for exactly that), and a link to the
// item page defeats a tab whose promise is that you stop needing to know which
// card to open. So the row OPENS, and the shipped frame renders inside the list.
// ONE row open at a time.
//
// ⚠️ A DECIDED ROW SETTLES IN PLACE — it does not vanish under the cursor. This
// is a SHARED queue: routing shows a gate to one person, but ADR §2's amendment
// lets assignee OR reporter OR admin press it, so a row can be decided by
// somebody else while you are reading it. A surface that sometimes removes a row
// silently and sometimes explains one teaches that disappearance is ambiguous —
// and the frame already draws its refusal IN PLACE one interaction over, so a
// list that removed rows would contradict the panel inside it. The read returns
// only `awaiting` gates, so the next load is what removes it.
//
// ⚠️ THE CONTROL IS COMPOSED, NEVER RE-IMPLEMENTED. Same component as the item
// page's design-result section, and `tests/components/workbench-approvals-list.test.tsx`
// asserts that BY IDENTITY rather than by matching markup — a row that merely
// looked the same would be a second approval language, which is the thing the
// registry and the frame exist together to prevent.

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

/** The state pill a SETTLED row carries in place of its disclosure. */
function StatePill({ state }: { state: ApprovalGateDTO['state'] }) {
  const t = useTranslations('approvalGate.state');
  switch (state) {
    // ⚠️ THE SAME PILL RECIPES THE FRAME PICKS, so a settled row and the frame
    // inside it cannot disagree about what a state looks like.
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

/**
 * ONE row, plus the frame it discloses.
 *
 * The gate as THIS row knows it: the server's, until the reader decides — then
 * the decided row that response returned. Reconciling from the response rather
 * than a refetch is the inline-edit half of the page-state contract; the
 * `router.refresh()` beside it is the server half (the strip count, and the
 * readiness of every card this decision unblocks).
 */
function ApprovalRow({
  row,
  open,
  onToggle,
}: {
  row: ApprovalQueueRowDto;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('workbench.approvals');
  const tGate = useTranslations('approvalGate');
  const tDesign = useTranslations('approvalGate.designResult');
  const router = useRouter();
  const waitedLabel = useWaitedLabel();

  const [gate, setGate] = useState<ApprovalGateDTO | null>(null);
  const [subject, setSubject] = useState<DesignGateSubjectDTO | null>(null);
  const [, startLoading] = useTransition();

  // A row whose kind has no renderer, or whose subject is gone, has nothing to
  // open — band 3 sits below the port, and a row with no port has nothing to
  // decide after (design-notes § 20).
  const openable = row.subject !== null && row.subject.kind === 'design_result';
  const settled = gate !== null && gate.state !== 'awaiting';

  function toggle() {
    if (!openable) return;
    onToggle();
    if (!open && subject === null && row.subject?.kind === 'design_result') {
      const subjectId = row.subject.designEvidenceId;
      startLoading(async () => {
        setSubject(await loadApprovalSubjectAction(row.workItem.id, subjectId));
      });
    }
  }

  async function onDecide(decision: GateDecision): Promise<GateRefusal | null> {
    const result = await decideApprovalGateAction({
      gateId: row.gateId,
      decision,
      // The CARD's path, which the action revalidates alongside the Workbench's
      // — a decision moves that card's status rail as well as this row.
      identifier: row.workItem.identifier,
    });
    if (!result.ok) return result.refusal;
    // SETTLE IN PLACE: the row keeps its position and swaps its Decide cell for
    // the state pill. The read returns only `awaiting` gates, so the refresh
    // below is also what eventually removes it — on the NEXT load, never under
    // the cursor.
    //
    // ⚠️ BOTH HALVES, AND THE SERVER HALF RIDES THE ACTION'S OWN RESPONSE.
    // MOTIR-5118 measured `router.refresh()` ALONE as insufficient on a loaded
    // lane — it fires, it returns 200, and the fresh tree arrives on a second
    // apply that can go missing. So the action revalidates; this refresh is what
    // reaches surfaces a server revalidation does not cover, and removing it is
    // a separate claim nobody has measured.
    setGate(result.gate);
    router.refresh();
    return null;
  }

  const verbs: GateVerb[] = [
    {
      decision: 'request_changes',
      label: tGate('verb.requestChanges'),
      variant: 'secondary',
      confirms: false,
    },
    { decision: 'approve', label: tGate('verb.approve'), variant: 'primary', confirms: true },
  ];

  return (
    <>
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
          {/* The whole-row affordance is the DISCLOSURE, not a link to the card
              — this tab exists so you do not have to open the card. The one link
              that leaves the queue is the work-item cell, which sits ABOVE this
              overlay on `z-10` so it survives. */}
          {openable ? (
            /* ⚠️ NAMED FOR THE ROW, not "Review". The Decide cell carries a
               visible Review button, and two buttons with the SAME accessible
               name in one row is a screen reader reading "Review, Review" with
               no way to tell the overlay from the control — the same reason
               `WorkbenchList`'s own row overlay is labelled with the item. */
            <button
              type="button"
              aria-expanded={open}
              aria-label={t('reviewRow', {
                key: row.workItem.identifier,
                title: row.workItem.title,
              })}
              onClick={toggle}
              className="absolute inset-0 z-0 focus:outline-none"
            />
          ) : null}
          {openable ? (
            open ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
            )
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
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
              settled || !openable ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
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
                  settled || !openable ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
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
              <StatePill state={gate.state} />
            ) : !openable ? (
              <Pill tone="archived">{t('notBuiltYet')}</Pill>
            ) : !row.canDecide ? (
              /* SEE but not DECIDE — the row states what it is and carries no
                 decide control. The disclosure STAYS: what is withheld is the
                 DECISION, never the look, and the frame renders its own state
                 `B` (port live, verbs absent) inside it. */
              <Pill tone="awaiting">{tGate('state.awaiting')}</Pill>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="relative z-10"
                onClick={toggle}
              >
                {t('review')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {open && openable ? (
        <div
          role="row"
          data-testid={`approval-frame-${row.gateId}`}
          className="border-b border-(--el-border) bg-(--el-surface-soft) px-4 py-4 last:border-b-0"
        >
          <div role="cell" className="block">
            <ApprovalGateControl
              gate={gate ?? rowGate(row)}
              // ⚠️ THE READ'S ANSWER, never this component's. The routing
              // predicate that put this row in the queue satisfies ADR §2's
              // RELATIONSHIP arm by construction, so it is tempting to pass
              // `true` — but the decide door also applies the kind's PERMISSION
              // FLOOR, and a project `viewer` can be an assignee. Deriving it
              // here would draw verbs the door then refuses. A settled row has
              // nothing left to press either way: a decided gate is immutable.
              canDecide={row.canDecide && !settled}
              kindLabel={tDesign('kindLabel')}
              subjectMeta={subjectMetaText(row, tDesign)}
              port={<DesignResultPanel evidence={subject?.evidence ?? null} isDesignCard />}
              verbs={verbs}
              consequence={tDesign('consequence', { key: row.workItem.identifier })}
              confirmConsequences={[
                tDesign('confirm.records'),
                tDesign('confirm.keepsFiles'),
                tDesign('confirm.movesToDone', { key: row.workItem.identifier }),
              ]}
              routedToLabel={null}
              filesKept={subject ? subject.filesKept : null}
              onDecide={onDecide}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The queue row as the FRAME's `ApprovalGateDTO`.
 *
 * ⚠️ THE QUEUE READ IS NARROWER THAN THE FRAME'S PROP ON PURPOSE, and this is
 * where the two meet. Every row this read returns is `awaiting`, so all six of
 * ADR §6a's audit fields are null on every one of them by construction —
 * carrying them would be six columns of guaranteed nulls travelling to a surface
 * with nothing to render them (`lib/dto/approvalGate.ts`). They are null HERE
 * for the same reason, not as placeholders: the moment a reader decides, the
 * frame is handed the real decided row the action returned.
 */
function rowGate(row: ApprovalQueueRowDto): ApprovalGateDTO {
  return {
    id: row.gateId,
    workItemId: row.workItem.id,
    kind: row.kind,
    subjectId: row.subject?.kind === 'design_result' ? row.subject.designEvidenceId : '',
    state: 'awaiting',
    decidedById: null,
    decidedAt: null,
    noteMd: null,
    subjectVersion: row.subject?.kind === 'design_result' ? row.subject.commitSha : null,
    decidedByLabel: null,
    routedToId: null,
    decidedUnderAuthority: null,
    decisionSource: null,
    outcomeRef: null,
    createdAt: row.waitingSince,
    updatedAt: row.waitingSince,
  };
}

/** Band 1's meta line — where `subject.noteExcerpt` lands (design-notes § 20). */
function subjectMetaText(
  row: ApprovalQueueRowDto,
  tDesign: ReturnType<typeof useTranslations<'approvalGate.designResult'>>,
): ReactNode {
  if (row.subject?.kind !== 'design_result') return tDesign('meta.plain');
  const { commitSha, noteExcerpt } = row.subject;
  const version = commitSha
    ? tDesign('meta.withVersion', { version: commitSha.slice(0, 8) })
    : tDesign('meta.plain');
  return noteExcerpt ? `${version} · ${noteExcerpt}` : version;
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
  // ONE row open at a time. A queue whose rows all expand is a page of stacked
  // panels — the thing the disclosure exists to avoid.
  const [openGateId, setOpenGateId] = useState<string | null>(null);

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
            <ApprovalRow
              key={row.gateId}
              row={row}
              open={openGateId === row.gateId}
              onToggle={() =>
                setOpenGateId((current) => (current === row.gateId ? null : row.gateId))
              }
            />
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
