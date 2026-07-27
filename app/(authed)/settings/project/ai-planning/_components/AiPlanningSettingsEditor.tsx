'use client';

import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  Bot,
  Calendar,
  CloudOff,
  Info,
  Lock,
  Minus,
  Plus,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import {
  AI_AUTO_PLAN_THRESHOLD_MAX,
  AI_AUTO_PLAN_THRESHOLD_MIN,
  AI_SPRINT_LENGTH_DAYS_MAX,
  AI_SPRINT_LENGTH_DAYS_MIN,
} from '@/lib/projectAiSettings/limits';
import {
  PLANNER_MODEL_OPTIONS,
  choiceToPlannerModel,
  plannerModelToChoice,
  type PlannerModelChoice,
} from '@/lib/projectAiSettings/plannerModels';
import type { ProjectAiSettingsDto } from '@/lib/dto/projectAiSettings';

// AiPlanningSettingsEditor (Story 7.13 · Subtask MOTIR-919) — the AI-planning
// project settings panel, per design/ai-settings/ai-planning-settings.mock.html
// + design-notes.md (§1 placement, §5 primitives, §6 copy, §8 states, §9 tokens,
// §10 a11y).
//
// A pure client consumer of the MOTIR-919 `PATCH /api/projects/[key]/ai-settings`
// endpoint (the settings-page fetch idiom, mirroring EstimationSettingsEditor —
// NOT a server action): the Save is optimistic-with-reconcile (the committed
// snapshot flips immediately, reverts + toasts on failure). It never touches the
// service layer — the route → projectAiSettingsService → the MOTIR-915
// repository methods is the only path to the columns. The server re-gates the
// write (assertCanManage), so `isAdmin` here only governs whether the edit
// affordances render.
//
// Three cards, one shared footer on the LAST card governing the whole page's
// dirty state — three decisions with different blast radius (when to expand ·
// how to pack sprints · which model runs), and a project may want one without
// the others:
//   * Auto-plan          — aiAutoPlanEnabled + aiAutoPlanThreshold
//   * AI sprint planning — aiSprintPlanningEnabled + aiSprintLengthDays
//   * Planner            — aiGenerateExplanations (the Story-7.4 column
//                          SURFACED here, never duplicated) + aiPlannerModel
//
// A dependent control is present but DISABLED, never hidden (the reader sees
// what the switch unlocks); its group's explanatory callout appears only when
// the setting is live, so the default view stays quiet.
//
// Colour strictly `--el-*` (finding #54) with the three callouts on three
// DISTINCT tint slots + `--el-text-strong` text (AA, finding #35); shape via the
// element-semantic tokens. The stepper is a COMPOSITION of a number input and
// two icon buttons — not a new primitive.

/** The panel's working state — the DTO plus the picker's sentinel form. */
interface WorkingSettings {
  autoPlanEnabled: boolean;
  autoPlanThreshold: string;
  sprintPlanningEnabled: boolean;
  sprintLengthDays: string;
  generateExplanations: boolean;
  plannerModel: PlannerModelChoice;
}

/** The persisted DTO → the panel's working state. */
function toWorking(dto: ProjectAiSettingsDto): WorkingSettings {
  return {
    autoPlanEnabled: dto.aiAutoPlanEnabled,
    autoPlanThreshold: String(dto.aiAutoPlanThreshold),
    sprintPlanningEnabled: dto.aiSprintPlanningEnabled,
    sprintLengthDays: String(dto.aiSprintLengthDays),
    generateExplanations: dto.aiGenerateExplanations,
    plannerModel: plannerModelToChoice(dto.aiPlannerModel),
  };
}

/** Whether two working states are equal (the dirty check). Exported for the test. */
export function aiSettingsEqual(a: WorkingSettings, b: WorkingSettings): boolean {
  return (
    a.autoPlanEnabled === b.autoPlanEnabled &&
    a.autoPlanThreshold === b.autoPlanThreshold &&
    a.sprintPlanningEnabled === b.sprintPlanningEnabled &&
    a.sprintLengthDays === b.sprintLengthDays &&
    a.generateExplanations === b.generateExplanations &&
    a.plannerModel === b.plannerModel
  );
}

/**
 * A stepper value is valid when it is a whole number at or above `min`, and at
 * or below `max` when one is given.
 *
 * The client MIRRORS — never replaces — the MOTIR-915 server validation, and it
 * mirrors exactly what the design's copy promises per field: the threshold is
 * checked against its FLOOR only ("Enter 1 or more ready items."), the sprint
 * length against its full RANGE ("Choose a sprint length between 1 and 14
 * days."). The threshold's app-level ceiling (`AI_AUTO_PLAN_THRESHOLD_MAX`) is
 * still enforced — by the stepper's `+` button, which stops there, and by the
 * server, whose typed 422 names the field so its message lands in that same
 * slot. Inventing a second client message for a bound the design never wrote
 * would be copy the asset does not specify. Exported for the test.
 */
export function isWholeNumberInRange(raw: string, min: number, max?: number): boolean {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return false;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min) return false;
  return max === undefined || value <= max;
}

export function AiPlanningSettingsEditor({
  projectKey,
  projectName,
  settings,
  isAdmin,
  aiConfigured,
}: {
  projectKey: string;
  projectName: string;
  settings: ProjectAiSettingsDto;
  isAdmin: boolean;
  aiConfigured: boolean;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { toast } = useToast();

  // `committed` is the last-persisted state (the optimistic snapshot target);
  // `working` holds the in-flight edits. dirty = working ≠ committed.
  const [committed, setCommitted] = useState<WorkingSettings>(() => toWorking(settings));
  const [working, setWorking] = useState<WorkingSettings>(() => toWorking(settings));
  const [saving, setSaving] = useState(false);
  // A typed server rejection (422), slotted under the field it names.
  const [serverError, setServerError] = useState<{ field: string; message: string } | null>(null);

  // Every control is inert when the actor can't write, or when this deployment
  // has no Motir AI connection to run the cadence (§8.6 — stated reason, no
  // invented "Connect" CTA).
  const locked = !isAdmin || !aiConfigured;

  const patch = useCallback((next: Partial<WorkingSettings>) => {
    setWorking((prev) => ({ ...prev, ...next }));
    setServerError(null);
  }, []);

  // Floor-only, per the design's copy (§8.3 + §6): the ceiling is enforced by
  // the stepper's `+` button and by the server's typed 422.
  const thresholdValid = isWholeNumberInRange(
    working.autoPlanThreshold,
    AI_AUTO_PLAN_THRESHOLD_MIN,
  );
  const sprintLengthValid = isWholeNumberInRange(
    working.sprintLengthDays,
    AI_SPRINT_LENGTH_DAYS_MIN,
    AI_SPRINT_LENGTH_DAYS_MAX,
  );
  const valid = thresholdValid && sprintLengthValid;
  const dirty = !aiSettingsEqual(working, committed);
  const canSave = isAdmin && !locked && dirty && valid && !saving;

  const reset = useCallback(() => {
    setWorking(committed);
    setServerError(null);
  }, [committed]);

  const save = useCallback(() => {
    if (!isAdmin || locked || !valid) return;
    const prev = committed;
    const next = working;
    // Optimistic: the committed snapshot flips now; reconcile / revert on the
    // response. The success response IS the confirmation — no router.refresh()
    // (CLAUDE.md § page state: refreshing the cell's own value causes a revert).
    setCommitted(next);
    setSaving(true);
    setServerError(null);
    void fetch(`/api/projects/${encodeURIComponent(projectKey)}/ai-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        aiAutoPlanEnabled: next.autoPlanEnabled,
        aiAutoPlanThreshold: Number(next.autoPlanThreshold),
        aiSprintPlanningEnabled: next.sprintPlanningEnabled,
        aiSprintLengthDays: Number(next.sprintLengthDays),
        aiGenerateExplanations: next.generateExplanations,
        aiPlannerModel: choiceToPlannerModel(next.plannerModel),
      }),
    })
      .then(async (res) => {
        if (res.ok) {
          setSaving(false);
          toast({
            variant: 'success',
            title: t('aiPlanning.savedTitle'),
            description: t('aiPlanning.savedDesc', { project: projectName }),
          });
          return;
        }
        // Revert the optimistic snapshot, then route the failure: a typed 422
        // names the offending field, so its message lands in that field's own
        // slot (§8.3) instead of a generic toast.
        setCommitted(prev);
        setSaving(false);
        const body = (await res.json().catch(() => null)) as {
          field?: string;
          error?: string;
        } | null;
        if (res.status === 422 && body?.field && body.error) {
          setServerError({ field: body.field, message: body.error });
          return;
        }
        toast({
          variant: 'error',
          title: t('aiPlanning.errorTitle'),
          description: t('aiPlanning.saveError'),
        });
      })
      .catch(() => {
        setCommitted(prev);
        setSaving(false);
        toast({
          variant: 'error',
          title: t('aiPlanning.errorTitle'),
          description: t('aiPlanning.saveError'),
        });
      });
  }, [isAdmin, locked, valid, committed, working, projectKey, projectName, t, toast]);

  const notConnected = !aiConfigured ? <NotConnectedBanner /> : null;

  return (
    <div className="flex flex-col gap-5" data-testid="ai-planning-settings">
      {/* ── Card 1 · Auto-plan ─────────────────────────────────────────────── */}
      <SettingsCard
        icon={<Sparkles className="size-[17px]" aria-hidden />}
        title={t('aiPlanning.autoPlan.title')}
        subtitle={t('aiPlanning.autoPlan.subtitle')}
      >
        {notConnected}
        {!isAdmin ? <ReadOnlyBanner /> : null}

        <SwitchRow
          checked={working.autoPlanEnabled}
          onCheckedChange={(v) => patch({ autoPlanEnabled: v })}
          disabled={locked}
          label={t('aiPlanning.autoPlan.enableLabel')}
          hint={t('aiPlanning.autoPlan.enableHint')}
        />

        <DependentField
          label={t('aiPlanning.autoPlan.thresholdLabel')}
          hint={t('aiPlanning.autoPlan.thresholdHint')}
          disabled={locked || !working.autoPlanEnabled}
        >
          {(ids) => (
            <>
              <Stepper
                value={working.autoPlanThreshold}
                onChange={(v) => patch({ autoPlanThreshold: v })}
                min={AI_AUTO_PLAN_THRESHOLD_MIN}
                max={AI_AUTO_PLAN_THRESHOLD_MAX}
                disabled={locked || !working.autoPlanEnabled}
                unit={t('aiPlanning.autoPlan.thresholdUnit')}
                ariaLabel={t('aiPlanning.autoPlan.thresholdLabel')}
                decreaseLabel={t('aiPlanning.autoPlan.decreaseAria')}
                increaseLabel={t('aiPlanning.autoPlan.increaseAria')}
                describedBy={ids.describedBy}
                invalid={!thresholdValid || serverError?.field === 'aiAutoPlanThreshold'}
                testId="ai-planning-threshold"
              />
              {!thresholdValid ? (
                <FieldError id={ids.errorId} testId="ai-planning-threshold-error">
                  {t('aiPlanning.autoPlan.thresholdInvalid')}
                </FieldError>
              ) : serverError?.field === 'aiAutoPlanThreshold' ? (
                <FieldError id={ids.errorId} testId="ai-planning-threshold-error">
                  {serverError.message}
                </FieldError>
              ) : null}
              {working.autoPlanEnabled ? (
                <Callout tint="sky" icon={<Info className="size-[15px]" aria-hidden />}>
                  {t.rich('aiPlanning.autoPlan.guardrail', {
                    strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
                  })}
                </Callout>
              ) : null}
            </>
          )}
        </DependentField>
      </SettingsCard>

      {/* ── Card 2 · AI sprint planning ────────────────────────────────────── */}
      <SettingsCard
        icon={<Calendar className="size-[17px]" aria-hidden />}
        title={t('aiPlanning.sprint.title')}
        subtitle={t('aiPlanning.sprint.subtitle')}
      >
        {notConnected}

        <SwitchRow
          checked={working.sprintPlanningEnabled}
          onCheckedChange={(v) => patch({ sprintPlanningEnabled: v })}
          disabled={locked}
          label={t('aiPlanning.sprint.enableLabel')}
          hint={t('aiPlanning.sprint.enableHint')}
        />

        <DependentField
          label={t('aiPlanning.sprint.lengthLabel')}
          hint={t('aiPlanning.sprint.lengthHint')}
          disabled={locked || !working.sprintPlanningEnabled}
        >
          {(ids) => (
            <>
              <Stepper
                value={working.sprintLengthDays}
                onChange={(v) => patch({ sprintLengthDays: v })}
                min={AI_SPRINT_LENGTH_DAYS_MIN}
                max={AI_SPRINT_LENGTH_DAYS_MAX}
                disabled={locked || !working.sprintPlanningEnabled}
                unit={t('aiPlanning.sprint.lengthUnit')}
                ariaLabel={t('aiPlanning.sprint.lengthLabel')}
                decreaseLabel={t('aiPlanning.sprint.decreaseAria')}
                increaseLabel={t('aiPlanning.sprint.increaseAria')}
                describedBy={ids.describedBy}
                invalid={!sprintLengthValid || serverError?.field === 'aiSprintLengthDays'}
                testId="ai-planning-sprint-length"
              />
              {!sprintLengthValid ? (
                <FieldError id={ids.errorId} testId="ai-planning-sprint-length-error">
                  {t('aiPlanning.sprint.lengthInvalid')}
                </FieldError>
              ) : serverError?.field === 'aiSprintLengthDays' ? (
                <FieldError id={ids.errorId} testId="ai-planning-sprint-length-error">
                  {serverError.message}
                </FieldError>
              ) : null}
              {working.sprintPlanningEnabled ? (
                <Callout tint="lavender" icon={<Info className="size-[15px]" aria-hidden />}>
                  {t('aiPlanning.sprint.rationale')}
                </Callout>
              ) : null}
            </>
          )}
        </DependentField>
      </SettingsCard>

      {/* ── Card 3 · Planner (+ the shared footer) ─────────────────────────── */}
      <SettingsCard
        icon={<Bot className="size-[17px]" aria-hidden />}
        title={t('aiPlanning.planner.title')}
        subtitle={t('aiPlanning.planner.subtitle')}
        footer={
          isAdmin ? (
            <div className="bg-(--el-surface-soft) border-(--el-border-soft) flex items-center justify-end gap-2.5 border-t px-(--spacing-card-padding) py-3.5">
              <span
                className="text-(--el-text-muted) mr-auto text-xs"
                data-testid="ai-planning-footer-hint"
              >
                {!valid
                  ? t('aiPlanning.footer.invalidHint')
                  : dirty
                    ? t('aiPlanning.footer.dirtyHint')
                    : null}
              </span>
              <Button variant="secondary" onClick={reset} disabled={!dirty || saving}>
                {tc('cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={save}
                loading={saving}
                disabled={!canSave}
                data-testid="ai-planning-save"
              >
                {t('aiPlanning.footer.save')}
              </Button>
            </div>
          ) : null
        }
      >
        {notConnected}

        <SwitchRow
          checked={working.generateExplanations}
          onCheckedChange={(v) => patch({ generateExplanations: v })}
          disabled={locked}
          label={t('aiPlanning.planner.explanationsLabel')}
          hint={t('aiPlanning.planner.explanationsHint')}
        />

        <PlannerModelField
          value={working.plannerModel}
          onChange={(v) => patch({ plannerModel: v })}
          disabled={locked}
          serverError={serverError?.field === 'aiPlannerModel' ? serverError.message : null}
        />
      </SettingsCard>
    </div>
  );
}

// ── Card shell — the shipped settings-card grammar (EstimationSettingsEditor) ──
// A full-bleed head divider + an `--el-surface-soft` footer band, which the Card
// primitive's uniform `--spacing-card-padding` box cannot express; every token
// (radius, padding, border, shadow) is still the element-semantic one.

function SettingsCard({
  icon,
  title,
  subtitle,
  footer,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-surface="card"
      className="bg-(--el-card) border-(--el-border) shadow-(--shadow-card) overflow-hidden rounded-(--radius-card) border"
    >
      <div className="border-(--el-border-soft) flex items-start gap-2.5 border-b px-(--spacing-card-padding) py-4">
        <span className="text-(--el-icon-heading) mt-px shrink-0">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold text-(--el-text)">{title}</h2>
          <p className="text-(--el-text-muted) mt-0.5 max-w-[58ch] text-xs">{subtitle}</p>
        </div>
      </div>
      <div className="flex flex-col gap-5 px-(--spacing-card-padding) py-5">{children}</div>
      {footer}
    </section>
  );
}

// ── Switch row — the primitive + its visible label + hint ─────────────────────
// The accessible name comes by REFERENCE (aria-labelledby → the visible label),
// so it can never drift from the text on screen (§10).

function SwitchRow({
  checked,
  onCheckedChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled: boolean;
  label: string;
  hint: string;
}) {
  const labelId = useId();
  return (
    <div className="flex items-start gap-3.5">
      <span className="mt-0.5">
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-labelledby={labelId}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span id={labelId} className="block text-sm font-medium text-(--el-text)">
          {label}
        </span>
        <p className="text-(--el-text-helper) mt-0.5 max-w-[54ch] text-xs leading-relaxed">
          {hint}
        </p>
      </span>
    </div>
  );
}

// ── Dependent field — indented under its parent switch, present-but-disabled ──
// A disabled dependent keeps its layout and stays legible (only its text tokens
// drop to `--el-text-faint`); it is `disabled`, never `aria-hidden`, so a screen
// reader sees the same unavailable option a sighted user does (§8.1, §10).

function DependentField({
  label,
  hint,
  disabled,
  children,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  children: (ids: { describedBy: string; errorId: string }) => ReactNode;
}) {
  const hintId = useId();
  const errorId = useId();
  return (
    <div className="border-(--el-border-soft) ml-[50px] flex flex-col gap-1.5 border-l pl-3.5">
      <span
        className={`text-sm font-medium ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text)'}`}
      >
        {label}
      </span>
      <p
        id={hintId}
        className={`max-w-[52ch] text-xs leading-relaxed ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text-helper)'}`}
      >
        {hint}
      </p>
      {children({ describedBy: `${hintId} ${errorId}`, errorId })}
    </div>
  );
}

// ── Stepper — a COMPOSITION of a number input and two icon buttons ────────────
// Not a new primitive (§5). Each button disables at its end of the range, so the
// ordinary path cannot produce an invalid value; the error state exists for
// typed input.

function Stepper({
  value,
  onChange,
  min,
  max,
  disabled,
  unit,
  ariaLabel,
  decreaseLabel,
  increaseLabel,
  describedBy,
  invalid,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  min: number;
  max: number;
  disabled: boolean;
  unit: string;
  ariaLabel: string;
  decreaseLabel: string;
  increaseLabel: string;
  describedBy: string;
  invalid: boolean;
  testId: string;
}) {
  const numeric = Number(value.trim());
  const steppable = /^-?\d+$/.test(value.trim());
  const step = useCallback(
    (delta: number) => {
      const base = steppable ? numeric : min;
      const next = Math.min(max, Math.max(min, base + delta));
      onChange(String(next));
    },
    [steppable, numeric, min, max, onChange],
  );

  const iconButton =
    'inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) border border-(--el-button-border) bg-(--el-page-bg) text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="mt-0.5 inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={disabled || (steppable && numeric <= min)}
        aria-label={decreaseLabel}
        className={iconButton}
      >
        <Minus className="size-[15px]" aria-hidden />
      </button>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        className={`h-(--height-control) w-[74px] rounded-(--radius-input) border bg-(--el-page-bg) text-center font-mono text-sm font-semibold text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:cursor-not-allowed disabled:opacity-50 ${
          invalid ? 'border-(--el-danger)' : 'border-(--el-input-border)'
        }`}
      />
      <button
        type="button"
        onClick={() => step(1)}
        disabled={disabled || (steppable && numeric >= max)}
        aria-label={increaseLabel}
        className={iconButton}
      >
        <Plus className="size-[15px]" aria-hidden />
      </button>
      <span className={`text-xs ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text-muted)'}`}>
        {unit}
      </span>
    </div>
  );
}

// ── Planner-model picker — the shipped Combobox, label + secondary rows ───────

function PlannerModelField({
  value,
  onChange,
  disabled,
  serverError,
}: {
  value: PlannerModelChoice;
  onChange: (next: PlannerModelChoice) => void;
  disabled: boolean;
  serverError: string | null;
}) {
  const t = useTranslations('settings');
  const hintId = useId();
  const errorId = useId();

  const options = useMemo(
    () =>
      PLANNER_MODEL_OPTIONS.map((option) => ({
        value: option.value,
        label: t(`aiPlanning.planner.${option.labelKey}`),
        secondary: option.modelId ?? t('aiPlanning.planner.modelDefaultSecondary'),
      })),
    [t],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <span
        className={`text-sm font-medium ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text)'}`}
      >
        {t('aiPlanning.planner.modelLabel')}
      </span>
      <p
        id={hintId}
        className={`max-w-[52ch] text-xs leading-relaxed ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text-helper)'}`}
      >
        {t('aiPlanning.planner.modelHint')}
      </p>
      <div className="mt-0.5 w-full max-w-[320px]">
        <Combobox
          options={options}
          value={value}
          onChange={onChange}
          label={t('aiPlanning.planner.modelLabel')}
          searchable={false}
          disabled={disabled}
        />
      </div>
      {serverError ? (
        <FieldError id={errorId} testId="ai-planning-model-error">
          {serverError}
        </FieldError>
      ) : null}
    </div>
  );
}

// ── Inline validation message — announced on appearance (§10) ─────────────────

function FieldError({ id, testId, children }: { id: string; testId: string; children: ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      data-testid={testId}
      className="mt-0.5 flex items-center gap-1.5 text-xs text-(--el-danger)"
    >
      <AlertCircle className="size-[13px] shrink-0" aria-hidden />
      {children}
    </p>
  );
}

// ── Banners + callouts — three DISTINCT tint slots so they never read alike ───

function Callout({
  tint,
  icon,
  children,
  testId,
}: {
  tint: 'sky' | 'lavender' | 'peach' | 'plain';
  icon: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const surface =
    tint === 'sky'
      ? 'bg-(--el-tint-sky) border-(--el-border-soft) text-(--el-text-strong)'
      : tint === 'lavender'
        ? 'bg-(--el-tint-lavender) border-(--el-border-soft) text-(--el-text-strong)'
        : tint === 'peach'
          ? 'bg-(--el-tint-peach) border-(--el-border-soft) text-(--el-text-strong)'
          : 'bg-(--el-surface) border-(--el-border) text-(--el-text-secondary)';
  const iconTone =
    tint === 'sky'
      ? 'text-(--el-info)'
      : tint === 'lavender'
        ? 'text-(--el-accent-on-surface)'
        : tint === 'peach'
          ? 'text-(--el-warning)'
          : 'text-(--el-icon-muted)';
  return (
    <div
      data-testid={testId}
      className={`flex gap-2.5 rounded-(--radius-card) border px-3.5 py-2.5 text-xs leading-relaxed ${surface}`}
    >
      <span className={`mt-px shrink-0 ${iconTone}`}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function ReadOnlyBanner() {
  const t = useTranslations('settings');
  return (
    <Callout
      tint="plain"
      icon={<Lock className="size-[15px]" aria-hidden />}
      testId="ai-planning-readonly-banner"
    >
      {t('aiPlanning.readOnlyBanner')}
    </Callout>
  );
}

function NotConnectedBanner() {
  const t = useTranslations('settings');
  return (
    <Callout
      tint="peach"
      icon={<CloudOff className="size-[15px]" aria-hidden />}
      testId="ai-planning-not-connected-banner"
    >
      <strong className="font-semibold">{t('aiPlanning.notConnectedTitle')}</strong>{' '}
      {t('aiPlanning.notConnectedBody')}
    </Callout>
  );
}
