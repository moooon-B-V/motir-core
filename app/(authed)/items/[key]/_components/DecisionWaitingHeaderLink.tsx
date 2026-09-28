'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, LoaderCircle } from 'lucide-react';
import { DecisionWaitingMarker } from '@/components/approvals/DecisionWaitingMarker';
import type { PendingDecisionDTO } from '@/lib/dto/approvalGate';
import { useLandOnLateSection } from './useLandOnLateSection';

// THE ITEM HEADER'S DECISION-WAITING MARKER (Story MOTIR-4908 · MOTIR-5878).
//
// Design: `design/work-items/decision-waiting.mock.html` panels 6–8, specified in
// `design/work-items/design-notes.md` § *The item header — where pressing it takes
// you*. It sits in the header EYEBROW, in the page's EARLY tier, so a reader who
// lands on a long page learns before scrolling that a decision is waiting — and on
// whom. Pressing it brings the section that holds the gate into view.
//
// ⚠️ A POINTER, NEVER A VERB. The page already has its ONE Review & approve door
// (the band, and the held notice's door beside the status control). This button
// carries the state's words and an `ArrowDown`, never `ScanEye`, never says
// Review & approve, and never writes the overlay address.
//
// ⚠️ THE DESTINATION FOLLOWS THE FRAME, NOT A MAP. Every section that draws a
// gate's frame carries `data-decision-anchor="<kind …>"` (`ContentSectionCard`);
// a design gate is drawn inside Development when the card has an open pull
// request, so a fixed kind→section table would point at the wrong card.
//
// ⚠️ THOSE SECTIONS ARE IN THE LATE TIER. Pressed before they stream in, the
// button scrolls to the late stack's fallback, shows a spinner, announces
// *Opening the {decision}…*, and lands ONCE when the anchor mounts. If the stack
// settles without one (the reader cannot see that section), it stops and stays.

function anchorFor(kind: PendingDecisionDTO['kind']): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-decision-anchor~="${kind}"]`);
}

export function DecisionWaitingHeaderLink({
  decision,
  routedToName,
}: {
  decision: PendingDecisionDTO;
  /** The routed person's name, resolved from the page's members; `null` falls back. */
  routedToName: string | null;
}) {
  const t = useTranslations('approvalGate');
  const find = useCallback(() => anchorFor(decision.kind), [decision.kind]);
  const { press: onPress, pending } = useLandOnLateSection(find);

  const noun = t(`statusHeld.decisionNoun.${decision.kind}`);
  const name = routedToName ?? t('theAssignee');
  const sentence =
    decision.state === 'yours'
      ? t('waiting.glyphYours', { decision: noun })
      : t('waiting.glyphOn', { name, decision: noun });
  const jump = t('waiting.jump', { decision: noun });

  return (
    <>
      <button
        type="button"
        onClick={onPress}
        aria-label={`${sentence}. ${jump}`}
        title={jump}
        aria-busy={pending || undefined}
        className="group inline-flex min-w-0 max-w-full shrink-0 cursor-pointer rounded-(--radius-badge) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        data-decision-header-marker=""
      >
        <DecisionWaitingMarker
          state={decision.state}
          kind={decision.kind}
          routedToName={routedToName}
          className="group-hover:border-(--el-border-strong)"
          trailing={
            pending ? (
              <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
            ) : (
              <ArrowDown className="h-3 w-3 shrink-0" aria-hidden />
            )
          }
        />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? t('waiting.opening', { decision: noun }) : ''}
      </span>
    </>
  );
}
