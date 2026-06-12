'use client';

import { useEffect, useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { FormField } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import type { DashboardWidgetType } from '@prisma/client';
import type { DashboardWidgetDto } from '@/lib/dto/dashboards';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import {
  CREATED_VS_RESOLVED_DAYS_BACK_MAX,
  FILTER_RESULTS_PAGE_SIZE_MAX,
} from '@/lib/dashboards/constants';
import { customFieldFilterFieldId } from '@/lib/filters/ast';
import { BUILTIN_STATISTICS } from './widgetMeta';
import { DataSourceField, type ProjectLite, type SourceValue } from './DataSourceField';

// The widget config modal (6.3.5, design panel 4) — the registry's EDITOR KIND
// for a widget type, rendered as a dialog. Hosts the shared data-source XOR
// (DataSourceField) plus the per-kind settings. Used for BOTH create (no
// `widgetId` → POST /widgets) and edit (→ PATCH /widgets/[id]); the widget
// TYPE is immutable, so type only flows in on create. The UI keys off
// `editorKind` (never the type name) — a registry addition with a known editor
// kind opens here unchanged.

export interface WidgetDraft {
  source: SourceValue;
  pageSize: number;
  statisticType: string | null;
  period: 'day' | 'week' | 'month';
  daysBack: number;
  cumulative: boolean;
}

const EMPTY_SOURCE: SourceValue = { kind: 'project', savedFilterId: null, projectId: null };

export function emptyDraft(): WidgetDraft {
  return {
    source: { ...EMPTY_SOURCE },
    pageSize: FILTER_RESULTS_PAGE_SIZE_MAX,
    statisticType: null,
    period: 'day',
    daysBack: 30,
    cumulative: false,
  };
}

export function WidgetConfigModal({
  open,
  onOpenChange,
  mode,
  type,
  editorKind,
  dashboardId,
  widgetId,
  projects,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  type: DashboardWidgetType;
  editorKind: string;
  dashboardId: string;
  widgetId?: string;
  projects: ProjectLite[];
  initial?: WidgetDraft;
  onSaved: (widget: DashboardWidgetDto) => void;
}) {
  const t = useTranslations('dashboards.config');
  const tStat = useTranslations('dashboards.statistic');
  const { toast } = useToast();
  const tToast = useTranslations('dashboards.toast');

  const [draft, setDraft] = useState<WidgetDraft>(initial ?? emptyDraft());
  const [saving, setSaving] = useState(false);
  // Keyed by project identifier so a stale project's fields are filtered out at
  // READ time — the effect only ever setState()s inside its async callback
  // (never synchronously in the body; react-hooks/set-state-in-effect).
  const [cfCache, setCfCache] = useState<{ key: string; fields: CustomFieldDefinitionDTO[] }>({
    key: '',
    fields: [],
  });

  // Reset the draft whenever the modal (re)opens for a different widget. A key
  // on the inner form (`${mode}-${widgetId ?? type}`) drives the reset via
  // remount rather than a sync setState-in-effect.
  const draftKey = `${mode}:${widgetId ?? type}`;
  const [lastKey, setLastKey] = useState(draftKey);
  if (open && draftKey !== lastKey) {
    setLastKey(draftKey);
    setDraft(initial ?? emptyDraft());
  }

  // For a project-sourced distribution, offer the project's enum-ish custom
  // fields (select / user) alongside the builtins (the design's grouped picker).
  const projectIdentifier =
    draft.source.kind === 'project' && draft.source.projectId
      ? projects.find((p) => p.id === draft.source.projectId)?.identifier
      : undefined;

  useEffect(() => {
    if (editorKind !== 'distribution_editor' || !projectIdentifier) return;
    let cancelled = false;
    void fetch(`/api/projects/${encodeURIComponent(projectIdentifier)}/fields`, {
      headers: { accept: 'application/json' },
    })
      .then((res) =>
        res.ok ? (res.json() as Promise<{ fields: CustomFieldDefinitionDTO[] }>) : null,
      )
      .then((body) => {
        if (cancelled) return;
        const eligible = (body?.fields ?? []).filter(
          (f) => f.fieldType === 'select' || f.fieldType === 'user',
        );
        setCfCache({ key: projectIdentifier, fields: eligible });
      })
      .catch(() => {
        if (!cancelled) setCfCache({ key: projectIdentifier, fields: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [editorKind, projectIdentifier]);

  const statisticOptions: ComboboxOption<string>[] = useMemo(() => {
    const customFields = cfCache.key === projectIdentifier ? cfCache.fields : [];
    const builtins = BUILTIN_STATISTICS.map((s) => ({
      value: s.id,
      label: tStat(s.labelKey),
      group: t('standardFields'),
      icon: <s.icon className="size-4" aria-hidden />,
    }));
    const cfs = customFields.map((f) => ({
      value: customFieldFilterFieldId(f.id),
      label: f.label,
      group: t('customFields'),
    }));
    return [...builtins, ...cfs];
  }, [cfCache, projectIdentifier, t, tStat]);

  const sourceValid =
    (draft.source.kind === 'saved_filter' && !!draft.source.savedFilterId) ||
    (draft.source.kind === 'project' && !!draft.source.projectId);
  const statisticValid = editorKind !== 'distribution_editor' || !!draft.statisticType;
  const canSave = sourceValid && statisticValid && !saving;

  function buildConfig(): Record<string, unknown> {
    if (editorKind === 'filter_results_editor') return { pageSize: draft.pageSize };
    if (editorKind === 'distribution_editor') return { statisticType: draft.statisticType };
    return { period: draft.period, daysBack: draft.daysBack, cumulative: draft.cumulative };
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    const sourceBody = {
      savedFilterId: draft.source.kind === 'saved_filter' ? draft.source.savedFilterId : null,
      projectId: draft.source.kind === 'project' ? draft.source.projectId : null,
    };
    try {
      const res =
        mode === 'create'
          ? await fetch(`/api/dashboards/${encodeURIComponent(dashboardId)}/widgets`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ type, ...sourceBody, config: buildConfig() }),
            })
          : await fetch(
              `/api/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(
                widgetId!,
              )}`,
              {
                method: 'PATCH',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ ...sourceBody, config: buildConfig() }),
              },
            );
      if (!res.ok) throw new Error(`widget save ${res.status}`);
      const body = (await res.json()) as { widget: DashboardWidgetDto };
      onSaved(body.widget);
      onOpenChange(false);
    } catch {
      toast({
        variant: 'error',
        title: tToast('errorTitle'),
        description: mode === 'create' ? tToast('addWidgetError') : tToast('updateWidgetError'),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t(`addTitle_${type}`)} size="sm">
      <div className="flex flex-col gap-4">
        <DataSourceField
          projects={projects}
          value={draft.source}
          onChange={(source) => setDraft((d) => ({ ...d, source }))}
        />

        {editorKind === 'filter_results_editor' ? (
          <FormField
            label={t('rowsPerPage')}
            htmlFor="widget-pagesize"
            helperText={t('rowsHint', { max: FILTER_RESULTS_PAGE_SIZE_MAX })}
          >
            <Stepper
              id="widget-pagesize"
              value={draft.pageSize}
              min={1}
              max={FILTER_RESULTS_PAGE_SIZE_MAX}
              step={5}
              onChange={(pageSize) => setDraft((d) => ({ ...d, pageSize }))}
            />
          </FormField>
        ) : null}

        {editorKind === 'distribution_editor' ? (
          <FormField label={t('statisticType')} htmlFor="widget-statistic">
            <Combobox
              label={t('statisticType')}
              placeholder={t('pickStatistic')}
              options={statisticOptions}
              value={draft.statisticType}
              searchable
              onChange={(statisticType) => setDraft((d) => ({ ...d, statisticType }))}
            />
          </FormField>
        ) : null}

        {editorKind === 'created_vs_resolved_editor' ? (
          <>
            <FormField label={t('period')} htmlFor="widget-period">
              <div id="widget-period">
                <Segmented
                  label={t('period')}
                  options={[
                    { value: 'day', label: t('periodDay') },
                    { value: 'week', label: t('periodWeek') },
                    { value: 'month', label: t('periodMonth') },
                  ]}
                  value={draft.period}
                  onChange={(period) => setDraft((d) => ({ ...d, period }))}
                />
              </div>
            </FormField>
            <FormField
              label={t('daysBack')}
              htmlFor="widget-daysback"
              helperText={t('daysBackHint', { max: CREATED_VS_RESOLVED_DAYS_BACK_MAX })}
            >
              <Stepper
                id="widget-daysback"
                value={draft.daysBack}
                min={1}
                max={CREATED_VS_RESOLVED_DAYS_BACK_MAX}
                step={draft.period === 'day' ? 7 : draft.period === 'week' ? 7 : 30}
                onChange={(daysBack) => setDraft((d) => ({ ...d, daysBack }))}
              />
            </FormField>
            <Toggle
              checked={draft.cumulative}
              onChange={(cumulative) => setDraft((d) => ({ ...d, cumulative }))}
              label={t('cumulative')}
            />
          </>
        ) : null}
      </div>

      <Modal.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={!canSave}
          loading={saving}
          onClick={handleSave}
          data-testid="widget-config-save"
        >
          {t('save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function Stepper({
  id,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div
      id={id}
      className="inline-flex items-center gap-1 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) p-0.5"
    >
      <button
        type="button"
        aria-label="−"
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
        className="inline-flex size-7 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <Minus className="size-4" aria-hidden />
      </button>
      <span className="min-w-9 text-center text-sm font-semibold tabular-nums text-(--el-text)">
        {value}
      </span>
      <button
        type="button"
        aria-label="+"
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
        className="inline-flex size-7 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2.5 self-start text-sm text-(--el-text) focus-visible:outline-none"
    >
      <span
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          checked ? 'bg-(--el-accent)' : 'bg-(--el-border-strong)'
        }`}
      >
        <span
          className={`inline-block size-4 rounded-full bg-(--el-page-bg) transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </span>
      {label}
    </button>
  );
}
