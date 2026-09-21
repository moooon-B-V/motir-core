'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, LoaderCircle } from 'lucide-react';
import { DecisionWaitingMarker } from '@/components/approvals/DecisionWaitingMarker';
import type { PendingDecisionDTO } from '@/lib/dto/approvalGate';
import { LATE_FALLBACK_ATTR } from './decisionAnchor';

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

function land(el: HTMLElement) {
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
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
  const [pending, setPending] = useState(false);
  const observer = useRef<MutationObserver | null>(null);

  const stopWaiting = useCallback(() => {
    observer.current?.disconnect();
    observer.current = null;
    setPending(false);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  const noun = t(`statusHeld.decisionNoun.${decision.kind}`);
  const name = routedToName ?? t('theAssignee');
  const sentence =
    decision.state === 'yours'
      ? t('waiting.glyphYours', { decision: noun })
      : t('waiting.glyphOn', { name, decision: noun });
  const jump = t('waiting.jump', { decision: noun });

  const onPress = () => {
    const anchor = anchorFor(decision.kind);
    if (anchor) {
      land(anchor);
      return;
    }
    // Not streamed yet. Nothing to wait FOR once the late stack has settled.
    const fallback = document.querySelector<HTMLElement>(`[${LATE_FALLBACK_ATTR}]`);
    if (!fallback) return;
    fallback.scrollIntoView({ block: 'start' });
    setPending(true);
    observer.current?.disconnect();
    observer.current = new MutationObserver(() => {
      const mounted = anchorFor(decision.kind);
      if (mounted) {
        stopWaiting();
        land(mounted);
      } else if (!document.querySelector(`[${LATE_FALLBACK_ATTR}]`)) {
        // The stack settled and drew no section for this kind — stay put.
        stopWaiting();
      }
    });
    observer.current.observe(document.body, { childList: true, subtree: true });
  };

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
