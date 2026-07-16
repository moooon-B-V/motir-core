'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  GitBranch,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/utils/cn';
import type {
  MigrateIndexStatusDto,
  MigrateOnboardingDto,
  MigrateOnboardingStepDto,
} from '@/lib/dto/migrateOnboarding';

// The migrate-onboarding wizard UI (Story 7.15 · MOTIR-934) — the stepped,
// resumable set-up shell. Designed by MOTIR-930 (`design/onboarding-migrate/`):
// required tier = Connect · Index, optional tier = Import work items, then a
// plan-now-or-later decision. A client island seeded from the Server
// Component's read of the state machine; it drives step transitions through
// the migrate API routes (advance / skip-import / index-status poll) — NEVER
// the service layer directly (the 4-layer rule).
//
// Conventions (MOTIR-930 design-notes + CLAUDE.md): ONLY `--el-*` colour +
// element-semantic shape tokens; rail states pair a marker + label + tint
// (finding #35, never colour-alone); the index progress region is `aria-live`;
// the rail + Back/Next + decision are keyboard-reachable.

const STEP_RANK: Record<MigrateOnboardingStepDto, number> = {
  connect: 0,
  index: 1,
  import: 2,
  audit_convention: 3,
  discovery: 4,
  generate: 5,
  review: 6,
  done: 7,
};

export interface MigrateWizardProps {
  initialRun: MigrateOnboardingDto | null;
  projectName: string;
  userInitial: string;
}

export function MigrateWizard({ initialRun, projectName, userInitial }: MigrateWizardProps) {
  const t = useTranslations('onboardingMigrate');
  const router = useRouter();
  const [run, setRun] = useState<MigrateOnboardingDto | null>(initialRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A completed run should have redirected server-side; guard the client too.
  useEffect(() => {
    if (run?.status === 'completed' || run?.step === 'done') router.push('/roadmap');
  }, [run, router]);

  /** POST a migrate route + apply the returned run (or surface the error). */
  const postRunRoute = useCallback(
    async (path: string): Promise<MigrateOnboardingDto | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(path, { method: 'POST' });
        if (res.status === 409) {
          // A run already exists (start) or the current step's exit condition is
          // unmet (advance) — reload to re-read the authoritative run state.
          router.refresh();
          return null;
        }
        if (!res.ok) throw new Error(`migrate route ${path} → ${res.status}`);
        return (await res.json()) as MigrateOnboardingDto;
      } catch {
        setError(t('common.error'));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [router, t],
  );

  const startRun = useCallback(() => {
    void postRunRoute('/api/onboarding/migrate').then((next) => {
      if (next) setRun(next);
    });
  }, [postRunRoute]);

  const advance = useCallback(() => {
    if (!run) return;
    void postRunRoute(`/api/onboarding/migrate/${run.id}/advance`).then((next) => {
      if (next) setRun(next);
    });
  }, [postRunRoute, run]);

  const skipImport = useCallback(() => {
    if (!run) return;
    void postRunRoute(`/api/onboarding/migrate/${run.id}/skip-import`).then((next) => {
      if (next) setRun(next);
    });
  }, [postRunRoute, run]);

  /** "Plan my project now" — advance past the silent audit_convention step
   *  (which kicks the per-repo convention derivation) then hand off to the
   *  universal PlanningWorkspace, which drives discovery / generate / review. */
  const planNow = useCallback(() => {
    if (!run) return;
    setBusy(true);
    void postRunRoute(`/api/onboarding/migrate/${run.id}/advance`).then((next) => {
      // Whether the advance landed on `discovery` or the run was already past
      // audit_convention, the planning workspace is the canonical next surface.
      void next;
      router.push('/onboarding/discovery');
    });
  }, [postRunRoute, router, run]);

  return (
    <div className="flex h-dvh flex-col bg-(--el-page)">
      <BrandBar
        flowName={t('brandBar.flowName')}
        userInitial={userInitial}
        planAiLabel={t('brandBar.planAi')}
        saveExitLabel={t('common.saveExit')}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[64rem] flex-col gap-6 px-6 py-8 md:flex-row md:gap-10">
          <Rail step={run?.step ?? null} />
          <section className="min-w-0 flex-1">
            {error ? (
              <p
                className="mb-4 flex items-center gap-2 rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-card-padding) py-3 text-sm text-(--el-text-strong)"
                role="alert"
              >
                <AlertCircle className="size-4 flex-none" aria-hidden />
                {error}
              </p>
            ) : null}
            {run === null ? (
              <StartPanel onStart={startRun} busy={busy} projectName={projectName} />
            ) : run.step === 'connect' ? (
              <ConnectPanel onAdvance={advance} busy={busy} />
            ) : run.step === 'index' ? (
              <IndexPanel runId={run.id} onAdvance={advance} busy={busy} />
            ) : run.step === 'import' ? (
              <ImportPanel onAdvance={advance} onSkip={skipImport} busy={busy} />
            ) : run.step === 'audit_convention' ? (
              <DecisionPanel onPlanNow={planNow} busy={busy} />
            ) : (
              <ResumePanel />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

// ── Brand bar ──────────────────────────────────────────────────────────────

function BrandBar({
  flowName,
  userInitial,
  planAiLabel,
  saveExitLabel,
}: {
  flowName: string;
  userInitial: string;
  planAiLabel: string;
  saveExitLabel: string;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-(--el-border) px-6 py-3.5">
      <span className="flex items-center gap-2 text-sm font-semibold text-(--el-text)">
        <span
          className="grid size-7 place-items-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
          aria-hidden
        >
          <Sparkles className="size-4" strokeWidth={2} />
        </span>
        Motir
      </span>
      <span className="text-sm text-(--el-text-muted)">·</span>
      <span className="text-sm text-(--el-text-secondary)">{flowName}</span>
      <span className="ml-auto flex items-center gap-2">
        <Link
          href="/onboarding/discovery"
          className={cn(
            buttonVariants({ variant: 'secondary', size: 'sm' }),
            'gap-1.5 text-(--el-accent-on-surface)',
          )}
        >
          <Sparkles className="size-3.5" strokeWidth={2.2} aria-hidden />
          {planAiLabel}
        </Link>
        <Link
          href="/roadmap"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'gap-1.5')}
        >
          {saveExitLabel}
        </Link>
        <span
          className="grid size-7 place-items-center rounded-full bg-(--el-tint-sky) text-xs font-semibold text-(--el-text-strong)"
          aria-hidden
        >
          {userInitial}
        </span>
      </span>
    </header>
  );
}

// ── Rail ───────────────────────────────────────────────────────────────────

function Rail({ step }: { step: MigrateOnboardingStepDto | null }) {
  const t = useTranslations('onboardingMigrate');
  const rank = step ? STEP_RANK[step] : -1;
  const stateOf = (stepRank: number) =>
    rank > stepRank ? 'done' : rank === stepRank ? 'current' : 'upcoming';

  return (
    <nav aria-label={t('rail.title')} className="w-full flex-none md:w-56 md:flex-shrink-0">
      <p className="text-sm font-semibold text-(--el-text)">{t('rail.title')}</p>
      <p className="mt-1 text-xs text-(--el-text-muted)">{t('rail.sub')}</p>

      <p className="mt-5 text-[0.7rem] font-semibold tracking-wide text-(--el-text-faint) uppercase">
        {t('rail.setUp')}
      </p>
      <ul className="mt-2 flex flex-row gap-2 md:flex-col md:gap-1">
        <RailStep label={t('rail.connect')} state={stateOf(0)} />
        <RailStep label={t('rail.index')} state={stateOf(1)} />
      </ul>

      <p className="mt-5 flex items-center gap-2 text-[0.7rem] font-semibold tracking-wide text-(--el-text-faint) uppercase">
        {t('rail.import')}
        <span className="rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-0.5 text-[0.65rem] text-(--el-text-secondary) normal-case">
          {t('rail.importOptional')}
        </span>
      </p>
      <ul className="mt-2 flex flex-row gap-2 md:flex-col md:gap-1">
        <RailStep
          label={t('rail.importStep')}
          state={rank > 2 ? 'done' : rank === 2 ? 'current' : 'optional'}
        />
      </ul>
    </nav>
  );
}

function RailStep({
  label,
  state,
}: {
  label: string;
  state: 'done' | 'current' | 'upcoming' | 'optional';
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-2 text-sm',
        state === 'current' &&
          'bg-(--el-surface) text-(--el-text) ring-1 ring-(--el-accent-on-surface)',
        state === 'done' && 'text-(--el-text-secondary)',
        state === 'upcoming' && 'text-(--el-text-muted)',
        state === 'optional' && 'text-(--el-text-muted)',
      )}
      aria-current={state === 'current' ? 'step' : undefined}
    >
      <span
        className={cn(
          'grid size-5 flex-none place-items-center rounded-full text-[0.7rem] font-semibold',
          state === 'done' && 'bg-(--el-tint-mint) text-(--el-text-strong)',
          state === 'current' && 'bg-(--el-accent) text-(--el-accent-text)',
          state === 'upcoming' && 'border border-(--el-border) text-(--el-text-muted)',
          state === 'optional' &&
            'border border-dashed border-(--el-border) text-(--el-text-muted)',
        )}
        aria-hidden
      >
        {state === 'done' ? (
          <Check className="size-3" strokeWidth={3} />
        ) : state === 'optional' ? (
          <Download className="size-3" />
        ) : null}
      </span>
      {label}
    </li>
  );
}

// ── Panels ─────────────────────────────────────────────────────────────────

function StepHead({ eyebrow, heading, body }: { eyebrow: string; heading: string; body: string }) {
  return (
    <div className="mb-5">
      <p className="text-xs font-semibold tracking-wide text-(--el-accent-on-surface) uppercase">
        {eyebrow}
      </p>
      <h2 className="mt-1.5 text-xl font-semibold text-(--el-text)">{heading}</h2>
      <p className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)">{body}</p>
    </div>
  );
}

function PanelFoot({
  onBack,
  nextLabel,
  onNext,
  nextDisabled,
  busy,
}: {
  onBack?: () => void;
  nextLabel: string;
  onNext: () => void;
  nextDisabled?: boolean;
  busy: boolean;
}) {
  const t = useTranslations('onboardingMigrate');
  return (
    <div className="mt-6 flex items-center gap-3">
      {onBack ? (
        <Button variant="secondary" size="md" onClick={onBack} disabled={busy}>
          <ArrowLeft className="size-4" aria-hidden />
          {t('common.back')}
        </Button>
      ) : null}
      <span className="flex-1" />
      <Button variant="primary" size="md" onClick={onNext} disabled={nextDisabled || busy}>
        {nextLabel}
        <ArrowRight className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

function StartPanel({
  onStart,
  busy,
  projectName,
}: {
  onStart: () => void;
  busy: boolean;
  projectName: string;
}) {
  const t = useTranslations('onboardingMigrate');
  return (
    <div>
      <StepHead eyebrow={t('start.eyebrow')} heading={t('start.heading')} body={t('start.body')} />
      <Card tint="lavender">
        <div className="flex items-center gap-3">
          <span
            className="grid size-9 flex-none place-items-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-text-strong)"
            aria-hidden
          >
            <GitBranch className="size-5" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-(--el-text)">{projectName}</p>
            <p className="text-xs text-(--el-text-muted)">{t('start.projectLine')}</p>
          </div>
          <Button variant="primary" size="md" onClick={onStart} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t('start.cta')}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ConnectPanel({ onAdvance, busy }: { onAdvance: () => void; busy: boolean }) {
  const t = useTranslations('onboardingMigrate');
  return (
    <div>
      <StepHead
        eyebrow={t('connect.eyebrow')}
        heading={t('connect.heading')}
        body={t('connect.body')}
      />
      <Card>
        <div className="flex flex-col gap-3">
          <Link
            href="/settings/workspace/github"
            className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'w-fit gap-2')}
          >
            <ExternalLink className="size-4" aria-hidden />
            {t('connect.cta')}
          </Link>
          <p className="text-xs text-(--el-text-muted)">{t('connect.gitlabNote')}</p>
        </div>
      </Card>
      <PanelFoot nextLabel={t('connect.next')} onNext={onAdvance} busy={busy} />
    </div>
  );
}

function IndexPanel({
  runId,
  onAdvance,
  busy,
}: {
  runId: string;
  onAdvance: () => void;
  busy: boolean;
}) {
  const t = useTranslations('onboardingMigrate');
  const [status, setStatus] = useState<MigrateIndexStatusDto | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Poll the index-status route while the run sits on the `index` step. The
  // region is aria-live so a screen reader announces progress; the poll stops
  // on unmount / when every repo is indexed.
  useEffect(() => {
    const poll = async () => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(`/api/onboarding/migrate/${runId}/index-status`, {
          signal: ctrl.signal,
        });
        if (res.ok) setStatus((await res.json()) as MigrateIndexStatusDto);
      } catch {
        // a transient fetch failure is fine — the next tick retries
      }
    };
    void poll();
    const interval = window.setInterval(poll, 3000);
    return () => {
      window.clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [runId]);

  const total = status?.total ?? 0;
  const done = status?.indexedCount ?? 0;
  const allIndexed = status?.allIndexed ?? false;
  const hasRunning = status?.hasRunning ?? false;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div aria-live="polite" aria-busy={hasRunning}>
      <StepHead eyebrow={t('index.eyebrow')} heading={t('index.heading')} body={t('index.body')} />

      <Card>
        <div className="flex items-center gap-3">
          {hasRunning && !allIndexed ? (
            <Loader2
              className="size-5 flex-none animate-spin text-(--el-accent-on-surface)"
              aria-hidden
            />
          ) : (
            <span
              className={cn(
                'grid size-5 flex-none place-items-center rounded-full text-(--el-text-strong)',
                allIndexed ? 'bg-(--el-tint-mint)' : 'bg-(--el-muted)',
              )}
              aria-hidden
            >
              {allIndexed ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-(--el-text)">
              {allIndexed ? t('index.completeTitle') : t('index.building')}
            </p>
            <p className="text-xs text-(--el-text-muted)">
              {total > 0 ? t('index.aggregate', { done, total }) : t('index.waiting')}
            </p>
          </div>
          <span className="rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
            {pct}%
          </span>
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-(--el-muted)">
          <div
            className="h-full rounded-full bg-(--el-accent) transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>

        {status && total > 0 ? (
          <>
            <p className="mt-4 mb-2 text-[0.7rem] font-semibold tracking-wide text-(--el-text-faint) uppercase">
              {t('index.perRepo')}
            </p>
            <ul className="flex flex-col gap-2">
              {status.repos.map((repo) => {
                const indexed = repo.status === 'indexed';
                const [owner, ...rest] = repo.repoRef.split('/');
                const name = rest.join('/') || repo.repoRef;
                return (
                  <li
                    key={repo.repoRef}
                    className="flex items-center gap-3 rounded-(--radius-control) border border-(--el-border-soft) px-(--spacing-control-x) py-2.5"
                  >
                    <GitBranch className="size-4 flex-none text-(--el-text-muted)" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-(--el-text)">
                        <span className="text-(--el-text-muted)">{owner}/</span>
                        {name}
                      </span>
                      <span className="block text-xs text-(--el-text-muted)">{repo.provider}</span>
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold',
                        indexed
                          ? 'bg-(--el-tint-mint) text-(--el-text-strong)'
                          : 'bg-(--el-muted) text-(--el-text-secondary)',
                      )}
                    >
                      {indexed ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
                      {indexed ? t('index.state.indexed') : t('index.state.queued')}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        {allIndexed ? (
          <p className="mt-4 text-xs text-(--el-text-muted)">{t('index.completeNote')}</p>
        ) : (
          <p className="mt-4 text-xs text-(--el-text-muted)">{t('index.callout')}</p>
        )}
      </Card>

      <PanelFoot
        nextLabel={t('index.next')}
        onNext={onAdvance}
        nextDisabled={!allIndexed}
        busy={busy}
      />
    </div>
  );
}

function ImportPanel({
  onAdvance,
  onSkip,
  busy,
}: {
  onAdvance: () => void;
  onSkip: () => void;
  busy: boolean;
}) {
  const t = useTranslations('onboardingMigrate');
  return (
    <div>
      <StepHead
        eyebrow={t('import.eyebrow')}
        heading={t('import.heading')}
        body={t('import.body')}
      />
      <Card>
        <div className="flex flex-col gap-4">
          <Link
            href="/onboarding/import"
            className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'w-fit gap-2')}
          >
            <ExternalLink className="size-4" aria-hidden />
            {t('import.cta')}
          </Link>
          <p className="text-xs text-(--el-text-muted)">{t('import.reconcile')}</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="md" onClick={onSkip} disabled={busy}>
              {t('import.skip')}
            </Button>
            <span className="flex-1" />
            <Button variant="secondary" size="md" onClick={onAdvance} disabled={busy}>
              {t('import.next')}
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function DecisionPanel({ onPlanNow, busy }: { onPlanNow: () => void; busy: boolean }) {
  const t = useTranslations('onboardingMigrate');
  return (
    <div>
      <StepHead
        eyebrow={t('decision.eyebrow')}
        heading={t('decision.heading')}
        body={t('decision.body')}
      />
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button variant="primary" size="lg" onClick={onPlanNow} disabled={busy} className="flex-1">
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-4" aria-hidden />
          )}
          {t('decision.planNow')}
        </Button>
        <Link
          href="/roadmap"
          className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'flex-1')}
        >
          {t('decision.finishLater')}
        </Link>
      </div>
    </div>
  );
}

function ResumePanel() {
  const t = useTranslations('onboardingMigrate');
  return (
    <div>
      <StepHead
        eyebrow={t('resume.eyebrow')}
        heading={t('resume.heading')}
        body={t('resume.body')}
      />
      <Link
        href="/onboarding/discovery"
        className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'gap-2')}
      >
        {t('resume.cta')}
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}
