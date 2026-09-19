'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Check, CircleAlert, CircleCheck, Clock, Settings, Sparkles, VideoOff } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import {
  AcceptanceReceiptPlayer,
  AcceptanceReceiptProvenance,
} from '@/components/acceptance/AcceptanceReceiptPlayer';
import { Switch } from '@/components/ui/Switch';
import { Pill } from '@/components/ui/Pill';
import { BILLING_PLANS_PATH } from '@/components/ai/AiPaywall';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';
import type { AcceptanceVideoEligibilityDTO } from '@/lib/dto/acceptanceVideoEligibility';
import { turnOnAcceptanceVideoAction } from '@/app/(authed)/items/[key]/acceptanceActions';
import { ApprovalGateControl } from '@/components/approvals/ApprovalGateControl';
import { GateCallToActionBand } from '@/components/approvals/GateCallToActionBand';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// The acceptance panel body (Story MOTIR-1627 · Subtask MOTIR-1634), built to
// design/work-items/acceptance-panel.png. Rendered inside a ContentSectionCard
// on a story detail page. Branches on the MOTIR-1630 eligibility into the three
// states; State A shows the chaptered player + the gate (Approve / Request
// changes). Colour via --el-*, shape via element-semantic tokens; primitives are
// Button / Switch / Pill. On a successful gate decision the caller's status pill
// (server-rendered) refreshes; the panel's own optimistic state is NOT refreshed
// (the page-state inline-edit rule).

export interface AcceptancePanelProps {
  workItemId: string;
  /** The card whose page this panel is on — the path BOTH of this panel's
   *  actions revalidate on success (Bug MOTIR-5160 for `decide`, Bug MOTIR-5196
   *  for `turnOn`). Each action knows an id of its own — a work item, a
   *  project — and neither is the path; the path is the card's IDENTIFIER,
   *  and `LateSections` already holds it. */
  itemIdentifier: string;
  /** The STORY'S project — whose switch Turn on flips (MOTIR-5172). It was the
   *  organisation's id while the switch was an org column. */
  projectId: string;
  eligibility: AcceptanceVideoEligibilityDTO;
  initialEvidence: AcceptanceEvidenceDTO | null;
  /**
   * The story's `acceptance_result` gate in whatever state, or null (MOTIR-4950).
   *
   * ⚠️ THIS PANEL DOES NOT DECIDE IT (Story MOTIR-4949 · Subtask MOTIR-5790; § *The
   * item page HANDS THE DECISION OVER*, MOTIR-5228). An awaiting question this
   * reader may answer renders the shared call-to-action band, which opens the
   * approval overlay; the overlay is the one place a `GateDecision` is submitted.
   */
  gate: ApprovalGateDTO | null;
  /** The gate read's AUTHORITY answer — never re-derived here. */
  canDecide: boolean;
  /** Who the gate is routed to, when that is not this reader. */
  routedElsewhereName: string | null;
}

/**
 * Where the switch LIVES — both of State B's links land here (MOTIR-5172).
 *
 * ⚠️ NOT A PROP ANY MORE, AND NOT `/settings/organization`. The href used to be
 * passed in as `settingsHref="/settings/organization"` with `#acceptance-video`
 * appended here, and when the switch moved to the project tier the org page
 * stopped holding the control — so the link still LOOKED like it worked. A link to
 * a page the setting has left is worse than no link. The target is one fixed room,
 * so it is a constant beside the panel rather than a string every caller can get
 * wrong, and the anchor names the element the room renders
 * (`AcceptanceVideoGateCard`'s `id`), which `tests/e2e/cloud-video.spec.ts`
 * follows to a rendered switch.
 */
export const ACCEPTANCE_VIDEO_SETTINGS_HREF = '/settings/project/approvals#acceptance-video';

/** The frame's `onDecide` slot is required, and on this page nothing can call it: the
 *  verb set is empty and the decision was handed to the overlay (MOTIR-5790). It answers
 *  nothing rather than pretending to decide — `DesignResultSection`'s own slot, verbatim.
 *
 *  ⚠️ UNREACHABLE BY CONSTRUCTION, SO ITS COVERAGE IS AN IGNORE THAT NAMES ITS INVARIANT:
 *  no approve and no request-changes control exists in this section for ANY gate state ×
 *  `canDecide`, which `tests/components/acceptance-panel.test.tsx` asserts. A test that
 *  could call this would be a test that found a verb. */
/* v8 ignore next 3 */
async function noDecisionHere(): Promise<null> {
  return null;
}

export function AcceptancePanel({
  itemIdentifier,
  projectId,
  eligibility,
  initialEvidence,
  gate,
  canDecide,
  routedElsewhereName,
}: AcceptancePanelProps) {
  const t = useTranslations('acceptance');
  const tGate = useTranslations('approvalGate.acceptanceResult');
  const router = useRouter();
  // The receipt as the server rendered it — the panel no longer changes it (MOTIR-5790).
  const evidence = initialEvidence;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function turnOn() {
    setError(null);
    startTransition(async () => {
      const res = await turnOnAcceptanceVideoAction({ projectId, itemIdentifier });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // ⚠️ KEPT DELIBERATELY, BESIDE THE ACTION'S OWN `revalidatePath` (Bug
      // MOTIR-5196) — the same disposition `decide` above carries. Both halves
      // ship: the action puts the fresh tree on its own response where nothing
      // can race it, and this reaches the surfaces a server tree does not cover.
      // Removing it is a SEPARATE claim nobody has shipped against, and it is
      // not what the residual ~1-in-16 failure was about: that was the vendored
      // React dropping a Suspense ping mid-render (MOTIR-5255 —
      // `patches/next@16.2.6.patch`), and deleting this line measured the SAME
      // 2/24 red as keeping it.
      //
      // ⚠️ AND A COMMITTED STATE UPDATE HERE IS NOT THE REMEDY — it was TRIED.
      // `decide` above calls `setEvidence` before its refresh and never flakes,
      // so an empty transition looked like the cause; adding a state commit in
      // front of this line measured 6/16 red rather than 0/16. The hypothesis is
      // recorded as FALSIFIED so nobody spends the run again.
      router.refresh();
    });
  }

  // ── State C · no paid plan → the upsell ────────────────────────────────────
  if (eligibility.applicable && eligibility.reason === 'no_plan') {
    return (
      <div className="flex gap-3.5 rounded-(--radius-input) bg-(--el-tint-lavender) p-4">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-(--radius-control) bg-(--el-page-bg)">
          <Sparkles className="h-[18px] w-[18px] text-(--el-accent-on-surface)" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-(--el-text)">{t('upsell.title')}</h3>
          <p className="mt-0.5 mb-3 text-[13px] leading-snug text-(--el-text-secondary)">
            {t('upsell.body')}
          </p>
          <div className="flex items-center gap-3">
            {eligibility.canManageBilling ? (
              <Link
                href={BILLING_PLANS_PATH}
                className={buttonVariants({ variant: 'primary', size: 'sm' })}
              >
                {t('upsell.upgrade')}
              </Link>
            ) : (
              <span className="text-[13px] text-(--el-text-secondary)">{t('upsell.askOwner')}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── State B · toggle off ───────────────────────────────────────────────────
  if (eligibility.applicable && eligibility.reason === 'toggle_off') {
    return (
      <div className="flex gap-3.5 rounded-(--radius-input) border border-(--el-border-soft) bg-(--el-surface-soft) p-4">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-(--radius-control) bg-(--el-muted)">
          <VideoOff className="h-[18px] w-[18px] text-(--el-text-muted)" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-(--el-text)">{t('off.title')}</h3>
          {eligibility.canManageToggle ? (
            <>
              <p className="mt-0.5 mb-3 text-[13px] leading-snug text-(--el-text-secondary)">
                {t('off.adminBody')}
              </p>
              <div className="flex items-center gap-2.5">
                <Switch
                  checked={false}
                  onCheckedChange={turnOn}
                  disabled={pending}
                  aria-label={t('off.turnOn')}
                />
                <span className="text-[13px] font-semibold text-(--el-text)">
                  {t('off.turnOn')}
                </span>
                <Link
                  href={ACCEPTANCE_VIDEO_SETTINGS_HREF}
                  className="ml-2 text-[13px] font-semibold text-(--el-link) hover:text-(--el-link-pressed)"
                >
                  {t('off.goToSettings')}
                </Link>
              </div>
            </>
          ) : (
            <>
              <p className="mt-0.5 mb-3 text-[13px] leading-snug text-(--el-text-secondary)">
                {t('off.memberBody')}
              </p>
              <Link
                href={ACCEPTANCE_VIDEO_SETTINGS_HREF}
                className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-(--el-link) hover:text-(--el-link-pressed)"
              >
                <Settings className="h-[13px] w-[13px]" aria-hidden />
                {t('off.viewSettings')}
              </Link>
            </>
          )}
        </div>
        {error ? <p className="sr-only">{error}</p> : null}
      </div>
    );
  }

  // ── State A · eligible (or ungated) ────────────────────────────────────────
  if (!evidence) {
    // Pending — in_review, no video yet.
    return (
      <div className="rounded-(--radius-input) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) px-4 py-7 text-center">
        <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-(--el-tint-sky)">
          <Clock className="h-5 w-5 text-(--el-info)" aria-hidden />
        </span>
        <h3 className="text-sm font-semibold text-(--el-text)">{t('pending.title')}</h3>
        <p className="mx-auto mt-1 max-w-[340px] text-[13px] leading-normal text-(--el-text-secondary)">
          {t('pending.body')}
        </p>
      </div>
    );
  }

  const approved = evidence.status === 'approved';
  const subjectMeta = gate?.subjectVersion
    ? tGate('meta.withVersion', { version: gate.subjectVersion.slice(0, 8) })
    : tGate('meta.plain');

  // BAND 2's SUBJECT — the recording, as every surface that shows it renders it.
  const port = (
    <div>
      <AcceptanceReceiptPlayer evidence={evidence} />
      <div className="mt-3.5 mb-3 flex flex-wrap items-center gap-2 text-[13px] text-(--el-text-secondary)">
        <CircleCheck className="h-[15px] w-[15px] text-(--el-success)" aria-hidden />
        <span>
          {approved
            ? t('approvedBy', { name: evidence.approvedById ?? '' })
            : t('summary.recorded')}
        </span>
      </div>
      <AcceptanceReceiptProvenance evidence={evidence} />
    </div>
  );

  // ⚠️ A DECIDED QUESTION IS DRAWN BY THE SHARED FRAME, NOT BY A PILL OF OUR OWN
  // (Story MOTIR-4949 · Subtask MOTIR-5792; the ONE-CONTROL rule, MOTIR-4796, which
  // `tests/approval-gate-one-language.test.ts` derives rather than lists).
  //
  // MOTIR-5790 handed the DECISION over to the overlay and left the panel drawing the
  // decided states itself — a success Pill off `evidence.status`, a warning Pill for a
  // send-back. That is a second language for the one act the frame exists to speak: it
  // says *approved* without saying by whom, against which recording, or when, and it
  // drifts from every other kind the moment the frame gains a band. So the frame draws
  // every state the band does not: the record, who it waits on when the reader may not
  // press (state `B`), and a withdrawal. The verbs stay EMPTY here — this surface has
  // handed them over, and `canDecide` is passed for what it SAYS, not what it enables,
  // exactly as `DesignResultSection` passes it.
  if (gate && !(gate.state === 'awaiting' && canDecide)) {
    return (
      <>
        <ApprovalGateControl
          // FLUSH IN THE SECTION: `ContentSectionCard` already carries the border and
          // the title *Acceptance*. One container, one label.
          layout="section"
          gate={gate}
          canDecide={canDecide}
          kindLabel={tGate('kindLabel')}
          subjectMeta={subjectMeta}
          port={port}
          verbs={[]}
          consequence={tGate('consequence', { key: itemIdentifier })}
          confirmConsequences={[]}
          routedToLabel={routedElsewhereName}
          onDecide={noDecisionHere}
        />
        {error ? <p className="mt-2 text-[13px] text-(--el-danger)">{error}</p> : null}
      </>
    );
  }

  return (
    <div>
      {port}

      {gate?.state === 'awaiting' && canDecide ? (
        // THE DOOR, NOT THE VERBS (MOTIR-5790): the question is answered in the
        // approval overlay, which renders this recording in the acceptance port.
        <div className="mt-4">
          <GateCallToActionBand
            kind="acceptance_result"
            subjectLabel={subjectMeta}
            askedAt={gate.createdAt}
            itemIdentifier={itemIdentifier}
            routedElsewhereName={routedElsewhereName}
          />
        </div>
      ) : // ⚠️ NO GATE AT ALL, so there is no decision to speak about — a receipt that
      // predates the kind, or one whose question has not been raised yet. The receipt's
      // OWN status is all there is to say, and saying it in a pill is not a second
      // approval language because no gate is being rendered.
      approved ? (
        <div className="mt-4">
          <Pill severity="success">
            <Check className="h-3 w-3" aria-hidden />
            {t('status.approved')}
          </Pill>
        </div>
      ) : evidence.status === 'changes_requested' ? (
        <div className="mt-4">
          <Pill severity="warning">
            <CircleAlert className="h-3 w-3" aria-hidden />
            {t('status.changesRequested')}
          </Pill>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-[13px] text-(--el-danger)">{error}</p> : null}
    </div>
  );
}
