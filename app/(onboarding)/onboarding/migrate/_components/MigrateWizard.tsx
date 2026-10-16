'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Check,
  CheckCircle2,
  Download,
  GitBranch,
  ListChecks,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import {
  BAR_GHOST_HOVER,
  BAR_SECONDARY_HOVER,
  OnboardingHero,
  OnboardingWizardBar,
  OnboardingWorkBand,
  WarmButton as Button,
} from '@/components/onboarding/layout';
import { ConnectPanel } from './ConnectPanel';
import { Dots, IMPORT_SOURCE_NAME, IndexIndicator } from './IndexIndicator';
import { summariseIndex } from './indexSummary';
import { useMigrateIndexStatus } from './useMigrateIndexStatus';
import { StepHead } from './StepHead';
import { DiscoveryChatBubble } from '@/components/onboarding/DiscoveryChatRail';
import { setActiveProjectAction } from '@/app/(authed)/_project-actions';
import { cn } from '@/lib/utils/cn';
import { onboardingReturnHref } from '@/lib/planning/onboardingReturn';
import { HANDOFF_PARAM_NAMES } from '@/lib/planning/onboardingHandoff';
import { useDiscoveryChat } from '@/lib/hooks/useDiscoveryChat';
import { useOpenPlanOverlay } from '@/lib/hooks/useOpenPlanOverlay';
import { isMigrateOnboardingStep } from '@/lib/dto/migrateOnboarding';
import type {
  MigrateGeneratedPlanDto,
  MigrateIndexStatusDto,
  MigrateLatestImportDto,
  MigrateOnboardingDto,
  MigrateOnboardingStepDto,
} from '@/lib/dto/migrateOnboarding';
import {
  ImportWizard,
  type ImportWizardProps,
} from '@/app/(onboarding)/onboarding/import/_components/ImportWizard';

// The migrate-onboarding wizard UI (Story 7.15 · MOTIR-934) — the stepped,
// resumable set-up shell, on the onboarding vibe layout since MOTIR-8254
// (`design/onboarding-migrate/` § 2026-10-12 and its Revisions 1–6): the lockup
// bar, a hero (full on a run's first screen, compact after), and one work band
// holding the rail and the current step.
//
// ONE PAGE TO FINISH ONBOARDING (Revision 6), ENDING AT IMPORT (§ Revision A,
// MOTIR-8772). The wizard ends at the Import step with one primary action,
// Enter Motir, which never waits on the index or on an import: both keep going
// in the background. No plan is drafted here any more; the plan screens below
// (Decision, Resume, the questions step) are reached only by a run that was
// already parked on one of those steps before the change.
//
// A client island seeded from the Server Component's read of the state machine;
// it drives step transitions through the migrate API routes (start / advance /
// skip-import / connect-state / index-status / plan) — NEVER the service layer directly (the
// 4-layer rule).
//
// Conventions (CLAUDE.md): ONLY `--el-*` colour + element-semantic shape tokens;
// the one warm element on a screen is its primary button (`WarmButton`); rail
// states pair a marker + label (never colour alone); status regions are polite.

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

/** How often the drafting status re-asks the machine whether the plan is ready. */
const GENERATE_POLL_MS = 5000;

/** How often the Import step re-reads the run while an import runs, so the
 *  status line, the rail row and the chip follow it. */
const IMPORT_POLL_MS = 5000;

/** An import the run reports as still going. */
function importRunning(latest: MigrateLatestImportDto | null | undefined): boolean {
  return latest?.status === 'running';
}

export interface MigrateWizardProject {
  id: string;
  name: string;
  identifier: string;
}

/** What the inline importer needs from the server (the import page's own read). */
export type MigrateImporterSeed = Pick<
  ImportWizardProps,
  'project' | 'statuses' | 'connected' | 'existingImportId'
>;

export interface MigrateWizardProps {
  initialRun: MigrateOnboardingDto | null;
  projectName: string;
  userInitial: string;
  /** The workspace's projects, for Start's choice (Revision 4). */
  projects?: MigrateWizardProject[];
  /** The project the person has open — pre-selected on Start. */
  activeProjectId?: string;
  /** No run and only one project: start the run on arrival, no Start panel
   *  (Revision 3). */
  autoStart?: boolean;
  /** The inline importer's data; null when it could not be read. */
  importer?: MigrateImporterSeed | null;
  /** A vendor OAuth round trip just returned to the Import step. */
  justConnected?: ImportWizardProps['justConnected'];
}

type RunResult =
  | { kind: 'ok'; run: MigrateOnboardingDto }
  | { kind: 'conflict' }
  | { kind: 'failed' };

export function MigrateWizard({
  initialRun,
  projectName,
  userInitial,
  projects = [],
  activeProjectId,
  autoStart = false,
  importer = null,
  justConnected,
}: MigrateWizardProps) {
  const t = useTranslations('onboardingMigrate');
  const router = useRouter();
  // THE RETURN ADDRESS the hand-off wrote (MOTIR-4770), if this user came from
  // the plan window at all.
  const searchParams = useSearchParams();
  /** The kept set the hand-off wrote, validated against the machine's own enum. */
  const keptStepsFromQuery = useMemo(
    () =>
      (searchParams.get(HANDOFF_PARAM_NAMES.keptSteps) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(isMigrateOnboardingStep),
    [searchParams],
  );
  const [run, setRun] = useState<MigrateOnboardingDto | null>(initialRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // THE HERO RULE (Revision 3): full on a run's FIRST screen — Start, or Connect
  // when the run starts itself — and compact after any start, advance or skip.
  const [heroFull, setHeroFull] = useState(initialRun === null);
  // Revision 3: with one project, the run starts on arrival. Until it lands the
  // Connect step shows its Checking state; a failed start falls back to Start.
  const [autoStartFailed, setAutoStartFailed] = useState(false);
  // Revision 6, 6d: a run resumed at `discovery` first offers Continue planning.
  const [resumed, setResumed] = useState(initialRun?.step !== 'discovery');

  // A completed run should have redirected server-side; guard the client too.
  useEffect(() => {
    // ⚠️ BACK TO THE WINDOW THEY OPENED, when they came from one (MOTIR-4770).
    // A user sent here by a routing verdict was promised they would land back in
    // the plan window; landing them on the roadmap instead is a journey with no
    // end. `null` is somebody who reached the wizard by another door, and they
    // keep the destination they always had.
    if (run?.status === 'completed' || run?.step === 'done') {
      router.push(onboardingReturnHref(searchParams, 'completed') ?? '/roadmap');
    }
  }, [run, router, searchParams]);

  /** Re-read the run itself — the authoritative state after a 409. */
  const reread = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/onboarding/migrate/${id}`, { cache: 'no-store' });
      if (res.ok) setRun((await res.json()) as MigrateOnboardingDto);
    } catch {
      // the next action re-reads again
    }
  }, []);

  /** POST a migrate route + apply the returned run (or surface the error). */
  const postRunRoute = useCallback(
    async (path: string, body?: unknown): Promise<RunResult> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(path, {
          method: 'POST',
          ...(body
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        });
        if (res.status === 409) {
          // A run already exists (start) or the current step's exit condition is
          // unmet (advance). The run is a client island, so a refresh would not
          // reach it (CLAUDE.md, page state): re-read the run where there is one.
          if (run) await reread(run.id);
          else router.refresh();
          return { kind: 'conflict' };
        }
        if (!res.ok) throw new Error(`migrate route ${path} → ${res.status}`);
        const next = (await res.json()) as MigrateOnboardingDto;
        setRun(next);
        return { kind: 'ok', run: next };
      } catch {
        setError(t('common.error'));
        return { kind: 'failed' };
      } finally {
        setBusy(false);
      }
    },
    [reread, router, run, t],
  );

  const startRun = useCallback(
    async (opts: { arrival: boolean }) => {
      // THE PLANNER'S KEPT SET (MOTIR-4759), forwarded on the START call. It rides
      // the address the hand-off wrote (MOTIR-4769) and belongs to the run rather
      // than to this page: a user who reloads mid-journey must not have their step
      // set re-derived from whatever URL they happen to be on.
      const result = await postRunRoute('/api/onboarding/migrate', {
        keptSteps: keptStepsFromQuery,
      });
      if (result.kind === 'ok' && !opts.arrival) setHeroFull(false);
      return result;
    },
    [postRunRoute, keptStepsFromQuery],
  );

  // Revision 3: one project, no run → start on arrival (once, StrictMode-safe).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || initialRun !== null || autoStarted.current) return;
    autoStarted.current = true;
    void startRun({ arrival: true }).then((r) => {
      if (r.kind === 'failed') setAutoStartFailed(true);
    });
  }, [autoStart, initialRun, startRun]);

  /** Start for a picked project (Revision 4): switch to it first when it is not
   *  the open one, then start the run for it. */
  const startFor = useCallback(
    async (projectId: string) => {
      if (activeProjectId && projectId !== activeProjectId) {
        setBusy(true);
        try {
          await setActiveProjectAction(projectId);
        } catch {
          setBusy(false);
          setError(t('common.error'));
          return;
        }
      }
      await startRun({ arrival: false });
    },
    [activeProjectId, startRun, t],
  );

  const advance = useCallback(async (): Promise<RunResult> => {
    if (!run) return { kind: 'failed' };
    const result = await postRunRoute(`/api/onboarding/migrate/${run.id}/advance`);
    if (result.kind === 'ok') setHeroFull(false);
    return result;
  }, [postRunRoute, run]);

  /** ENTER MOTIR (§ Revision A): completes the run from wherever it stands at
   *  index or import; the completed-run redirect above takes it from there. */
  const enter = useCallback(() => {
    if (!run) return;
    void postRunRoute(`/api/onboarding/migrate/${run.id}/enter`).then((r) => {
      if (r.kind === 'ok') setHeroFull(false);
    });
  }, [postRunRoute, run]);

  const arriving = autoStart && run === null && !autoStartFailed;
  const saveExitHref = onboardingReturnHref(searchParams, 'abandoned') ?? '/roadmap';

  // ONE index read for the page (MOTIR-8771): the Index step and the bar's
  // indicator both render from it.
  const pastConnect = run !== null && run.step !== 'connect';
  const { status: indexStatus, refresh: refreshIndexStatus } = useMigrateIndexStatus(
    pastConnect ? run.id : null,
  );
  const showIndicator = run !== null && run.step !== 'connect' && run.step !== 'index';

  // A started import runs in the background (§ Revision A): while the run
  // reports one, re-read the run so its count and its end reach the page.
  const importing = run !== null && importRunning(run.latestImport);
  const runId = run?.id ?? null;
  useEffect(() => {
    if (!importing || !runId) return;
    const timer = setInterval(() => void reread(runId), IMPORT_POLL_MS);
    return () => clearInterval(timer);
  }, [importing, runId, reread]);

  const bar = (
    <OnboardingWizardBar flowName={t('brandBar.flowName')} userInitial={userInitial}>
      {showIndicator ? (
        <IndexIndicator
          runId={run.id}
          status={indexStatus}
          latestImport={run.latestImport}
          onRetried={refreshIndexStatus}
        />
      ) : null}
      <Link
        href="/onboarding/discovery"
        className={cn(
          buttonVariants({ variant: 'secondary', size: 'sm' }),
          'gap-1.5',
          BAR_SECONDARY_HOVER,
        )}
      >
        {t('brandBar.planAi')}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
      {/* ⚠️ ABANDONING IS NOT COMPLETING, and the difference is the whole of
          MOTIR-4770 AC3. Somebody who walks away goes back to the PAGE — with
          no workspace re-opening around them, because re-opening a window
          somebody deliberately left is the opposite failure to stranding them,
          and it is the easier one to write by accident. */}
      <Link
        href={saveExitHref}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), BAR_GHOST_HOVER)}
      >
        {t('common.saveExit')}
      </Link>
    </OnboardingWizardBar>
  );

  let panel: React.ReactNode;
  if (run === null) {
    panel = arriving ? (
      <ConnectPanel runId={null} onAdvance={advance} busy />
    ) : (
      <StartPanel
        projects={projects}
        activeProjectId={activeProjectId}
        projectName={projectName}
        onStart={startFor}
        busy={busy}
      />
    );
  } else if (run.step === 'connect') {
    panel = <ConnectPanel runId={run.id} onAdvance={advance} busy={busy} />;
  } else if (run.step === 'index') {
    panel = <IndexPanel status={indexStatus} onAdvance={advance} busy={busy} />;
  } else if (run.step === 'import') {
    panel = (
      <ImportPanel
        importer={importer}
        justConnected={justConnected}
        latestImport={run.latestImport}
        onEnter={enter}
        busy={busy}
      />
    );
  } else if (run.step === 'audit_convention') {
    panel = <DecisionPanel onPlanNow={() => void advance()} busy={busy} />;
  } else if (!resumed) {
    panel = <ResumePanel onResume={() => setResumed(true)} />;
  } else {
    panel = <QuestionsPanel run={run} projectName={projectName} onRun={setRun} onReread={reread} />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-(--el-page-bg)">
      <OnboardingHero
        bar={bar}
        compact={!heroFull}
        headline={t('hero.headline')}
        lede={t('hero.lede')}
      />
      <OnboardingWorkBand>
        <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-8 md:flex-row md:items-start md:gap-14">
          <Rail
            step={run?.step ?? (arriving ? 'connect' : null)}
            keptSteps={run?.keptSteps ?? []}
            indexStatus={indexStatus}
            latestImport={run?.latestImport ?? null}
          />
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
            {panel}
          </section>
        </div>
      </OnboardingWorkBand>
    </div>
  );
}

// ── Rail ───────────────────────────────────────────────────────────────────

/**
 * THE STEPS THIS RUN DID NOT KEEP (MOTIR-4759) — collapsed into one row that
 * NAMES them, in `design/onboarding-migrate/` Panel 6's treatment.
 *
 * ⚠️ COLLAPSED, NEVER DELETED. A step that silently vanishes reads as something
 * taken from the user, which is the confusion MOTIR-4755's Panel 5 exists to
 * prevent — and it gets WORSE with more steps, not better: somebody who came in
 * expecting a wizard and meets two rows has no way to tell whether Motir skipped
 * the rest or lost them.
 *
 * ⚠️ AND ONE ROW, NOT N SATISFIED ONES. Panel 5's single row is right for ONE
 * step; four of them beside one live step is a rail whose subject is what the
 * user did NOT do — the opposite of what a shorter set is for.
 *
 * Empty set ⇒ nothing collapses, and the rail is exactly the one that shipped.
 */
const STEP_LABEL_KEY = {
  connect: 'connect',
  index: 'index',
  import: 'importStep',
} as const satisfies Partial<Record<MigrateOnboardingStepDto, string>>;

/** The rail's steps. The questions step left with plan generation (§ Revision
 *  A): the wizard ends at Import, so it is neither shown nor collapsed. */
const RAIL_STEPS: readonly (keyof typeof STEP_LABEL_KEY)[] = ['connect', 'index', 'import'];

const RAIL_GROUP =
  'mt-5 mb-0 flex items-center gap-2 text-[0.7rem] font-semibold tracking-wide text-(--el-text-secondary) uppercase';

function Rail({
  step,
  keptSteps,
  indexStatus,
  latestImport,
}: {
  step: MigrateOnboardingStepDto | null;
  keptSteps: readonly MigrateOnboardingStepDto[];
  /** The wizard's one index read: past the Index step, an index still going
   *  makes Index a background row (§ Revision A). */
  indexStatus: MigrateIndexStatusDto | null;
  /** A running import makes Import work items a background row. */
  latestImport: MigrateLatestImportDto | null;
}) {
  const t = useTranslations('onboardingMigrate');
  const rank = step ? STEP_RANK[step] : -1;
  const stateOf = (stepRank: number) =>
    rank > stepRank ? 'done' : rank === stepRank ? 'current' : 'upcoming';
  const collapsed = keptSteps.length === 0 ? [] : RAIL_STEPS.filter((s) => !keptSteps.includes(s));
  const runs = (s: MigrateOnboardingStepDto) => keptSteps.length === 0 || keptSteps.includes(s);

  // BACKGROUND ROWS (§ Revision A): a job that keeps going after the person
  // moved on reads "In the background", never as the current step.
  const index = rank > STEP_RANK.index ? summariseIndex(indexStatus) : null;
  const indexBackground =
    index && index.state !== 'done'
      ? t('rail.background', {
          detail:
            index.state === 'failed'
              ? t('rail.backgroundFailed')
              : index.state === 'queued'
                ? t('rail.backgroundQueued')
                : t('rail.backgroundInProgress'),
        })
      : null;
  const importBackground =
    latestImport && importRunning(latestImport)
      ? t('rail.background', {
          detail: t('indexing.importProgress', { done: latestImport.processedCount }),
        })
      : null;

  return (
    <nav aria-label={t('rail.title')} className="w-full flex-none md:w-56">
      <p className="m-0 text-sm font-semibold text-(--el-text)">{t('rail.title')}</p>
      <p className="m-0 mt-1 text-xs text-(--el-text-secondary)">
        {collapsed.length > 0 ? t('rail.subShort') : t('rail.subtitle')}
      </p>

      {collapsed.length > 0 ? (
        <>
          <p className={RAIL_GROUP}>{t('rail.answeredGroup')}</p>
          <ul className="m-0 mt-2 list-none p-0">
            <li
              data-testid="migrate-rail-collapsed"
              className="flex items-start gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-2 text-sm text-(--el-text-secondary)"
            >
              {/* Panel 5's SATISFIED marker, verbatim: sky tint and a READ glyph,
                  because what happened is that something was read. Never the DONE
                  tick, which says the user did the step, and never the dash, which
                  says they pressed a control. */}
              <span
                className="grid size-5 flex-none place-items-center rounded-full border border-(--el-border) bg-(--el-tint-sky) text-(--el-text-strong)"
                aria-hidden
              >
                <BookOpenText className="size-3" />
              </span>
              <span>
                <span className="block font-semibold text-(--el-text-strong)">
                  {collapsed.map((s) => t(`rail.${STEP_LABEL_KEY[s]}`)).join(', ')}
                </span>
                <span className="mt-px block text-xs text-(--el-text-secondary)">
                  {t('rail.answeredMeta')}
                </span>
              </span>
            </li>
          </ul>
        </>
      ) : null}

      {runs('connect') || runs('index') ? (
        <>
          <p className={RAIL_GROUP}>{t('rail.setUp')}</p>
          <ul className="m-0 mt-2 flex list-none flex-row flex-wrap gap-2 p-0 md:flex-col md:gap-1">
            {runs('connect') ? <RailStep label={t('rail.connect')} state={stateOf(0)} /> : null}
            {runs('index') ? (
              indexBackground ? (
                <RailStep
                  label={t('rail.index')}
                  state="background"
                  meta={indexBackground}
                  failed={index?.state === 'failed'}
                />
              ) : (
                <RailStep label={t('rail.index')} state={stateOf(1)} />
              )
            ) : null}
          </ul>
        </>
      ) : null}

      {/* Revision 6: the rail reads in the order the person goes through it —
          Set up, then Import (optional), then Your direction. */}
      {runs('import') ? (
        <>
          <p className={RAIL_GROUP}>
            {t('rail.import')}
            <span className="rounded-(--radius-badge) bg-(--el-tint-yellow) px-(--spacing-chip-x) py-0.5 text-[0.65rem] font-semibold text-(--el-text-strong) normal-case">
              {t('rail.importOptional')}
            </span>
          </p>
          <ul className="m-0 mt-2 flex list-none flex-row flex-wrap gap-2 p-0 md:flex-col md:gap-1">
            {importBackground ? (
              <RailStep label={t('rail.importStep')} state="background" meta={importBackground} />
            ) : (
              <RailStep
                label={t('rail.importStep')}
                state={rank > 2 ? 'done' : rank === 2 ? 'current' : 'optional'}
              />
            )}
          </ul>
        </>
      ) : null}
    </nav>
  );
}

function RailStep({
  label,
  state,
  meta,
  failed = false,
}: {
  label: string;
  state: 'done' | 'current' | 'upcoming' | 'optional' | 'background';
  /** A background row's second line ("In the background · …"). */
  meta?: string;
  /** A background job that failed: its marker stops pulsing. */
  failed?: boolean;
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-2 text-sm',
        state === 'current' &&
          'bg-(--el-surface) text-(--el-text) ring-1 ring-(--el-accent-on-surface)',
        // Every non-current step takes the same ink: the CURRENT step is the
        // one that paints `--el-surface` under itself, and `--el-text-muted`
        // is 4.17:1 there (MOTIR-2477). The state is carried by the ring and
        // the marker below, not by three shades of grey.
        state !== 'current' && 'text-(--el-text-secondary)',
      )}
      aria-current={state === 'current' ? 'step' : undefined}
    >
      <span
        className={cn(
          'grid size-5 flex-none place-items-center rounded-full text-[0.7rem] font-semibold',
          state === 'done' && 'bg-(--el-tint-mint) text-(--el-text-strong)',
          // The one warm mark on the rail (Revision 5): the current marker.
          state === 'current' &&
            'bg-(--el-highlight) ring-4 ring-[color-mix(in_srgb,var(--el-highlight)_22%,transparent)]',
          state === 'upcoming' && 'border border-(--el-border) text-(--el-text-secondary)',
          state === 'optional' &&
            'border border-dashed border-(--el-border) text-(--el-text-secondary)',
          state === 'background' && 'border border-(--el-border)',
        )}
        aria-hidden
      >
        {state === 'done' ? (
          <Check className="size-3" strokeWidth={3} />
        ) : state === 'optional' ? (
          <Download className="size-3" />
        ) : state === 'background' ? (
          <span className="scale-75">
            <Dots pulsing={!failed} />
          </span>
        ) : null}
      </span>
      {meta ? (
        <span className="flex min-w-0 flex-col" data-rail-background="">
          <span className="text-(--el-text)">{label}</span>
          <span className="text-xs text-(--el-text-secondary)">{meta}</span>
        </span>
      ) : (
        label
      )}
    </li>
  );
}

// ── Panels ─────────────────────────────────────────────────────────────────

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
        <Button
          variant="secondary"
          size="md"
          onClick={onBack}
          disabled={busy}
          leftIcon={<ArrowLeft className="size-4" />}
        >
          {t('common.back')}
        </Button>
      ) : null}
      <span className="flex-1" />
      <Button
        variant="primary"
        size="md"
        onClick={onNext}
        disabled={nextDisabled || busy}
        rightIcon={<ArrowRight className="size-4" />}
      >
        {nextLabel}
      </Button>
    </div>
  );
}

const KEY_TILES = ['bg-(--el-tint-sky)', 'bg-(--el-tint-lavender)', 'bg-(--el-tint-mint)'] as const;

/**
 * Start — a CHOICE of project (Revision 4). It exists only when there is
 * something to choose (two or more projects; one project starts on arrival),
 * so it lists every project in the workspace with the open one pre-selected.
 */
function StartPanel({
  projects,
  activeProjectId,
  projectName,
  onStart,
  busy,
}: {
  projects: MigrateWizardProject[];
  activeProjectId?: string;
  projectName: string;
  onStart: (projectId: string) => void;
  busy: boolean;
}) {
  const t = useTranslations('onboardingMigrate');
  // Without a list (a failed read, an arrival fallback) the open project is the
  // only row — the choice still says which project the run is for.
  const rows: MigrateWizardProject[] =
    projects.length > 0
      ? projects
      : [{ id: activeProjectId ?? '', name: projectName, identifier: '' }];
  const [picked, setPicked] = useState(activeProjectId ?? rows[0]!.id);
  const pickedRow = rows.find((p) => p.id === picked) ?? rows[0]!;

  return (
    <div>
      <StepHead eyebrow={t('start.eyebrow')} heading={t('start.heading')} body={t('start.body')} />
      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="mb-3 p-0 text-sm font-semibold text-(--el-text)">
          {t('start.chooseLabel')}
        </legend>
        {rows.map((p, i) => {
          const selected = p.id === pickedRow.id;
          const current = p.id === activeProjectId;
          return (
            <label
              key={p.id || i}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-(--radius-card) border px-(--spacing-card-padding) py-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-(--focus-ring-color)',
                selected
                  ? 'border-(--el-accent-on-surface) bg-(--el-surface) ring-1 ring-(--el-accent-on-surface)'
                  : 'border-(--el-border) bg-(--el-page-bg) hover:border-(--el-border-strong)',
              )}
            >
              <input
                type="radio"
                name="migrate-project"
                value={p.id}
                checked={selected}
                onChange={() => setPicked(p.id)}
                className="size-4 flex-none"
              />
              <span
                aria-hidden
                className={cn(
                  'grid size-9 flex-none place-items-center rounded-(--radius-control) font-mono text-xs font-semibold text-(--el-text-strong)',
                  KEY_TILES[i % KEY_TILES.length],
                )}
              >
                {(p.identifier || p.name).slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-(--el-text)">
                  {p.name}
                </span>
                <span className="block text-xs text-(--el-text-secondary)">
                  {current ? t('start.currentMeta') : t('start.otherMeta')}
                </span>
              </span>
              {current ? (
                <span className="flex-none rounded-(--radius-badge) bg-(--el-tint-yellow) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
                  {t('start.current')}
                </span>
              ) : null}
            </label>
          );
        })}
      </fieldset>
      <div className="mt-6 flex">
        <Button
          variant="primary"
          size="md"
          onClick={() => onStart(pickedRow.id)}
          loading={busy}
          rightIcon={<ArrowRight className="size-4" />}
        >
          {t('start.ctaFor', { project: pickedRow.name })}
        </Button>
      </div>
    </div>
  );
}

function IndexPanel({
  status,
  onAdvance,
  busy,
}: {
  /** The wizard's one index read (`useMigrateIndexStatus`, MOTIR-8771). The
   *  region is aria-live so a screen reader announces progress. */
  status: MigrateIndexStatusDto | null;
  onAdvance: () => Promise<RunResult>;
  busy: boolean;
}) {
  const t = useTranslations('onboardingMigrate');

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
            <span aria-hidden className="flex-none text-(--el-highlight)">
              <Spinner size="sm" />
            </span>
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
            <p className="m-0 text-sm font-semibold text-(--el-text)">
              {allIndexed ? t('index.completeTitle') : t('index.building')}
            </p>
            <p className="m-0 text-xs text-(--el-text-secondary)">
              {total > 0 ? t('index.aggregate', { done, total }) : t('index.waiting')}
            </p>
          </div>
          <span className="rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
            {pct}%
          </span>
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-(--el-tint-yellow)">
          <div
            className="h-full rounded-full bg-(--el-progress-fill) transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>

        {status && total > 0 ? (
          <>
            <p className="mt-4 mb-2 text-[0.7rem] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
              {t('index.perRepo')}
            </p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {status.repos.map((repo) => {
                const indexed = repo.status === 'indexed';
                const [owner, ...rest] = repo.repoRef.split('/');
                const name = rest.join('/') || repo.repoRef;
                return (
                  <li
                    key={repo.repoRef}
                    className="flex items-center gap-3 rounded-(--radius-control) border border-(--el-border-soft) px-(--spacing-control-x) py-2.5"
                  >
                    <GitBranch
                      className="size-4 flex-none text-(--el-text-secondary)"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13px] text-(--el-text)">
                        <span className="text-(--el-text-secondary)">{owner}/</span>
                        {name}
                      </span>
                      <span className="block text-xs text-(--el-text-secondary)">
                        {repo.provider}
                      </span>
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

        <p className="m-0 mt-4 text-xs text-(--el-text-secondary)">
          {allIndexed ? t('index.completeNote') : t('index.callout')}
        </p>
      </Card>

      <PanelFoot
        nextLabel={t('index.next')}
        onNext={() => void onAdvance()}
        // NOT A STOP (MOTIR-8768): the run may leave the step once an index
        // exists in any state, so Next opens with the first repository listed,
        // indexed or not. The progress keeps going in the bar's chip.
        nextDisabled={total === 0}
        busy={busy}
      />
    </div>
  );
}

/**
 * Import — the importer IN the step (Revision 6, 4a–4f), and the end of the
 * wizard (§ Revision A, MOTIR-8772). One primary action under the sources,
 * Enter Motir, enabled whatever the index or an import is doing. A started
 * import runs in the background: a status line names it and the sources go
 * inert while it runs. A vendor OAuth round trip returns here
 * (`lib/import/oauthReturn.ts`).
 */
function ImportPanel({
  importer,
  justConnected,
  latestImport,
  onEnter,
  busy,
}: {
  importer: MigrateImporterSeed | null;
  justConnected?: ImportWizardProps['justConnected'];
  latestImport: MigrateLatestImportDto | null;
  onEnter: () => void;
  busy: boolean;
}) {
  const t = useTranslations('onboardingMigrate');
  const running = latestImport !== null && importRunning(latestImport);
  return (
    <div>
      <StepHead
        eyebrow={t('import.eyebrow')}
        heading={t('import.heading')}
        body={t('import.body')}
      />
      <Card>
        <div className="flex flex-col gap-4">
          {importer ? (
            <div
              data-testid="migrate-import-sources"
              aria-disabled={running || undefined}
              inert={running}
              className={cn(running && 'opacity-60')}
            >
              <ImportWizard
                project={importer.project}
                statuses={importer.statuses}
                connected={importer.connected}
                existingImportId={importer.existingImportId}
                justConnected={justConnected}
                embedded={{
                  continueLabel: t('import.continue'),
                  onContinue: onEnter,
                  busy,
                }}
              />
            </div>
          ) : null}
          {running ? (
            <div
              role="status"
              data-testid="migrate-import-running"
              className="flex items-start gap-2.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-tint-sky) px-(--spacing-control-x) py-2"
            >
              <span className="mt-1.5">
                <Dots pulsing />
              </span>
              <span className="flex flex-col">
                <span className="text-sm font-semibold text-(--el-text-strong)">
                  {t('import.running', {
                    source: IMPORT_SOURCE_NAME[latestImport.source] ?? latestImport.source,
                    done: latestImport.processedCount,
                  })}
                </span>
                <span className="text-xs text-(--el-text-strong)">{t('import.runningBody')}</span>
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-3 border-t border-(--el-border-soft) pt-3">
            <p className="m-0 flex-1 text-xs text-(--el-text-secondary)">{t('enter.hint')}</p>
            <Button
              variant="primary"
              size="md"
              onClick={onEnter}
              disabled={busy}
              aria-busy={busy || undefined}
              rightIcon={<ArrowRight className="size-4" />}
            >
              {t('enter.cta')}
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
        {/* Revision 6: Plan my project now advances to "A few questions" on
            THIS page; it no longer leaves for the discovery canvas. */}
        <Button
          variant="primary"
          size="lg"
          onClick={onPlanNow}
          loading={busy}
          rightIcon={<ArrowRight className="size-4" />}
          className="flex-1"
        >
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

/** 6d — planning was already under way: Continue planning resumes "A few
 *  questions" in place (Revision 6). */
function ResumePanel({ onResume }: { onResume: () => void }) {
  const t = useTranslations('onboardingMigrate');
  return (
    <div>
      <StepHead
        eyebrow={t('resume.eyebrow')}
        heading={t('resume.heading')}
        body={t('resume.body')}
      />
      <Button
        variant="primary"
        size="md"
        onClick={onResume}
        rightIcon={<ArrowRight className="size-4" />}
      >
        {t('resume.cta')}
      </Button>
    </div>
  );
}

type QuietAdvance =
  | { kind: 'ok'; run: MigrateOnboardingDto }
  | { kind: 'conflict' }
  | { kind: 'failed' };

/** Ask the machine to move on WITHOUT painting a busy state or an error: the
 *  questions step polls it, and an unmet exit (409) is the expected answer. */
async function quietAdvance(runId: string): Promise<QuietAdvance> {
  try {
    const res = await fetch(`/api/onboarding/migrate/${runId}/advance`, { method: 'POST' });
    if (res.status === 409) return { kind: 'conflict' };
    if (!res.ok) return { kind: 'failed' };
    return { kind: 'ok', run: (await res.json()) as MigrateOnboardingDto };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * "A few questions" (Revision 6, 6a–6c) — the step the rail has always named,
 * on this page. `discovery` is one conversation card over the discovery turn
 * API; `generate` is the drafting status; `review` is the ready card whose
 * Review your plan is the one exit at the end of onboarding.
 */
function QuestionsPanel({
  run,
  projectName,
  onRun,
  onReread,
}: {
  run: MigrateOnboardingDto;
  projectName: string;
  onRun: (run: MigrateOnboardingDto) => void;
  onReread: (id: string) => Promise<void>;
}) {
  const t = useTranslations('onboardingMigrate');
  return (
    <div>
      <StepHead
        eyebrow={t('questions.eyebrow')}
        heading={t('questions.heading')}
        body={t('questions.body')}
      />
      {run.step === 'discovery' ? (
        <DiscoveryCard run={run} onRun={onRun} onReread={onReread} />
      ) : run.step === 'generate' ? (
        <DraftingCard run={run} onRun={onRun} />
      ) : (
        <ReadyCard runId={run.id} projectName={projectName} />
      )}
    </div>
  );
}

/** 6a — the conversation. The machine's discovery step submits the opening,
 *  code-grounded turn itself; this card shows its reply first, then the turns. */
function DiscoveryCard({
  run,
  onRun,
  onReread,
}: {
  run: MigrateOnboardingDto;
  onRun: (run: MigrateOnboardingDto) => void;
  onReread: (id: string) => Promise<void>;
}) {
  const t = useTranslations('onboardingMigrate');
  // Ask the machine once on entry: it submits the opening turn (and records its
  // job) the first time, and answers 409 until the conversation drafts a doc.
  const kicked = useRef(false);
  const [kickFailed, setKickFailed] = useState(false);
  useEffect(() => {
    if (run.discoveryJobId || kicked.current) return;
    kicked.current = true;
    void quietAdvance(run.id).then((r) => {
      if (r.kind === 'ok') onRun(r.run);
      else if (r.kind === 'conflict') void onReread(run.id);
      else setKickFailed(true);
    });
  }, [run.id, run.discoveryJobId, onRun, onReread]);

  return (
    <Card>
      {run.discoveryJobId ? (
        <Conversation runId={run.id} jobId={run.discoveryJobId} onRun={onRun} />
      ) : kickFailed ? (
        <p role="alert" className="m-0 flex items-center gap-2 text-sm text-(--el-text-strong)">
          <AlertCircle className="size-4 flex-none" aria-hidden />
          {t('common.error')}
        </p>
      ) : (
        <p
          role="status"
          className="m-0 flex items-center gap-2.5 text-sm text-(--el-text-secondary)"
        >
          <span aria-hidden className="flex-none text-(--el-highlight)">
            <Spinner size="sm" />
          </span>
          {t('questions.heading')}
        </p>
      )}
    </Card>
  );
}

function Conversation({
  runId,
  jobId,
  onRun,
}: {
  runId: string;
  jobId: string;
  onRun: (run: MigrateOnboardingDto) => void;
}) {
  const chatT = useTranslations('onboarding.chat');
  const t = useTranslations('onboardingMigrate');
  const chat = useDiscoveryChat({ attachJobId: jobId });
  const { turns, working, isStreaming, pendingAsk, error, producedKinds } = chat.state;
  const [draft, setDraft] = useState('');

  // The conversation drafted its first direction doc: the machine's discovery
  // exit is met, so move on to drafting the plan — in place, once.
  const moved = useRef(false);
  useEffect(() => {
    if (producedKinds.length === 0 || isStreaming || moved.current) return;
    moved.current = true;
    void quietAdvance(runId).then((r) => {
      if (r.kind === 'ok') onRun(r.run);
      else moved.current = false;
    });
  }, [producedKinds.length, isStreaming, runId, onRun]);

  const answered = turns.filter((x) => x.role === 'user').length;
  const n = answered + 1;
  const total = Math.max(5, n);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || isStreaming) return;
    chat.send(text);
    setDraft('');
  }

  return (
    <div className="flex flex-col gap-4">
      <span className="w-fit rounded-(--radius-badge) bg-(--el-tint-yellow) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong) tabular-nums">
        {t('questions.progress', { n, total })}
      </span>
      <div role="log" aria-label={chatT('railLabel')} className="flex flex-col gap-3">
        {turns.map((turn) => (
          <DiscoveryChatBubble key={turn.id} turn={turn} />
        ))}
        {working || (isStreaming && turns[turns.length - 1]?.role !== 'assistant') ? (
          <p className="m-0 flex items-center gap-2 text-sm text-(--el-text-secondary)">
            <span aria-hidden className="flex-none text-(--el-highlight)">
              <Spinner size="sm" />
            </span>
            {working?.phase === 'drafting' ? chatT('drafting') : chatT('working')}
          </p>
        ) : null}
        {error ? (
          <div className="rounded-(--radius-card) bg-(--el-tint-rose) px-3 py-2 text-sm text-(--el-text-strong)">
            <p className="m-0">{chatT('errorBody')}</p>
            <button
              type="button"
              onClick={chat.dismissError}
              className="mt-1 font-medium text-(--el-link) underline-offset-2 hover:underline"
            >
              {chatT('dismiss')}
            </button>
          </div>
        ) : null}
      </div>
      {pendingAsk && !isStreaming ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            leftIcon={<ListChecks className="size-4" />}
            onClick={() => chat.decideValidateEarly(chatT('replies.proveDemand'))}
          >
            {chatT('proveDemandLabel')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => chat.decideValidateEarly(chatT('replies.buildItAll'))}
          >
            {chatT('buildItAllLabel')}
          </Button>
        </div>
      ) : null}
      <form
        onSubmit={submit}
        className="flex items-center gap-2 border-t border-(--el-border) pt-4"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={isStreaming}
          placeholder={chatT('composerPlaceholder')}
          aria-label={chatT('composerPlaceholder')}
          className="h-(--height-input) min-w-0 flex-1 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) text-sm text-(--el-text) placeholder:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60"
        />
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={isStreaming || draft.trim().length === 0}
        >
          {chatT('send')}
        </Button>
      </form>
    </div>
  );
}

/** 6b — the plan is being drafted. The machine's generate step starts the draft
 *  on its first ask and moves to `review` once the plan is no longer generating,
 *  so this card keeps asking until it does. */
function DraftingCard({
  run,
  onRun,
}: {
  run: MigrateOnboardingDto;
  onRun: (run: MigrateOnboardingDto) => void;
}) {
  const t = useTranslations('onboardingMigrate');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (failed) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      const r = await quietAdvance(run.id);
      if (stopped) return;
      if (r.kind === 'ok') {
        onRun(r.run);
        if (r.run.step === 'generate') timer = window.setTimeout(tick, GENERATE_POLL_MS);
      } else if (r.kind === 'conflict') {
        timer = window.setTimeout(tick, GENERATE_POLL_MS);
      } else {
        // Out of credits or the planner unreachable — a hard stop, said once.
        setFailed(true);
      }
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [run.id, failed, onRun]);

  if (failed) {
    return (
      <p
        role="alert"
        className="m-0 flex items-center gap-2 rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-card-padding) py-3 text-sm text-(--el-text-strong)"
      >
        <AlertCircle className="size-4 flex-none" aria-hidden />
        {t('common.error')}
      </p>
    );
  }

  const waitingOnCode = !run.codeGraphReady;
  return (
    <Card>
      <div className="flex flex-col gap-3" role="status" aria-busy="true">
        <p className="m-0 flex items-center gap-2.5 text-sm font-semibold text-(--el-text)">
          <span aria-hidden className="flex-none text-(--el-highlight)">
            <Spinner size="sm" />
          </span>
          {t('questions.draftingTitle')}
        </p>
        <p className="m-0 max-w-[60ch] text-sm leading-normal text-(--el-text-secondary)">
          {waitingOnCode ? t('questions.draftingWaits') : t('questions.draftingBody')}
        </p>
        <div className="h-1.5 w-full max-w-[24rem] overflow-hidden rounded-full bg-(--el-tint-yellow)">
          <div
            className={cn(
              'h-full animate-pulse rounded-full bg-(--el-progress-fill)',
              waitingOnCode ? 'w-[8%]' : 'w-[55%]',
            )}
          />
        </div>
      </div>
    </Card>
  );
}

/** 6c — the plan is ready. */
function ReadyCard({ runId, projectName }: { runId: string; projectName: string }) {
  const [plan, setPlan] = useState<MigrateGeneratedPlanDto | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/onboarding/migrate/${runId}/plan`, { cache: 'no-store' });
        if (res.ok && live) setPlan((await res.json()) as MigrateGeneratedPlanDto);
      } catch {
        // the card still renders; the review link waits for the plan id
      }
    })();
    return () => {
      live = false;
    };
  }, [runId]);

  const t = useTranslations('onboardingMigrate');
  return (
    <Card>
      <div className="flex flex-col items-start gap-3" role="status">
        <span
          aria-hidden
          className="flex size-11 items-center justify-center rounded-full bg-(--el-tint-mint) text-(--el-text-strong)"
        >
          <CheckCircle2 className="size-5" />
        </span>
        <p className="m-0 text-base font-semibold text-(--el-text-strong)">
          {t('questions.readyTitle')}
        </p>
        <p className="m-0 max-w-[60ch] text-sm leading-normal text-(--el-text-secondary)">
          {t('questions.readyBody', { count: plan?.itemCount ?? 0, project: projectName })}
        </p>
        <div className="pt-2">
          {plan?.planId ? (
            <ReviewPlanButton planId={plan.planId} />
          ) : (
            <Button variant="primary" size="md" loading>
              {t('questions.readyCta')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** The one exit at the end of onboarding: the plan's review, opened the way the
 *  generation hand-off opens it (`GenerationFlow`'s PlannedHandOff). A child,
 *  because the hook needs a plan id. */
function ReviewPlanButton({ planId }: { planId: string }) {
  const t = useTranslations('onboardingMigrate');
  const { open } = useOpenPlanOverlay(planId, undefined, { host: '/plans' });
  return (
    <Button
      variant="primary"
      size="md"
      onClick={() => open()}
      rightIcon={<ArrowRight className="size-4" />}
    >
      {t('questions.readyCta')}
    </Button>
  );
}
