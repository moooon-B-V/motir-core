'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Check,
  CircleAlert,
  CircleCheck,
  Clock,
  ExternalLink,
  GitCommitHorizontal,
  RotateCcw,
  Settings,
  Sparkles,
  VideoOff,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { BILLING_PLANS_PATH } from '@/components/ai/AiPaywall';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';
import type { AcceptanceVideoEligibilityDTO } from '@/lib/dto/acceptanceVideoEligibility';
import {
  decideAcceptanceAction,
  turnOnAcceptanceVideoAction,
} from '@/app/(authed)/items/[key]/acceptanceActions';

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.5, 2] as const;

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
  organizationId: string | null;
  eligibility: AcceptanceVideoEligibilityDTO;
  initialEvidence: AcceptanceEvidenceDTO | null;
  /** The reviewer may act (edit permission) AND the story is in_review. */
  canDecide: boolean;
  settingsHref: string;
}

const SETTINGS_ANCHOR = '#acceptance-video';

export function AcceptancePanel({
  workItemId,
  organizationId,
  eligibility,
  initialEvidence,
  canDecide,
  settingsHref,
}: AcceptancePanelProps) {
  const t = useTranslations('acceptance');
  const router = useRouter();
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [evidence, setEvidence] = useState(initialEvidence);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);

  function decide(decision: 'approve' | 'request_changes') {
    setError(null);
    startTransition(async () => {
      const res = await decideAcceptanceAction(workItemId, decision);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEvidence(res.evidence); // reconcile from the authoritative response
      // The story's status pill is server-rendered elsewhere on the page → refresh
      // THAT surface (never the panel's own optimistic state).
      router.refresh();
      toast({
        variant: 'success',
        title: decision === 'approve' ? t('toast.approved') : t('toast.changesRequested'),
      });
    });
  }

  function turnOn() {
    if (!organizationId) return;
    setError(null);
    startTransition(async () => {
      const res = await turnOnAcceptanceVideoAction(organizationId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
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
                  href={settingsHref + SETTINGS_ANCHOR}
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
                href={settingsHref + SETTINGS_ANCHOR}
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
      <div className="overflow-hidden rounded-(--radius-input) border border-(--el-border)">
        {evidence.videoUrl ? (
          <video
            ref={videoRef}
            src={evidence.videoUrl}
            controls
            className="aspect-video w-full bg-black"
          />
        ) : null}
        <div className="flex items-center gap-1.5 px-3.5 pt-3">
          <span className="mr-0.5 text-[11px] leading-none text-(--el-text-faint)">
            {t('player.speed')}
          </span>
          {PLAYBACK_SPEEDS.map((rate) => (
            <button
              key={rate}
              type="button"
              onClick={() => {
                if (videoRef.current) videoRef.current.playbackRate = rate;
                setPlaybackRate(rate);
              }}
              aria-pressed={playbackRate === rate}
              aria-label={`${rate}×`}
              className={`rounded-(--radius-control) px-1.5 py-0.5 text-[11px] font-semibold leading-tight transition-colors ${playbackRate === rate ? 'bg-(--el-accent) text-(--el-accent-text)' : 'text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)'}`}
            >
              {rate}×
            </button>
          ))}
        </div>
        {evidence.chapters.length > 0 ? (
          <ul className="flex flex-col gap-0.5 p-3.5 pt-3">
            {evidence.chapters.map((c, i) => (
              <li key={`${c.tSeconds}-${i}`}>
                <button
                  type="button"
                  onClick={() => {
                    if (videoRef.current) videoRef.current.currentTime = c.tSeconds;
                  }}
                  className="flex w-full items-center gap-2.5 rounded-(--radius-control) px-2 py-1.5 text-left text-[13px] text-(--el-text) hover:bg-(--el-surface)"
                >
                  <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-(--el-tint-lavender) text-[10px] font-bold text-(--el-text-strong)">
                    {i + 1}
                  </span>
                  {c.label}
                  <span className="ml-auto font-mono text-xs text-(--el-text-muted)">
                    {formatTime(c.tSeconds)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mt-3.5 mb-3 flex flex-wrap items-center gap-2 text-[13px] text-(--el-text-secondary)">
        <CircleCheck className="h-[15px] w-[15px] text-(--el-success)" aria-hidden />
        <span>
          {approved
            ? t('approvedBy', { name: evidence.approvedById ?? '' })
            : t('summary.recorded')}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {evidence.commitSha ? (
          <span className="inline-flex items-center gap-1.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface) px-2 py-0.5 font-mono text-[11px] text-(--el-text-secondary)">
            <GitCommitHorizontal className="h-3 w-3 text-(--el-text-faint)" aria-hidden />
            {evidence.commitSha.slice(0, 7)}
          </span>
        ) : null}
        {evidence.ciRunUrl ? (
          <a
            href={evidence.ciRunUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface) px-2 py-0.5 font-mono text-[11px] text-(--el-link)"
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            {t('provenance.ciRun')}
          </a>
        ) : null}
        {evidence.traceUrl ? (
          <a
            href={evidence.traceUrl}
            className="inline-flex items-center gap-1.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface) px-2 py-0.5 font-mono text-[11px] text-(--el-link)"
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            {t('provenance.trace')}
          </a>
        ) : null}
        {evidence.producedByKey ? (
          <span className="inline-flex items-center rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface) px-2 py-0.5 font-mono text-[11px] text-(--el-text-secondary)">
            {evidence.producedByKey}
          </span>
        ) : null}
      </div>

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

      {error ? <p className="mt-2 text-[13px] text-(--el-danger)">{error}</p> : null}
    </div>
  );
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
