'use client';

import { useTranslations } from 'next-intl';
import { PlanningTargetChip } from '@/components/planning/PlanningTargetChip';
import type { IssueType } from '@/lib/issues/parentRules';
import type { PlanItemChangeDto, PlanRefChipDto } from '@/lib/dto/planReview';

// THE SUPERSEDES CHIP (Story MOTIR-6577 · MOTIR-6632; design
// `design/ai-planning/design-notes.md` Part XXIV §24.7) — one card a `supersedes`
// edge names, on the plan review's list row and the peek's rail. The second of the
// two named compositions Part XXIV introduces (the first is `ObsolescencePill`);
// MOTIR-6575's relationships panel composes it.
//
// It is the SHIPPED `PlanningTargetChip` (type icon · mono key in `--el-link` ·
// title), with no remove button. A PROPOSAL of this plan has no key, so its key
// slot reads `New` and it wears the `add` card's frame. A DELTA — a `modify`'s four
// lists — leads with `+` / `−` after a visually hidden *Adds* / *Removes*; a
// removed edge also strikes its title. An `add`'s own refs carry no sign.
//
// The chips are RESOLVED on the server (`planReviewService.refChipOf`), so nothing
// here decides which ref is a proposal.

const KNOWN_KINDS = new Set<IssueType>(['epic', 'story', 'task', 'bug', 'subtask']);
const issueTypeOf = (kind: string): IssueType =>
  KNOWN_KINDS.has(kind as IssueType) ? (kind as IssueType) : 'task';

export type SupersedesDelta = '+' | '−';

export function SupersedesChip({
  chip,
  delta,
  onOpenProposal,
}: {
  chip: PlanRefChipDto;
  /** The sign of a `modify`'s delta; absent on an `add`'s unsigned refs. */
  delta?: SupersedesDelta;
  /**
   * Opens the peek of the proposal a PROPOSED chip names (§24.7). Wired on the
   * peek's rail only — the list row already opens the peek and gains no second
   * control (§24.6, §24.15). Ignored for a committed chip.
   */
  onOpenProposal?: (planItemId: string) => void;
}) {
  const t = useTranslations('planReview');
  const target = {
    identifier: chip.identifier ?? '',
    title: chip.title,
    kind: issueTypeOf(chip.kind),
  };
  const body = (
    <PlanningTargetChip
      target={target}
      struck={delta === '−'}
      {...(chip.proposed ? { proposedWord: t('proposedCrumb') } : {})}
    />
  );
  const openable = chip.proposed && chip.planItemId && onOpenProposal;
  return (
    <span
      data-testid="supersedes-chip"
      data-ref={chip.proposed ? 'proposal' : 'committed'}
      data-delta={delta}
      className="inline-flex max-w-full min-w-0 items-center gap-1"
    >
      {delta ? (
        <>
          <span className="sr-only">{`${delta === '+' ? t('edgeAdds') : t('edgeRemoves')} `}</span>
          <span
            aria-hidden="true"
            className="w-2 shrink-0 text-center font-mono text-xs font-semibold text-(--el-text-secondary)"
          >
            {delta}
          </span>
        </>
      ) : null}
      {openable ? (
        <button
          type="button"
          data-testid="supersedes-chip-open"
          onClick={() => onOpenProposal(chip.planItemId!)}
          className="inline-flex max-w-full min-w-0 rounded-(--radius-control) text-left focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {body}
        </button>
      ) : (
        body
      )}
    </span>
  );
}

/** The list row's chip cap (§24.7): three chips, then `+N more`. */
export const LIST_CHIP_MAX = 3;

/**
 * A row of chips — a `modify`'s ADDED then REMOVED refs (signed), or an `add`'s
 * refs (unsigned).
 *
 * `wrap` is the list row: chips wrap, at most {@link LIST_CHIP_MAX}, then
 * `+N more`. `column` is the peek's rail: every chip, one per line, each
 * truncating its title.
 */
export function SupersedesChips({
  added,
  removed = [],
  signed,
  layout,
  onOpenProposal,
}: {
  added: readonly PlanRefChipDto[];
  removed?: readonly PlanRefChipDto[];
  signed: boolean;
  layout: 'wrap' | 'column';
  onOpenProposal?: (planItemId: string) => void;
}) {
  const t = useTranslations('planReview');
  const all: { chip: PlanRefChipDto; delta?: SupersedesDelta }[] = [
    ...added.map((chip) => (signed ? { chip, delta: '+' as const } : { chip })),
    ...removed.map((chip) => ({ chip, delta: '−' as const })),
  ];
  const shown = layout === 'wrap' ? all.slice(0, LIST_CHIP_MAX) : all;
  const more = all.length - shown.length;
  return (
    <span
      data-testid="supersedes-chips"
      className={
        layout === 'wrap'
          ? 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'
          : 'flex min-w-0 flex-col items-start gap-1'
      }
    >
      {shown.map(({ chip, delta }, i) => (
        <SupersedesChip
          key={`${delta ?? ''}${chip.planItemId ?? chip.identifier ?? ''}:${i}`}
          chip={chip}
          {...(delta ? { delta } : {})}
          {...(onOpenProposal ? { onOpenProposal } : {})}
        />
      ))}
      {more > 0 ? (
        <span className="shrink-0 text-(--el-text-secondary)">{t('moreChanges', { n: more })}</span>
      ) : null}
    </span>
  );
}

/**
 * A supersedes change row's `to` as WORDS, for the canvas card's one diff line
 * (§24.7): `+PROD-52 · +New · <title>` — a proposal named by the proposed word and
 * its title, never the temp-ref. Falls back to the server's own words when the row
 * carries no chips (an older server).
 */
export function supersedesWords(change: PlanItemChangeDto, proposedWord: string): string | null {
  if (!change.refs) return change.to;
  const word = (chip: PlanRefChipDto) =>
    chip.proposed ? `${proposedWord} · ${chip.title}` : (chip.identifier ?? chip.title);
  const parts = [
    ...change.refs.added.map((c) => `+${word(c)}`),
    ...change.refs.removed.map((c) => `−${word(c)}`),
  ];
  return parts.length > 0 ? parts.join(' · ') : change.to;
}
