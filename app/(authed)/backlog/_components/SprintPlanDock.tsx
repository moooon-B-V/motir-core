'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Info, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import type { SprintPlanFailure, SprintPlanState } from '@/lib/hooks/useSprintPlanJob';
import { ProposedSprintPanel } from './ProposedSprintPanel';
import { AI_PLANNING_SETTINGS_HREF, TOP_UP_HREF } from './aiSprintPlanShared';
import type { StatusByKey } from './backlogShared';

// The AI sprint-planning DOCK (Subtask MOTIR-1750) — the review surface the
// design/ai-planning/sprint-planning asset draws (panels 2, 3 and 4).
//
// It REPLACES the create-sprint strip in place, so the user stays on `/backlog`,
// which is the surface the result lands in. Its shell is the shipped
// `PlanEditsReviewDock` grammar — header title + close, scrolling body, footer
// with the fine print on the left and ghost-discard / primary-approve on the
// right, the CTA naming what it creates — so AI review reads the same everywhere
// in the app.
//
// NOTHING here writes except Approve. Discard, Cancel and Close all simply
// unmount the dock: no sprint, no partial state, nothing to roll back.

export function SprintPlanDock({
  state,
  statusByKey,
  assigneeNameById,
  onCancel,
  onDismiss,
  onApprove,
  onRetry,
}: {
  state: SprintPlanState;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  /** Abandon an in-flight run. */
  onCancel: () => void;
  /** Close a terminal dock without writing. */
  onDismiss: () => void;
  /** Approve the reviewed packing — the only write. */
  onApprove: () => void;
  /** Start a fresh run (the retry / plan-again CTAs). */
  onRetry: () => void;
}) {
  const t = useTranslations('backlog');

  if (state.phase === 'idle') return null;

  if (state.phase === 'submitting' || state.phase === 'running') {
    return (
      <DockShell>
        <DockHead
          icon={<Spinner size="sm" className="text-(--el-accent-on-surface)" />}
          title={t('aiPlan.runningTitle')}
          trailing={
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t('aiPlan.cancel')}
            </Button>
          }
        />
        <div
          className="bg-(--el-surface-soft) p-(--spacing-card-padding)"
          role="status"
          aria-live="polite"
          aria-label={t('aiPlan.progressLabel')}
        >
          <RunProgress state={state} />
        </div>
      </DockShell>
    );
  }

  if (state.phase === 'approving') {
    return (
      <DockShell>
        <DockHead
          icon={<Spinner size="sm" className="text-(--el-accent-on-surface)" />}
          title={t('aiPlan.approve', {
            count: state.review?.proposal?.sprints.length ?? 0,
          })}
        />
      </DockShell>
    );
  }

  if (state.phase === 'error') {
    return (
      <DockShell labelled={false}>
        <FailureCallout
          failure={state.failure ?? 'failed'}
          detail={state.failureDetail}
          onRetry={onRetry}
          onDismiss={onDismiss}
        />
      </DockShell>
    );
  }

  // `empty` and `review` share the dock head — the run succeeded either way.
  const proposal = state.review?.proposal ?? null;
  const sprints = proposal?.sprints ?? [];

  return (
    <DockShell>
      <DockHead
        icon={<Sparkles className="h-4 w-4 text-(--el-accent-on-surface)" aria-hidden />}
        title={t('aiPlan.reviewTitle')}
        subtitle={
          proposal && sprints.length > 0
            ? t('aiPlan.reviewSub', {
                sprints: sprints.length,
                items: proposal.itemCount,
                days: proposal.sprintLengthDays,
              })
            : undefined
        }
        trailing={
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t('aiPlan.close')}
            data-testid="sprint-plan-close"
            className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-page-bg)"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        }
      />

      {state.phase === 'empty' || !proposal || sprints.length === 0 ? (
        <div className="flex flex-col items-center gap-2 bg-(--el-surface-soft) px-(--spacing-card-padding) py-8 text-center">
          <h3 className="font-semibold text-(--el-text-strong)">{t('aiPlan.emptyTitle')}</h3>
          <p className="max-w-prose text-sm leading-relaxed text-(--el-text-muted)">
            {t('aiPlan.emptyBody')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onDismiss}
            data-testid="sprint-plan-empty-close"
          >
            {t('aiPlan.close')}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto bg-(--el-surface-soft) p-(--spacing-card-padding)">
            {sprints.map((sprint, index) => (
              <ProposedSprintPanel
                key={sprint.tempId}
                sprint={sprint}
                order={index}
                agentMinutesPerDay={proposal.agentMinutesPerDay}
                items={state.review?.items ?? {}}
                statusByKey={statusByKey}
                assigneeNameById={assigneeNameById}
              />
            ))}
          </div>
          <footer className="flex flex-wrap items-center gap-3 border-t border-(--el-border) px-(--spacing-card-padding) py-3">
            <p className="max-w-[52ch] flex-1 text-xs leading-relaxed text-(--el-text-muted)">
              {t('aiPlan.approveFine')}
            </p>
            <Button variant="ghost" onClick={onDismiss} data-testid="sprint-plan-discard">
              {t('aiPlan.discard')}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Check className="h-4 w-4" aria-hidden />}
              onClick={onApprove}
              data-testid="sprint-plan-approve"
            >
              {t('aiPlan.approve', { count: sprints.length })}
            </Button>
          </footer>
        </>
      )}
    </DockShell>
  );
}

/** The dock's heading id — the section is labelled BY its own title, so a screen
 *  reader lands on a named region rather than an anonymous one. */
const DOCK_TITLE_ID = 'sprint-plan-dock-title';

function DockShell({
  children,
  labelled = true,
}: {
  children: React.ReactNode;
  /** False for the failure state, which renders no heading — a dangling
   *  `aria-labelledby` is worse than an unlabelled region, and the callout it
   *  holds is a `role="alert"`, which announces itself. */
  labelled?: boolean;
}) {
  return (
    <section
      aria-labelledby={labelled ? DOCK_TITLE_ID : undefined}
      data-testid="sprint-plan-dock"
      data-surface="card"
      className="overflow-hidden rounded-(--radius-card) border border-(--el-accent) bg-(--el-page-bg) shadow-(--shadow-elevated)"
    >
      {children}
    </section>
  );
}

function DockHead({
  icon,
  title,
  subtitle,
  trailing,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-(--el-border) bg-(--el-tint-lavender) px-(--spacing-card-padding) py-3">
      <span className="inline-flex shrink-0 items-center">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 id={DOCK_TITLE_ID} className="font-serif font-semibold text-(--el-text-strong)">
          {title}
        </h2>
        {subtitle ? <p className="text-xs text-(--el-text-strong) opacity-80">{subtitle}</p> : null}
      </div>
      {trailing}
    </header>
  );
}

/**
 * The streamed run, narrated.
 *
 * The shipped `plan_sprint` handler emits exactly two frames — `read` and
 * `packed` — so each of the three drawn steps is driven by one of them and shows
 * figures ONLY once the frame carrying them has arrived. A step whose frame has
 * not landed stays running with a spinner rather than displaying a placeholder
 * number.
 */
function RunProgress({ state }: { state: SprintPlanState }) {
  const t = useTranslations('backlog');
  const { readCount, sprintLengthDays, agentMinutesPerDay, sprintCount } = state.progress;
  const packed = sprintCount !== null;

  return (
    <ol className="flex flex-col gap-1">
      <Step
        done={readCount !== null}
        label={readCount !== null ? t('aiPlan.stepRead', { count: readCount }) : null}
        pendingLabel={t('aiPlan.stepRead', { count: 0 })}
        doneLabel={t('aiPlan.stepDone')}
        showPending={readCount === null}
      />
      {readCount !== null ? (
        <Step
          done={packed}
          label={
            packed && sprintLengthDays !== null && agentMinutesPerDay !== null
              ? t('aiPlan.stepSize', { days: sprintLengthDays, minutes: agentMinutesPerDay })
              : null
          }
          doneLabel={t('aiPlan.stepDone')}
        />
      ) : null}
      {packed && sprintCount !== null ? (
        <Step
          done={false}
          label={t('aiPlan.stepPack', { n: sprintCount, total: sprintCount })}
          doneLabel={t('aiPlan.stepDone')}
        />
      ) : null}
    </ol>
  );
}

function Step({
  done,
  label,
  pendingLabel,
  doneLabel,
  showPending = false,
}: {
  done: boolean;
  label: string | null;
  pendingLabel?: string;
  doneLabel: string;
  showPending?: boolean;
}) {
  // Until its frame lands a step has no figures to state, so it renders as the
  // bare in-flight line — never a fabricated count.
  const text = label ?? (showPending ? pendingLabel : null);
  return (
    <li className="flex items-center gap-2 rounded-(--radius-control) border border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
      {done ? (
        <Pill severity="success">{doneLabel}</Pill>
      ) : (
        <Spinner size="sm" className="text-(--el-accent-on-surface)" />
      )}
      {text ? <span className="min-w-0 flex-1 text-sm text-(--el-text)">{text}</span> : null}
    </li>
  );
}

/**
 * One drawn failure per shipped status code. Peach (`--el-warning-surface`) for a
 * condition the user can FIX; rose (`--el-danger-surface`) for a refusal. Every
 * one of them says nothing was created — true by construction, because approve
 * runs in ONE transaction, so a partial write cannot happen.
 */
function FailureCallout({
  failure,
  detail,
  onRetry,
  onDismiss,
}: {
  failure: SprintPlanFailure;
  detail: string | null;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('backlog');

  const fixable = failure === 'disabled' || failure === 'credits';
  const lead = t(
    (
      {
        disabled: 'aiPlan.errDisabled',
        credits: 'aiPlan.errCredits',
        unreachable: 'aiPlan.errUnreachable',
        packing: 'aiPlan.errPacking',
        notAdmin: 'aiPlan.errNotAdmin',
        failed: 'aiPlan.errFailed',
      } as const
    )[failure],
  );
  const body =
    failure === 'packing'
      ? t('aiPlan.errPackingBody', { detail: detail ?? '' })
      : t(
          (
            {
              disabled: 'aiPlan.errDisabledBody',
              credits: 'aiPlan.errCreditsBody',
              unreachable: 'aiPlan.errUnreachableBody',
              notAdmin: 'aiPlan.errNotAdminBody',
              failed: 'aiPlan.errFailedBody',
            } as const
          )[failure as Exclude<SprintPlanFailure, 'packing'>],
        );

  return (
    <div
      role="alert"
      data-testid={`sprint-plan-error-${failure}`}
      className={`flex items-start gap-2 px-(--spacing-card-padding) py-3 text-sm leading-relaxed ${
        fixable
          ? 'bg-(--el-warning-surface) text-(--el-warning-text)'
          : 'bg-(--el-danger-surface) text-(--el-danger-surface-text)'
      }`}
    >
      {fixable ? (
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span>
          <b className="font-semibold">{lead}</b> {body}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {failure === 'disabled' ? (
            <Link
              href={AI_PLANNING_SETTINGS_HREF}
              className="inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) border border-(--el-button-border) bg-(--el-page-bg) px-3 text-xs font-semibold text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {t('aiPlan.offLink')}
            </Link>
          ) : null}
          {failure === 'credits' ? (
            <Link
              href={TOP_UP_HREF}
              className="inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) border border-(--el-button-border) bg-(--el-page-bg) px-3 text-xs font-semibold text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {t('aiPlan.topUp')}
            </Link>
          ) : null}
          {failure === 'unreachable' || failure === 'failed' ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t('aiPlan.retry')}
            </Button>
          ) : null}
          {failure === 'packing' ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t('aiPlan.planAgain')}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t('aiPlan.close')}
          </Button>
        </div>
      </div>
    </div>
  );
}
