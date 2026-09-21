'use client';

import { useTranslations } from 'next-intl';
import { Hourglass, Stamp } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { ApprovalGateKindDTO, PendingDecisionDTO } from '@/lib/dto/approvalGate';

// THE DECISION-WAITING MARKER (Story MOTIR-4908 · MOTIR-5877) — one component,
// TWO forms, mirroring `CiStateBadge`.
//
// Design: `design/work-items/decision-waiting.mock.html`, specified in
// `design/work-items/design-notes.md` § *The DECISION-WAITING MARKER*. The state
// comes from `approvalGatesService.pendingDecisionsFor` (MOTIR-5876); this
// component draws it and fetches nothing.
//
// ⚠️ LOUD AND QUIET DIFFER IN THREE WAYS, NEVER IN TEXT ALONE: the fill
// (`tone="awaiting"`'s yellow tint vs the neutral chip), the ink, and the glyph's
// SHAPE (`Stamp` vs `Hourglass`). The glyphs are `aria-hidden`; the words — or, in
// the glyph form, the accessible name — carry the meaning.
//
// ⚠️ A NAME THE CALLER CANNOT RESOLVE READS *this work item's assignee*. The routed
// person always exists (`reporter_id` is NOT NULL), but a surface's member list may
// not hold them; the approval frame draws the same fallback for the same case
// (`approvalGate.theAssignee`), so the two never name one person differently.

interface DecisionWaitingMarkerProps {
  state: PendingDecisionDTO['state'];
  kind: ApprovalGateKindDTO;
  /** The routed person's display name, or `null` when the caller cannot resolve it. */
  routedToName: string | null;
  /** `label` on a board card and the item header; `glyph` in a List / Tree status cell. */
  form?: 'label' | 'glyph';
  /** For the board card's `aria-describedby`, which the card's own label would otherwise hide. */
  id?: string;
}

export function DecisionWaitingMarker({
  state,
  kind,
  routedToName,
  form = 'label',
  id,
}: DecisionWaitingMarkerProps) {
  const t = useTranslations('approvalGate');
  const name = routedToName ?? t('theAssignee');
  const yours = state === 'yours';
  const words = yours ? t('state.awaitingYou') : t('waiting.on', { name });

  if (form === 'glyph') {
    const decision = t(`statusHeld.decisionNoun.${kind}`);
    const sentence = yours
      ? t('waiting.glyphYours', { decision })
      : t('waiting.glyphOn', { name, decision });
    // ⚠️ `shrink-0` is load-bearing, as on the CI glyph: the status cell is a flex
    // row, and a squeezed marker overlaps the status pill instead of the row
    // truncating. The loud glyph sits on a yellow disc; the quiet one is bare.
    return (
      <span
        id={id}
        className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center ${
          yours
            ? 'rounded-full bg-(--el-tint-yellow) text-(--el-text-strong)'
            : 'text-(--el-text-secondary)'
        }`}
        role="img"
        aria-label={sentence}
        title={sentence}
        data-decision-marker={state}
        data-decision-kind={kind}
      >
        {yours ? (
          <Stamp className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
      </span>
    );
  }

  // A long name truncates INSIDE the pill (`min-w-0 max-w-full` + a `truncate`
  // span) and the card's pill row wraps, the wrap the CI badge introduced.
  return (
    <Pill
      id={id}
      tone={yours ? 'awaiting' : 'neutral'}
      className="min-w-0 max-w-full shrink-0"
      data-decision-marker={state}
      data-decision-kind={kind}
    >
      {yours ? (
        <Stamp className="h-3 w-3 shrink-0" aria-hidden />
      ) : (
        <Hourglass className="h-3 w-3 shrink-0" aria-hidden />
      )}
      <span className="truncate">{words}</span>
    </Pill>
  );
}
