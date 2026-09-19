'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Check,
  CircleAlert,
  CircleCheck,
  Clock,
  RotateCcw,
  Settings,
  Sparkles,
  VideoOff,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import {
  AcceptanceReceiptPlayer,
  AcceptanceReceiptProvenance,
} from '@/components/acceptance/AcceptanceReceiptPlayer';
import { Switch } from '@/components/ui/Switch';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { BILLING_PLANS_PATH } from '@/components/ai/AiPaywall';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';
import type { AcceptanceVideoEligibilityDTO } from '@/lib/dto/acceptanceVideoEligibility';
import { turnOnAcceptanceVideoAction } from '@/app/(authed)/items/[key]/acceptanceActions';
import { decideApprovalGateAction } from '@/app/(authed)/items/[key]/approvalGateActions';
import { useRefusalCopy } from '@/components/approvals/ApprovalGateControl';
import type { GateRefusal } from '@/lib/approvalGates/refusals';

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
   * The story's AWAITING `acceptance_result` gate — the question the verbs answer
   * (MOTIR-4950), or null when there is none. The verbs decide THIS gate through the
   * contract's one decide door; there is no acceptance-specific decide path any more.
   */
  gate: { id: string } | null;
  /** What the gate read handed this reader (MOTIR-5234) — pressed back with the
   *  decision, so a press against a recording that has since moved is refused. */
  stamp: string | null;
  /** The gate read's AUTHORITY answer — never re-derived here. */
  canDecide: boolean;
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

export function AcceptancePanel({
  itemIdentifier,
  projectId,
  eligibility,
  initialEvidence,
  gate,
  stamp,
  canDecide,
}: AcceptancePanelProps) {
  const t = useTranslations('acceptance');
  const router = useRouter();
  const { toast } = useToast();
  const [evidence, setEvidence] = useState(initialEvidence);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<GateRefusal | null>(null);

  function decide(decision: 'approve' | 'request_changes') {
    if (!gate) return;
    setError(null);
    setRefusal(null);
    startTransition(async () => {
      // THE CONTRACT'S DECIDE DOOR (MOTIR-4950) — the same action every other gate
      // kind is pressed through. The acceptance handler stamps the receipt and
      // writes whatever status the decision owns; the panel only reflects it.
      const res = await decideApprovalGateAction({
        gateId: gate.id,
        decision,
        identifier: itemIdentifier,
        stamp: stamp ?? '',
      });
      if (!res.ok) {
        setRefusal(res.refusal);
        return;
      }
      // Reconcile from the authoritative answer: the decision the door recorded is
      // the receipt's new status (the handler stamps exactly this).
      setEvidence((current) =>
        current
          ? {
              ...current,
              status: res.gate.state === 'approved' ? 'approved' : 'changes_requested',
            }
          : current,
      );
      // The story's status pill is server-rendered elsewhere on the page → refresh
      // THAT surface (never the panel's own optimistic state).
      //
      // ⚠️ KEPT DELIBERATELY, BESIDE THE ACTION'S OWN `revalidatePath` (Bug
      // MOTIR-5160). Both halves ship: the action puts the fresh tree on its own
      // response where nothing can race it, and this reaches the surfaces a
      // server tree does not cover. Removing it is a SEPARATE claim nobody has
      // tested — and on the design gate one tier over it was measured NECESSARY,
      // so it is not a line to tidy away. It is also what this card's guard
      // breaks to prove itself able to go red: deleting it fails both tests in
      // `tests/e2e/cloud-acceptance-repaint.spec.ts` at the status-rail
      // assertion (23.4 s / 22.7 s, measured 2026-09-11).
      router.refresh();
      toast({
        variant: 'success',
        title: decision === 'approve' ? t('toast.approved') : t('toast.changesRequested'),
      });
    });
  }

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
  return (
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

      <AcceptanceReceiptProvenance evidence={evidence} className="mb-4" />

      {approved ? (
        <Pill severity="success">
          <Check className="h-3 w-3" aria-hidden />
          {t('status.approved')}
        </Pill>
      ) : canDecide ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            leftIcon={<Check className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => decide('approve')}
            disabled={pending}
          >
            {t('actions.approve')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => decide('request_changes')}
            disabled={pending}
          >
            {t('actions.requestChanges')}
          </Button>
        </div>
      ) : evidence.status === 'changes_requested' ? (
        <Pill severity="warning">
          <CircleAlert className="h-3 w-3" aria-hidden />
          {t('status.changesRequested')}
        </Pill>
      ) : null}

      {refusal ? <RefusalLine refusal={refusal} /> : null}
      {error ? <p className="mt-2 text-[13px] text-(--el-danger)">{error}</p> : null}
    </div>
  );
}

/** A refused press, in the approval frame's own words (`useRefusalCopy`) — one
 *  vocabulary for every gate kind, never a second copy of it here. */
function RefusalLine({ refusal }: { refusal: GateRefusal }) {
  const { headline, nextAction } = useRefusalCopy(refusal);
  return (
    <p role="alert" className="mt-2 text-[13px] text-(--el-text-secondary)">
      <span className="font-semibold text-(--el-text)">{headline}</span> {nextAction}
    </p>
  );
}
