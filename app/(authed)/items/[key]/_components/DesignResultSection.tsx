'use client';

import type { MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { ScanEye } from 'lucide-react';
import { ApprovalGateControl } from '@/components/approvals/ApprovalGateControl';
import { buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useDecidedGate } from '@/lib/approvals/decidedGates';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { DesignResultPanel } from './DesignResultPanel';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO, DesignGateSubjectDTO } from '@/lib/dto/designEvidence';

// THE DESIGN RESULT SECTION — the item page's view of a design card's result and
// of the `design_result` gate raised on it.
//
// ⚠️ IT DOES NOT DECIDE, AND IT USED TO (Story MOTIR-5215 · Subtask MOTIR-5229).
// Until this story the section composed the whole approval frame with its verbs
// and its confirm band, per the placement the design had recorded as *"the frame
// IS this section"*. That placement is SUPERSEDED by
// `design/work-items/design-notes.md` § *The item page HANDS THE DECISION OVER*
// (MOTIR-5228): a decision is made in ONE place, the approval overlay, and the
// page carries the invitation and the receipt. So this file renders one of
// three things, and nothing here can submit a `GateDecision`:
//
//   · NO GATE — the shipped `DesignResultPanel`, byte for byte as before.
//   · AWAITING, AND THE READER MAY DECIDE — the CALL-TO-ACTION BAND: the
//     version, how long it has waited, the state, and ONE control that opens
//     the overlay over this page.
//   · EVERY OTHER STATE (`B` see-but-not-decide, `E` approved, `F` changes
//     requested, `G` withdrawn) — the frame's content, FLUSH in the section
//     card (`layout="section"`, MOTIR-5569), with no verbs.
//
// ⚠️ NO LOCAL COPY OF THE GATE. The section used to seed `useState(gate)` and
// update it from its own decide call. Once the decision moved to the overlay that
// copy would be set once at mount and never follow the server again — the shape
// Bug MOTIR-5118 already shipped once. The section reads its `gate` PROP, and a
// decision the overlay announced for this gate (`useDecidedGate`, MOTIR-5570)
// fills the gap only while that prop still reads `awaiting`; the moment the
// server's render arrives, the prop wins.
//
// ⚠️ THE PANEL IS NOT DELETED — IT IS THE PORT'S CONTENTS in the kept states, and
// the overlay composes the same panel for the decision itself.

export interface DesignResultSectionProps {
  evidence: DesignEvidenceDTO | null;
  isDesignCard: boolean;
  /** The `design_result` gate WHATEVER its state, or null when the card has
   *  never had one. */
  gate: ApprovalGateDTO | null;
  canDecide: boolean;
  /**
   * The version a DECIDED gate was decided ABOUT, and whether its files were
   * kept (Subtask MOTIR-5033). Null while the gate is awaiting or withdrawn —
   * see the port note below for why those two are null for opposite reasons.
   */
  subject: DesignGateSubjectDTO | null;
  /** The card's `MOTIR-<n>` — the overlay's address names the card by it. */
  itemIdentifier: string;
  /**
   * WHOSE DECISION this is waiting on, named — the frame's state `B` line
   * (MOTIR-5191) and the band's routed-elsewhere sentence. Resolved by
   * `approvalGatesService.getForWorkItem`; null when the routing resolves to
   * nobody or to a user row that has gone.
   */
  routedToLabel: string | null;
  /**
   * Whether the gate is ROUTED to the reader looking at the page. Computed on
   * the server from the gate's `routedToId` and the session, never here. It
   * picks the band's sentence and nothing else: the door is the same either
   * way, because the door serves AUTHORITY (`canDecide`), not routing
   * (`docs/decisions/approval-gates.md` §2).
   */
  routedToViewer: boolean;
}

export function DesignResultSection({
  evidence,
  isDesignCard,
  gate,
  canDecide,
  subject,
  itemIdentifier,
  routedToLabel,
  routedToViewer,
}: DesignResultSectionProps) {
  const tDesign = useTranslations('approvalGate.designResult');

  // A decision made in the OVERLAY for this gate, while the server's render has
  // not yet caught up. A hook must run unconditionally, and no gate id is empty.
  const announced = useDecidedGate(gate?.id ?? '');
  const shown = gate?.state === 'awaiting' && announced ? announced.gate : gate;

  // ⚠️ WHICH BYTES THE PORT SHOWS IS DECIDED HERE, AND THE ANSWER IS NOT
  // ALWAYS `evidence` (MOTIR-5033; ADR §6c).
  //
  //   · AWAITING — the CURRENT design. That is the question being asked, and
  //     the gate's subject IS the current row while it is awaiting.
  //   · DECIDED — the version that was DECIDED ON, read from the gate's own
  //     subject by the server, so an approval is never rendered over whatever
  //     is current now.
  //   · WITHDRAWN — neither. The frame draws a DEAD port and ignores this prop.
  //
  // ⚠️ THE FALLBACK IS THE SUBJECT'S OWN ABSENCE, NOT THE CURRENT ROW. When a
  // decided version's bytes are gone — the ordinary outcome for one that was
  // sent back — the panel renders its own nothing-published state. Falling back
  // to `evidence` would put the CURRENT design under a decision never made
  // about it.
  //
  // ⚠️ BOTH READ THE **SERVER'S** GATE (`gate`), NEVER THE ANNOUNCED ONE.
  // `subject` is a server prop: while an announced decision is drawn it is
  // still null, and a port keyed on the announcement would blank the design.
  // Keyed on `gate` the port keeps showing the current row — which IS the row
  // that was just decided, since only the current design's gate can be — and
  // the server's render then swaps in its pinned answer with nothing changing.
  const decidedOnServer = gate?.state === 'approved' || gate?.state === 'changes_requested';
  const portEvidence = decidedOnServer ? (subject?.evidence ?? null) : evidence;

  if (!shown) return <DesignResultPanel evidence={evidence} isDesignCard={isDesignCard} />;

  if (shown.state === 'awaiting' && canDecide) {
    return (
      <CallToActionBand
        version={shown.subjectVersion}
        askedAt={shown.createdAt}
        itemIdentifier={itemIdentifier}
        routedElsewhereName={routedToViewer ? null : routedToLabel}
      />
    );
  }

  return (
    <ApprovalGateControl
      // FLUSH IN THE SECTION (MOTIR-5569): `ContentSectionCard` already carries
      // the border and the title *Design result*. One container, one label.
      layout="section"
      gate={shown}
      // ⚠️ `canDecide` IS PASSED THROUGH FOR WHAT IT SAYS, NOT FOR WHAT IT
      // ENABLES. Every state that reaches this frame is one the frame draws
      // without verbs — a decided or withdrawn gate is not pressable by anyone,
      // and an awaiting one reaches here only when this reader may NOT decide
      // (state `B`) — and the verb set is empty besides.
      canDecide={canDecide}
      kindLabel={tDesign('kindLabel')}
      subjectMeta={
        shown.subjectVersion
          ? tDesign('meta.withVersion', { version: shown.subjectVersion.slice(0, 8) })
          : tDesign('meta.plain')
      }
      port={<DesignResultPanel evidence={portEvidence} isDesignCard={isDesignCard} />}
      // ⚠️ NO VERBS ON THE ITEM PAGE. The overlay is the one place a
      // `GateDecision` is submitted from; `decideApprovalGateAction` is not
      // imported by this file, and `approval-overlay-story-gate.test.tsx` holds
      // that caller list to the overlay alone.
      verbs={[]}
      consequence={null}
      confirmConsequences={[]}
      routedToLabel={routedToLabel}
      // The `design_result` kind's answer to *were the files kept?* — the
      // server's `design_evidence.pinned_at`, or what the overlay's decide
      // response said until that render arrives (MOTIR-5265's in-browser half).
      filesKept={subject ? subject.filesKept : (announced?.filesKept ?? null)}
      onDecide={noDecisionHere}
    />
  );
}

/** The frame's `onDecide` slot is required, and on this page nothing can call it:
 *  the verb set is empty. It answers nothing rather than pretending to decide. */
async function noDecisionHere(): Promise<null> {
  return null;
}

/**
 * THE CALL-TO-ACTION BAND — `approval-cta.mock.html` panels 1, 2 and 5, flush in
 * the section card (`design-notes.md` § *Anatomy — the band, flush in the
 * section*). It takes primitives, not the gate: it shows a question and opens
 * the surface that answers it.
 */
function CallToActionBand({
  version,
  askedAt,
  itemIdentifier,
  routedElsewhereName,
}: {
  version: string | null;
  askedAt: string;
  itemIdentifier: string;
  /** The routed recipient's name, when that is somebody other than the reader. */
  routedElsewhereName: string | null;
}) {
  const t = useTranslations('approvalGate');
  const format = useFormatter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // THE DOOR — the current page with the overlay's address added, so the
  // overlay opens OVER this card and its close strips exactly the two
  // parameters it added (`lib/approvals/overlayAddress.ts`).
  const qs = searchParams.toString();
  const href = withApprovalOverlay(`${pathname}${qs ? `?${qs}` : ''}`, {
    itemKey: itemIdentifier,
    kind: 'design_result',
  });

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // A modifier or non-primary click keeps its native meaning (the address in a
    // new tab), which is why the href is real — the To-approve row's condition.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    // `shallowPush`, never `router.push`: the page underneath is already on
    // screen and the overlay reads its address client-side (CLAUDE.md § *URL
    // state the CLIENT reads*).
    shallowPush(href);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {/* `suppressHydrationWarning`: a relative time is measured against the
            clock of whichever side renders it, and a minute can tick between the
            server's render and hydration. */}
        <span className="text-xs text-(--el-text-secondary)" suppressHydrationWarning>
          {version
            ? t('designResult.meta.withVersion', { version: version.slice(0, 8) })
            : t('designResult.meta.plain')}
          {' · '}
          {t('cta.asked', { when: format.relativeTime(new Date(askedAt)) })}
        </span>
        <span className="ml-auto">
          <Pill tone="awaiting">{t('state.awaitingYou')}</Pill>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-(--el-border-soft) pt-3">
        <span className="text-[13px] text-(--el-text-secondary)">
          {routedElsewhereName
            ? t.rich('cta.bodyRoutedElsewhere', {
                name: routedElsewhereName,
                person: (chunks) => <span className="font-medium text-(--el-text)">{chunks}</span>,
              })
            : t('cta.body')}
        </span>
        <Link
          href={href}
          onClick={onClick}
          aria-haspopup="dialog"
          data-variant="primary"
          className={`${buttonVariants({ variant: 'primary', size: 'sm' })} md:ml-auto`}
        >
          <ScanEye className="h-3.5 w-3.5" aria-hidden />
          <span>{t('statusHeld.reviewAndApprove')}</span>
        </Link>
      </div>
    </div>
  );
}
