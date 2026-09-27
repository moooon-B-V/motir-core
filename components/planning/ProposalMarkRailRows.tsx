'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ObsolescencePill } from '@/components/issues/ObsolescencePill';
import { SupersedesChips } from '@/components/planning/SupersedesChip';
import { ChangedMark } from '@/components/workItems/ProposalPeekMarks';
import { QuickViewRailField } from '@/components/workItems/QuickViewSurface';
import { REASON_CLAMP_CHARS } from '@/components/approvals/RefusalReason';
import type { PlanItemChangeDto, PlanProposalPeekDto } from '@/lib/dto/planReview';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';

// THE PEEK'S MARK ROWS, proposal mode (Story MOTIR-6577 · MOTIR-6632; design
// `design/ai-planning/design-notes.md` Part XXIV §24.10). Two groups, placed by the
// panel:
//   · `ProposalMarkRows` — Mark and Note, directly UNDER Status: the mark beside
//     the finished status it holds.
//   · `ProposalSupersedesRows` — Supersedes / Superseded by, the LAST rows; for an
//     `add`, its one unsigned Supersedes row.
// Rows appear only for the mark fields this plan moves — each read off the
// envelope's `markChanges` (the same objects as the item's change rows) or its
// `supersedesRefs`, never re-derived. Every row is the shipped `QuickViewRailField`.

function rowOf(proposal: PlanProposalPeekDto, field: string): PlanItemChangeDto | undefined {
  return proposal.markChanges?.find((c) => c.field === field);
}

export function ProposalMarkRows({
  proposal,
  statusCategory,
  statusLabel,
  outcome,
}: {
  proposal: PlanProposalPeekDto;
  /** The target's live status — the one the mark holds (§24.4). */
  statusCategory: StatusCategoryDto | null;
  statusLabel: string;
  outcome: PlanItemOutcome | null;
}) {
  const t = useTranslations('planReview');
  const mark = rowOf(proposal, 'obsolescence');
  const note = rowOf(proposal, 'obsolescenceNote');
  const changed = <ChangedMark label={t('railChangedMark')} />;
  const setMark = mark && (mark.to === 'outdated' || mark.to === 'deprecated') ? mark.to : null;
  return (
    <>
      {mark ? (
        <QuickViewRailField label={t('field_obsolescence')} marker={changed}>
          <span className="flex min-w-0 flex-col items-start gap-1">
            {setMark ? (
              <ObsolescencePill mark={setMark} />
            ) : (
              // A CLEAR — the card will carry no mark: the value name, secondary.
              <span className="text-(--el-text-secondary)">{t('obsolescenceCurrent')}</span>
            )}
            {/* What the mark does to the card (§24.4) — not on a clear, and never on
                a decided plan, whose record tense forecasts nothing. */}
            {setMark && statusCategory === 'done' && outcome === null ? (
              <span data-testid="mark-holds-status" className="text-xs text-(--el-text-secondary)">
                {t('markHoldsStatus', { status: statusLabel })}
              </span>
            ) : null}
          </span>
        </QuickViewRailField>
      ) : null}
      {note ? (
        <QuickViewRailField label={t('field_obsolescenceNote')} marker={changed}>
          <MarkNoteValue note={note.to} />
        </QuickViewRailField>
      ) : null}
    </>
  );
}

/**
 * The WHOLE note (§24.6): `whitespace-pre-line`, clamped to three lines with a
 * *Show all* / *Show less* toggle when it is longer than that or than
 * {@link REASON_CLAMP_CHARS} — the shipped `RefusalReasonQuote` pattern. Verbatim,
 * never translated. A cleared note reads `—`.
 */
function MarkNoteValue({ note }: { note: string | null }) {
  const t = useTranslations('planReview');
  const [open, setOpen] = useState(false);
  const text = note?.trim() ?? '';
  if (!text) return <span className="text-(--el-text)">—</span>;
  const long = text.length > REASON_CLAMP_CHARS || text.split('\n').length > 3;
  if (!long) {
    return (
      <span data-testid="mark-note" className="whitespace-pre-line text-(--el-text)">
        {text}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <span
        data-testid="mark-note"
        className={`whitespace-pre-line text-(--el-text) ${open ? '' : 'line-clamp-3'}`}
      >
        {text}
      </span>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-xs font-medium text-(--el-link) underline hover:text-(--el-link-pressed)"
      >
        {open ? t('noteShowLess') : t('noteShowAll')}
      </button>
    </span>
  );
}

export function ProposalSupersedesRows({
  proposal,
  onOpenProposal,
}: {
  proposal: PlanProposalPeekDto;
  /** Opens the peek of a proposal a chip names (§24.7). */
  onOpenProposal?: (planItemId: string) => void;
}) {
  const t = useTranslations('planReview');
  const changed = <ChangedMark label={t('railChangedMark')} />;
  const open = onOpenProposal ? { onOpenProposal } : {};
  if (proposal.op === 'add') {
    const refs = proposal.supersedesRefs ?? [];
    if (refs.length === 0) return null;
    // An `add`'s row: last, unsigned, no `changed` mark (everything is proposed).
    return (
      <QuickViewRailField label={t('field_supersedes')}>
        <SupersedesChips added={refs} signed={false} layout="column" {...open} />
      </QuickViewRailField>
    );
  }
  return (
    <>
      {(['supersedes', 'supersededBy'] as const).map((field) => {
        const row = rowOf(proposal, field);
        if (!row?.refs) return null;
        return (
          <QuickViewRailField key={field} label={t(`field_${field}`)} marker={changed}>
            <SupersedesChips
              added={row.refs.added}
              removed={row.refs.removed}
              signed
              layout="column"
              {...open}
            />
          </QuickViewRailField>
        );
      })}
    </>
  );
}
