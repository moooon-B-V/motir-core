'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Circle, ExternalLink } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { CarryOverDestination, SprintDto, SprintReportDto } from '@/lib/dto/sprints';
import type { StatusByKey } from './backlogShared';
import { SprintReport } from './SprintReport';

// Complete-sprint flow (Story 4.4 · Subtask 4.4.6). The complete modal + carry-over
// chooser the design (design/sprints/sprint-lifecycle.mock.html panels 4–6)
// specifies, plus the sprint-report success state. Self-contained + mountable: it
// takes the active sprint + the project's planned sprints (carry-over targets) and
// binds to the shipped backend (4.4.3 / 4.4.4):
//
//   • GET  /api/sprints/[id]/report   → getSprintReport (the live preview summary)
//   • POST /api/sprints/[id]/complete { carryOverTo } → completeSprint
//
// On open it fetches the report PREVIEW (issues still in the sprint) for the
// completed/incomplete split summary. On confirm it completes the sprint, then
// renders that SAME preview snapshot as the success-state report — the snapshot is
// PRE-MOVE, so the incomplete issues are still listed with a "→ {destination}"
// carry-over chip (after completion they have physically left the sprint, so a
// re-fetch would show them gone). The report is also reachable standalone at
// /sprints/[id]/report for a closed sprint (Jira keeps closed-sprint reports).
//
// Story 4.5.3 mounts this SAME exported flow in the scrum header (4.5 → 4.4, the
// one-way arrow); it does NOT touch the scrum board. Colour via `--el-*`, shape
// via element-semantic tokens; the Modal is a labelled focus-trapped dialog; the
// carry-over chooser is a keyboard-operable radiogroup; counts + points are
// text+number, never colour alone (finding #35).

type CarryTarget = 'backlog' | 'sprint';
type Phase = 'form' | 'done';
type LoadState = 'loading' | 'ready' | 'error';

export interface CompleteSprintDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active sprint being completed. */
  sprint: SprintDto;
  /** The project name, for the modal subtitle. */
  projectName: string;
  /** The project's PLANNED sprints — the carry-over "future sprint" targets. */
  plannedSprints: SprintDto[];
  /** status key → label/category for the success-report row pills. */
  statusByKey: StatusByKey;
  /** Called once on close AFTER a successful completion, so the backlog refetches
   *  (the now-complete sprint drops out of the planning view). */
  onCompleted?: () => void | Promise<void>;
}

export function CompleteSprintDialog({
  open,
  onOpenChange,
  sprint,
  projectName,
  plannedSprints,
  statusByKey,
  onCompleted,
}: CompleteSprintDialogProps) {
  const t = useTranslations('backlog');
  const tc = useTranslations('common');
  const { toast } = useToast();

  const [report, setReport] = useState<SprintReportDto | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [carryTarget, setCarryTarget] = useState<CarryTarget>('backlog');
  const [targetSprintId, setTargetSprintId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [completedSprint, setCompletedSprint] = useState<SprintDto | null>(null);
  const [carryOverLabel, setCarryOverLabel] = useState<string | null>(null);

  // Fetch the report preview while the dialog is open (the split summary + the
  // pre-move snapshot the success state reuses). Mirrors the BacklogContainer
  // fetch pattern (no SWR in this codebase): `loadState` is flipped to 'loading'
  // OUTSIDE the effect — on mount/close-reset + in the retry handler — never
  // synchronously inside it (React 19 forbids set-state-in-effect).
  useEffect(() => {
    if (!open || phase === 'done') return;
    let cancelled = false;
    void fetch(`/api/sprints/${sprint.id}/report`, { headers: { accept: 'application/json' } })
      .then((res) =>
        res.ok ? (res.json() as Promise<SprintReportDto>) : Promise.reject(res.status),
      )
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setLoadState('ready');
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [open, phase, sprint.id, reloadKey]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      const didComplete = phase === 'done';
      // Reset transient state on close (React 19 forbids set-state-in-effect; the
      // start dialog resets here for the same reason).
      setReport(null);
      setLoadState('loading');
      setCarryTarget('backlog');
      setTargetSprintId(null);
      setSubmitting(false);
      setPhase('form');
      setCompletedSprint(null);
      setCarryOverLabel(null);
      onOpenChange(false);
      // Refetch the backlog only AFTER the modal closes, so the success report
      // stays visible (a refetch would unmount this container mid-read).
      if (didComplete) void onCompleted?.();
      return;
    }
    onOpenChange(true);
  }

  const incompleteCount = report?.incomplete.totalCount ?? 0;
  const completedCount = report?.completed.totalCount ?? 0;
  const hasIncomplete = incompleteCount > 0;
  const noPlanned = plannedSprints.length === 0;

  const sprintOptions = plannedSprints.map((s) => ({ value: s.id, label: s.name }));

  const canComplete =
    loadState === 'ready' &&
    !submitting &&
    (!hasIncomplete ||
      carryTarget === 'backlog' ||
      (carryTarget === 'sprint' && targetSprintId !== null));

  async function handleComplete() {
    if (!canComplete) return;
    // Default carry-over is the backlog; only send a sprint target when chosen and
    // there is unfinished work to move.
    const carryOverTo: CarryOverDestination =
      hasIncomplete && carryTarget === 'sprint' && targetSprintId
        ? { sprintId: targetSprintId }
        : 'backlog';
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sprints/${sprint.id}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ carryOverTo }),
      });
      if (!res.ok) throw new Error(`complete ${res.status}`);
      const completed = (await res.json()) as SprintDto;
      const label =
        carryOverTo === 'backlog'
          ? t('completeSprintFlow.carryBacklog')
          : (plannedSprints.find((s) => s.id === targetSprintId)?.name ?? null);
      setCompletedSprint(completed);
      setCarryOverLabel(hasIncomplete ? label : null);
      setPhase('done');
      toast({
        variant: 'success',
        title: t('completeSprintFlow.completedToast', { name: sprint.name }),
      });
    } catch {
      toast({
        variant: 'error',
        title: t('completeSprintFlow.errorTitle'),
        description: t('completeSprintFlow.errorDescription'),
      });
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success state — the sprint report ──────────────────────────────────────
  if (phase === 'done' && report && completedSprint) {
    return (
      <Modal
        open={open}
        onOpenChange={handleOpenChange}
        title={t('sprintReport.title', { name: completedSprint.name })}
        size="lg"
      >
        {/* Wrap the report in Modal.Body so it inherits the panel's
            `flex-1 overflow-y-auto` scroll recipe (the panel caps at
            `max-h-[90vh] overflow-hidden`). Without it the report — meta line,
            points rollup, both issue lists, AND the burndown/velocity analytics
            row — lays out at its natural height and is clipped off the bottom
            with no scroll affordance (bug-sprint-report-modal-clipped-burndown).
            SprintReport keeps its own `gap-4` column; this body is just the
            scroll seam, so the Modal.Footer below stays pinned. */}
        <Modal.Body data-testid="sprint-report-modal-body">
          <SprintReport
            report={report}
            sprint={completedSprint}
            statusByKey={statusByKey}
            carryOverLabel={carryOverLabel}
          />
        </Modal.Body>
        <Modal.Footer>
          {/* The standalone closed-sprint report (a bookmarkable route) — Jira
              keeps closed-sprint reports reachable after the success state closes.
              A real <Link> styled as a ghost button (no <button> inside an <a>). */}
          <Link
            href={`/sprints/${completedSprint.id}/report`}
            className={buttonVariants({ variant: 'ghost', size: 'md' })}
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            {t('completeSprintFlow.viewFullReport')}
          </Link>
          <Button variant="primary" onClick={() => handleOpenChange(false)}>
            {t('completeSprintFlow.doneClose')}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }

  // ── Form state — the carry-over chooser ────────────────────────────────────
  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title={t('completeSprintFlow.title')}
      description={t('completeSprintFlow.subtitle', { sprint: sprint.name, project: projectName })}
      size="md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleComplete();
        }}
      >
        {loadState === 'loading' ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-(--el-text-muted)">
            <Spinner size="sm" />
            {t('completeSprintFlow.loading')}
          </div>
        ) : loadState === 'error' ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-(--el-text-secondary)">
              {t('completeSprintFlow.loadError')}
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                setLoadState('loading');
                setReloadKey((k) => k + 1);
              }}
            >
              {tc('retry')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-(--spacing-md)">
            {/* Completed / incomplete split summary. */}
            <div className="grid grid-cols-2 gap-2">
              <SplitStat
                tone="done"
                count={completedCount}
                label={t('completeSprintFlow.completedLabel')}
                sub={
                  report && report.points.committed !== null
                    ? t('completeSprintFlow.completedPoints', {
                        completed: report.points.completed,
                        committed: report.points.committed,
                      })
                    : t('completeSprintFlow.completedPointsUnestimated', {
                        completed: report?.points.completed ?? 0,
                      })
                }
              />
              <SplitStat
                tone="neutral"
                count={incompleteCount}
                label={t('completeSprintFlow.incompleteLabel')}
                sub={t('completeSprintFlow.carryOverPoints', {
                  points: report?.points.notCompleted ?? 0,
                })}
              />
            </div>

            {hasIncomplete ? (
              <div className="flex flex-col gap-2">
                <span
                  id={`carry-lbl-${sprint.id}`}
                  className="text-sm font-medium text-(--el-text)"
                >
                  {t('completeSprintFlow.chooserLabel', { count: incompleteCount })}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby={`carry-lbl-${sprint.id}`}
                  className="flex flex-col gap-2"
                >
                  <CarryRadio
                    selected={carryTarget === 'backlog'}
                    onSelect={() => setCarryTarget('backlog')}
                    title={t('completeSprintFlow.carryBacklog')}
                    sub={t('completeSprintFlow.carryBacklogSub')}
                  />
                  <CarryRadio
                    selected={carryTarget === 'sprint'}
                    onSelect={() => setCarryTarget('sprint')}
                    disabled={noPlanned}
                    title={t('completeSprintFlow.carrySprint')}
                    sub={
                      noPlanned
                        ? t('completeSprintFlow.noPlannedSprints')
                        : t('completeSprintFlow.carrySprintSub')
                    }
                    trailing={
                      carryTarget === 'sprint' && !noPlanned ? (
                        <Combobox
                          options={sprintOptions}
                          value={targetSprintId}
                          onChange={setTargetSprintId}
                          label={t('completeSprintFlow.carrySprintSelectLabel')}
                          placeholder={t('completeSprintFlow.carrySprintSelectPlaceholder')}
                        />
                      ) : null
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-(--radius-card) bg-(--el-tint-mint) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-(--el-success)" aria-hidden />
                {t('completeSprintFlow.allComplete')}
              </div>
            )}
          </div>
        )}

        <Modal.Footer>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={submitting}>
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            leftIcon={<CheckCircle2 className="h-4 w-4" />}
            loading={submitting}
            disabled={!canComplete}
          >
            {t('completeSprintFlow.confirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

function SplitStat({
  tone,
  count,
  label,
  sub,
}: {
  tone: 'done' | 'neutral';
  count: number;
  label: string;
  sub: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-card-padding) py-3">
      <span
        className={`font-serif text-2xl font-semibold ${tone === 'done' ? 'text-(--el-success)' : 'text-(--el-text-strong)'}`}
      >
        {count}
      </span>
      <span className="flex items-center gap-1 text-xs font-medium text-(--el-text-secondary)">
        {tone === 'done' ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-(--el-success)" aria-hidden />
        ) : (
          <Circle className="h-3.5 w-3.5 shrink-0 text-(--el-text-muted)" aria-hidden />
        )}
        {label}
      </span>
      <span className="text-xs text-(--el-text-muted)">{sub}</span>
    </div>
  );
}

function CarryRadio({
  selected,
  onSelect,
  title,
  sub,
  disabled = false,
  trailing,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  sub: string;
  disabled?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-(--radius-input) border px-(--spacing-control-x) py-(--spacing-control-y) ${
        selected ? 'border-(--el-accent) bg-(--el-selection-bg)' : 'border-(--el-border)'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className="flex items-start gap-2 text-left focus-visible:outline-none disabled:cursor-not-allowed"
      >
        <span
          aria-hidden
          className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
            selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
          }`}
        >
          {selected ? <span className="h-2 w-2 rounded-full bg-(--el-accent)" /> : null}
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-medium text-(--el-text)">{title}</span>
          <span className="text-xs text-(--el-text-muted)">{sub}</span>
        </span>
      </button>
      {trailing ? <div className="pl-6">{trailing}</div> : null}
    </div>
  );
}
