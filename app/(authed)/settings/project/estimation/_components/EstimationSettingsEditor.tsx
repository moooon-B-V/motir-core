'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Clock, Hash, List, Lock, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import { deckForScale } from '@/lib/estimation/decks';
import type {
  EstimationConfigDto,
  EstimationStatisticDto,
  PointScaleDto,
} from '@/lib/dto/estimation';

// EstimationSettingsEditor (Subtask 4.3.6) — the project Estimation settings
// form, per design/estimation/estimation-settings.mock.html + design-notes.md.
// A pure client consumer of the 4.3.3 `PATCH /api/projects/[key]/estimation-config`
// endpoint (the settings-page fetch idiom, mirroring BoardConfigEditor — NOT a
// server action): the Save is optimistic-with-reconcile (committed snapshot
// flips immediately, reverts + toasts on failure). The server re-gates the write
// (estimationService, owner-only), so `isAdmin` here only governs whether the
// edit affordances render — a non-admin sees the panel read-only.
//
// Two project-scoped choices (the justified per-project deviation from Jira's
// board-scoped Estimation, see story-4.3.ts):
//   * estimation STATISTIC — Story points (default) · Time estimate · Issue count
//     (which measure rolls up to sprints + epics).
//   * point SCALE — Fibonacci (default) · Linear · Custom (the suggested deck the
//     4.3.4 estimate picker offers). The scale is a STORY-POINTS-ONLY concept, so
//     the field is hidden when the statistic is Time / Issue count; the custom
//     editor is shown only when scale = Custom.
//
// Colour strictly `--el-*` (finding #54); shape via element tokens; the only hued
// surfaces are the lock-banner border + the segmented accent — never a tinted
// page surface (finding #35). Every figure/label reads as text.

const STATISTIC_VALUES: readonly EstimationStatisticDto[] = [
  'story_points',
  'time_estimate',
  'issue_count',
];
const SCALE_VALUES: readonly PointScaleDto[] = ['fibonacci', 'linear', 'custom'];

function sameValues(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Whether two configs are equal (the dirty check). Exported for the test. */
export function configsEqual(a: EstimationConfigDto, b: EstimationConfigDto): boolean {
  return (
    a.estimationStatistic === b.estimationStatistic &&
    a.pointScale === b.pointScale &&
    sameValues(a.customScaleValues, b.customScaleValues)
  );
}

export function EstimationSettingsEditor({
  projectKey,
  config,
  isAdmin,
}: {
  projectKey: string;
  config: EstimationConfigDto;
  isAdmin: boolean;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { toast } = useToast();

  // `committed` is the last-persisted config (the optimistic snapshot target);
  // the working fields are the user's in-flight edits. dirty = working ≠ committed.
  const [committed, setCommitted] = useState<EstimationConfigDto>(config);
  const [statistic, setStatistic] = useState<EstimationStatisticDto>(config.estimationStatistic);
  const [scale, setScale] = useState<PointScaleDto>(config.pointScale);
  const [customValues, setCustomValues] = useState<number[]>(config.customScaleValues);
  const [saving, setSaving] = useState(false);

  const working: EstimationConfigDto = useMemo(
    () => ({ estimationStatistic: statistic, pointScale: scale, customScaleValues: customValues }),
    [statistic, scale, customValues],
  );
  const dirty = !configsEqual(working, committed);
  const showScale = statistic === 'story_points';
  const customEmpty = scale === 'custom' && customValues.length === 0;
  const canSave = isAdmin && dirty && !saving && !customEmpty;

  const reset = useCallback(() => {
    setStatistic(committed.estimationStatistic);
    setScale(committed.pointScale);
    setCustomValues(committed.customScaleValues);
  }, [committed]);

  const save = useCallback(() => {
    if (!isAdmin || customEmpty) return;
    const prev = committed;
    const next = working;
    // Optimistic: the committed snapshot flips now; reconcile/revert on the response.
    setCommitted(next);
    setSaving(true);
    void fetch(`/api/projects/${encodeURIComponent(projectKey)}/estimation-config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        estimationStatistic: next.estimationStatistic,
        pointScale: next.pointScale,
        customScaleValues: next.customScaleValues,
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`save ${res.status}`);
        setSaving(false);
        toast({
          variant: 'success',
          title: t('estimation.savedTitle'),
          description: t('estimation.savedDesc'),
        });
      })
      .catch(() => {
        setCommitted(prev);
        setSaving(false);
        toast({
          variant: 'error',
          title: t('estimation.errorTitle'),
          description: t('estimation.saveError'),
        });
      });
  }, [isAdmin, customEmpty, committed, working, projectKey, t, toast]);

  const statisticOptions = [
    {
      value: 'story_points' as const,
      label: t('estimation.statisticStoryPoints'),
      icon: <Hash className="size-3.5" />,
    },
    {
      value: 'time_estimate' as const,
      label: t('estimation.statisticTime'),
      icon: <Clock className="size-3.5" />,
    },
    {
      value: 'issue_count' as const,
      label: t('estimation.statisticIssueCount'),
      icon: <List className="size-3.5" />,
    },
  ];
  const scaleOptions = SCALE_VALUES.map((value) => ({
    value,
    label: t(
      value === 'fibonacci'
        ? 'estimation.scaleFibonacci'
        : value === 'linear'
          ? 'estimation.scaleLinear'
          : 'estimation.scaleCustom',
    ),
  }));

  void STATISTIC_VALUES; // documents the full statistic set the Segmented spans

  return (
    <div className="bg-(--el-page-bg) border-(--el-border) shadow-(--shadow-card) overflow-hidden rounded-(--radius-card) border">
      {/* Card head */}
      <div className="border-(--el-border) border-b px-(--spacing-card-padding) py-4">
        <h2 className="text-sm font-semibold text-(--el-text)">{t('estimation.cardTitle')}</h2>
        <p className="text-(--el-text-muted) mt-0.5 text-xs">{t('estimation.cardSubtitle')}</p>
      </div>

      {/* Card body */}
      <div className="flex flex-col gap-5 px-(--spacing-card-padding) py-5">
        {!isAdmin ? (
          <div
            className="bg-(--el-surface) border-(--el-border) flex items-center gap-2.5 rounded-(--radius-control) border px-3 py-2 text-xs text-(--el-text-secondary)"
            data-testid="estimation-readonly-banner"
          >
            <Lock className="text-(--el-text-faint) size-3.5 shrink-0" aria-hidden />
            {t('estimation.readOnlyBanner')}
          </div>
        ) : null}

        {/* Estimation statistic */}
        <div>
          <p className="text-sm font-medium text-(--el-text)">{t('estimation.statisticLabel')}</p>
          <p className="text-(--el-text-muted) mt-0.5 mb-2.5 max-w-[56ch] text-xs">
            {t('estimation.statisticHint')}
          </p>
          <Segmented
            label={t('estimation.statisticLabel')}
            options={statisticOptions}
            value={statistic}
            onChange={setStatistic}
            disabled={!isAdmin}
          />
        </div>

        {/* Point scale — story-points only */}
        {showScale ? (
          <div>
            <p className="text-sm font-medium text-(--el-text)">{t('estimation.scaleLabel')}</p>
            <p className="text-(--el-text-muted) mt-0.5 mb-2.5 max-w-[56ch] text-xs">
              {t('estimation.scaleHint')}
            </p>
            <Segmented
              label={t('estimation.scaleLabel')}
              options={scaleOptions}
              value={scale}
              onChange={setScale}
              disabled={!isAdmin}
            />
            {scale === 'custom' ? (
              <CustomScaleEditor
                values={customValues}
                onChange={setCustomValues}
                isAdmin={isAdmin}
                empty={customEmpty}
              />
            ) : (
              <DeckPreview values={deckForScale(scale, customValues)} />
            )}
          </div>
        ) : null}
      </div>

      {/* Card footer — admin only */}
      {isAdmin ? (
        <div className="bg-(--el-surface-soft) border-(--el-border) flex items-center justify-end gap-2.5 border-t px-(--spacing-card-padding) py-3.5">
          <Button variant="secondary" onClick={reset} disabled={!dirty || saving}>
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={save}
            loading={saving}
            disabled={!canSave}
            data-testid="estimation-save"
          >
            {t('estimation.save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ── Read-only deck preview (Fibonacci / Linear) ──────────────────────────────

function DeckPreview({ values }: { values: number[] }) {
  const t = useTranslations('settings');
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="estimation-deck">
      <span className="text-(--el-text-faint) mr-0.5 text-[11px]">{t('estimation.deckLabel')}</span>
      {values.map((v, i) => (
        <span
          key={`${v}-${i}`}
          className="bg-(--el-surface) border-(--el-border) inline-flex h-7 min-w-[30px] items-center justify-center rounded-(--radius-control) border px-2 font-mono text-xs font-semibold text-(--el-text)"
        >
          {v}
        </span>
      ))}
    </div>
  );
}

// ── Custom-scale editor (chips + remove + add) ───────────────────────────────

function CustomScaleEditor({
  values,
  onChange,
  isAdmin,
  empty,
}: {
  values: number[];
  onChange: (values: number[]) => void;
  isAdmin: boolean;
  empty: boolean;
}) {
  const t = useTranslations('settings');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const fieldId = useId();

  const commitAdd = useCallback(() => {
    const n = Number(draft.trim());
    if (!draft.trim() || !Number.isFinite(n) || n <= 0) {
      setInvalid(true);
      return;
    }
    onChange([...values, n]);
    setDraft('');
    setInvalid(false);
    setAdding(false);
  }, [draft, values, onChange]);

  const remove = useCallback(
    (index: number) => {
      onChange(values.filter((_, i) => i !== index));
    },
    [values, onChange],
  );

  return (
    <div className="mt-2.5">
      <p className="text-(--el-text-muted) mb-2 max-w-[56ch] text-xs">
        {t('estimation.customHint')}
      </p>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="estimation-custom">
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="bg-(--el-surface) border-(--el-border) inline-flex h-7 items-center gap-1 rounded-(--radius-control) border pr-1 pl-2 font-mono text-xs font-semibold text-(--el-text)"
          >
            {v}
            {isAdmin ? (
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={t('estimation.removeValueAria', { value: v })}
                data-testid={`estimation-remove-${i}`}
                className="text-(--el-text-faint) hover:bg-(--el-muted) hover:text-(--el-danger) inline-flex size-4 items-center justify-center rounded-(--radius-control) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
              >
                <X className="size-[11px]" aria-hidden />
              </button>
            ) : null}
          </span>
        ))}

        {isAdmin && adding ? (
          <span className="inline-flex items-center gap-1">
            <input
              id={fieldId}
              type="number"
              min="0"
              step="any"
              autoFocus
              value={draft}
              aria-label={t('estimation.addValueAria')}
              aria-invalid={invalid || undefined}
              data-testid="estimation-add-input"
              onChange={(e) => {
                setDraft(e.target.value);
                if (invalid) setInvalid(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitAdd();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setAdding(false);
                  setDraft('');
                  setInvalid(false);
                }
              }}
              onBlur={() => {
                if (draft.trim()) commitAdd();
                else {
                  setAdding(false);
                  setInvalid(false);
                }
              }}
              className="border-(--el-accent) bg-(--el-page-bg) h-7 w-16 rounded-(--radius-control) border px-2 font-mono text-xs text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            />
          </span>
        ) : isAdmin ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label={t('estimation.addValueAria')}
            data-testid="estimation-add"
            className="border-(--el-border) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) inline-flex h-7 items-center justify-center rounded-(--radius-control) border border-dashed px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {invalid ? (
        <p role="alert" className="mt-1.5 text-xs text-(--el-danger)">
          {t('estimation.customInvalid')}
        </p>
      ) : empty ? (
        <p
          role="alert"
          className="mt-1.5 text-xs text-(--el-danger)"
          data-testid="estimation-custom-empty"
        >
          {t('estimation.customEmpty')}
        </p>
      ) : null}
    </div>
  );
}
