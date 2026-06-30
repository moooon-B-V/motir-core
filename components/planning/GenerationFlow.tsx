'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CreditCard, MessageSquare, RotateCcw, Square } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import { usePlanGeneration } from '@/lib/hooks/usePlanGeneration';

// The 7.4 generation ENTRY surface (Subtask 7.4.9 / MOTIR-1396) — mounted by the
// onboarding hand-off (MOTIR-1041) once the user triggers "Generate". It drives
// the whole generation lifecycle through `usePlanGeneration` and renders it:
//
//   • GENERATING (Panel C) — the live reveal: proposed `add` PlanItems appear PER
//     LEVEL on the canvas as the engine emits them, by REUSING the shipped
//     presentational `PlanReviewCanvas` (MOTIR-1194/847) fed the substrate poll —
//     it does NOT redraw the canvas or re-implement the review/approve controls
//     (#82). On success it HANDS OFF to the 847 review surface (`/plans/:id`).
//   • Terminal states (Panel D) — FAILED (retry), OUT-OF-CREDITS (top up — the
//     842/846 typed outcome, never a generic error), and EMPTY (no direction docs
//     → discovery). These live HERE, not on the 847 detail: `Plan.status` has no
//     `failed` state, so only the 7.4 entry (which owns the job + stream) can
//     surface them.
//
// Proposals are PlanItems, not work items — nothing here enters the ready-set /
// board / `motir next`; that happens only on approve (7.21), on the surface this
// hands off to.

export interface GenerationFlowProps {
  /** Leave the generation flow — back to the revisable pre-plan baseline / loop. */
  onExit: () => void;
}

const DISCOVERY_HREF = '/direction';
const TOP_UP_HREF = '/settings/organization/billing';

export function GenerationFlow({ onExit }: GenerationFlowProps) {
  const t = useTranslations('aiPlanning.generation');
  const router = useRouter();
  const { phase, planId, items, version, start, stop } = usePlanGeneration();

  // Auto-start when this surface mounts (the hand-off's "Generate" click is the
  // trigger that mounts it). `start()` is idempotent via the hook's own in-flight
  // guard (`abortRef`), which is what makes this StrictMode-safe: dev double-invoke
  // runs setup→cleanup(teardown aborts + clears `abortRef`)→setup, and the second
  // setup re-`start()`s cleanly. A `started`-once ref would BREAK that — after the
  // cleanup aborts the first request, the ref keeps the re-setup from restarting,
  // so generation never begins under StrictMode (`next dev`) while prod, which
  // never double-invokes, works. Relying on the in-flight guard fixes both.
  useEffect(() => {
    start();
  }, [start]);

  // SUCCESS → hand off to the 847 review surface (approve / decline live there).
  useEffect(() => {
    if (phase === 'planned' && planId) router.push(`/plans/${planId}`);
  }, [phase, planId, router]);

  // ── Terminal: out of credits (the 7.2 metering outcome) ──────────────────────
  if (phase === 'out_of_credits') {
    return (
      <TerminalShell ariaLabel={t('creditsTitle')}>
        <EmptyState
          icon={<CreditCard className="h-12 w-12" aria-hidden />}
          title={t('creditsTitle')}
          description={t('creditsBody')}
          action={
            <Link
              href={TOP_UP_HREF}
              className="inline-flex h-(--height-btn-md) items-center rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) text-sm font-semibold text-(--el-accent-text) hover:bg-(--el-accent-pressed) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {t('topUpCta')}
            </Link>
          }
        />
      </TerminalShell>
    );
  }

  // ── Terminal: generation failed (retry; the partial frontier is discardable) ──
  if (phase === 'failed') {
    return (
      <TerminalShell ariaLabel={t('failedTitle')}>
        <EmptyState
          icon={<AlertTriangle className="h-12 w-12" aria-hidden />}
          title={t('failedTitle')}
          description={t('failedBody')}
          action={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onExit}>
                {t('discardCta')}
              </Button>
              <Button variant="primary" leftIcon={<RotateCcw className="size-4" />} onClick={start}>
                {t('retryCta')}
              </Button>
            </div>
          }
        />
      </TerminalShell>
    );
  }

  // ── Terminal: empty (generation produced no proposals — no direction docs) ────
  if (phase === 'empty') {
    return (
      <TerminalShell ariaLabel={t('emptyTitle')}>
        <EmptyState
          icon={<MessageSquare className="h-12 w-12" aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
          action={
            <div className="flex items-center gap-2">
              <Link
                href={DISCOVERY_HREF}
                className="inline-flex h-(--height-btn-md) items-center gap-1.5 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x) text-sm font-medium text-(--el-text) hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <MessageSquare className="size-4" aria-hidden />
                {t('openDiscoveryCta')}
              </Link>
              <Button variant="primary" leftIcon={<RotateCcw className="size-4" />} onClick={start}>
                {t('retryCta')}
              </Button>
            </div>
          }
        />
      </TerminalShell>
    );
  }

  // ── Success hand-off (navigating to /plans/:id) ──────────────────────────────
  if (phase === 'planned') {
    return (
      <TerminalShell ariaLabel={t('redirecting')}>
        <div className="flex flex-col items-center gap-3 text-(--el-text-secondary)">
          <Spinner size="lg" />
          <p className="text-sm">{t('redirecting')}</p>
        </div>
      </TerminalShell>
    );
  }

  // ── Live generation (Panel C) — the streaming per-level reveal ────────────────
  return (
    <PlanningWorkspace
      className="h-full w-full"
      canvas={
        <div className="relative h-full min-h-0 w-full">
          {/* The generating chip — aria-live so a screen reader hears progress. */}
          <div
            role="status"
            aria-live="polite"
            className="absolute top-3 left-3 z-10 inline-flex items-center gap-2 rounded-(--radius-badge) border border-(--el-border) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-sm font-medium text-(--el-text) shadow-(--shadow-card)"
          >
            <Spinner size="sm" className="text-(--el-accent-on-surface)" />
            <span>
              {t('generatingTitle')}
              {items.length > 0 ? ` · ${t('generatingCount', { count: items.length })}` : ''}
            </span>
          </div>
          <PlanReviewCanvas items={items} version={version} ariaLabel={t('canvasAria')} />
        </div>
      }
      chat={
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex flex-none items-center gap-2 border-b border-(--el-border) px-4 py-3">
            <span className="size-2 shrink-0 rounded-full bg-(--el-info)" aria-hidden />
            <span className="text-sm font-semibold text-(--el-text)">{t('railTitle')}</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
            <p className="text-sm text-(--el-text-secondary)">{t('railLead')}</p>
            <div className="flex items-center gap-2 text-sm text-(--el-text-muted)">
              <Spinner size="sm" className="text-(--el-accent-on-surface)" />
              {t('proposingItems')}
            </div>
          </div>
          <div className="flex flex-none flex-col gap-2 border-t border-(--el-border) px-4 py-3">
            <Button
              variant="secondary"
              leftIcon={<Square className="size-4" />}
              onClick={() => {
                stop();
                onExit();
              }}
              className="justify-center"
            >
              {t('stopCta')}
            </Button>
            <span className="text-center text-xs text-(--el-text-muted)">{t('stopHint')}</span>
          </div>
        </div>
      }
    />
  );
}

/** The centred host the terminal (Panel D) + redirect states render in — the same
 *  full-bleed surface the generating workspace fills, so the transition is calm. */
function TerminalShell({ children, ariaLabel }: { children: React.ReactNode; ariaLabel: string }) {
  return (
    <section
      aria-label={ariaLabel}
      className="flex h-full min-h-0 w-full items-center justify-center bg-(--el-surface) px-6 py-10"
    >
      <div className="w-full max-w-[34rem]">{children}</div>
    </section>
  );
}
