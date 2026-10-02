'use client';

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox } from '@/components/ui/Combobox';
import type { HostedModelsState, HostedResolvedModel } from './hostedModels';

// THE MODEL PICKER at the Run hosted door (Story MOTIR-683 · MOTIR-691;
// `design/runs/design-notes.md` § The model picker).
//
// ⚠️ THE SHIPPED PRIMITIVE, NOT A SECOND ONE: the `Combobox`, composed as
// `design/runs/design-notes.md` § The model picker draws it (and as the Hosted
// agent settings room's per-difficulty pickers compose it, `design/settings/
// hosted-agent.mock.html`) — `searchable={false}`, each option's label the model
// and its `secondary` text on the right. It is never a
// free-text field: what the route answers is what it offers, and it keeps no list
// of its own.
//
// ⚠️ THREE FACES, NEVER ONE. Loading keeps the trigger's size; UNAVAILABLE
// (motir-ai did not answer) and EMPTY (it answered: no model) are opposite facts,
// and each disables the door. Their body lines are the Run section's.
//
// ⚠️ WHERE THE PRESELECTION CAME FROM (Story MOTIR-6989 · MOTIR-6996;
// `design/runs/design-notes.md` § Run hosted — the picker says where its model
// came from, Panels F1–F6). Given a `provenance`, the preselected option carries
// the line as its `description` in the open menu, and the trigger is
// `aria-describedby` the door's line (`HostedModelProvenance`, which the DOOR
// renders as its row's last child — the picker's 15rem column would wrap it).
// The *Default* label is a fact about the model, the line one about the choice:
// both can show.

/** The line's message key — a leaf's own difficulty or a parent's leaves', and who chose. */
function provenanceKey(
  r: HostedResolvedModel,
): 'fromDifficulty' | 'override' | 'fromLeaves' | 'overrideFromLeaves' {
  const override = r.source === 'override';
  if (r.fromLeaves) return override ? 'overrideFromLeaves' : 'fromLeaves';
  return override ? 'override' : 'fromDifficulty';
}

function useDifficultyLabel(r: HostedResolvedModel | null): string {
  const tLevel = useTranslations('labels.difficulty');
  return r?.difficulty ? tLevel(r.difficulty) : '';
}

/**
 * The door's source line (design F1–F3, F5): the LAST child of the door row,
 * full width, under the picker. Renders nothing without a provenance (F4, F6).
 */
export function HostedModelProvenance({
  provenance,
  id,
}: {
  provenance: HostedResolvedModel | null;
  id: string;
}) {
  const t = useTranslations('runs.hosted.picker');
  const difficulty = useDifficultyLabel(provenance);
  if (!provenance) return null;
  return (
    <p
      id={id}
      className="-mt-1 basis-full px-0.5 text-xs leading-snug text-(--el-text-secondary)"
      data-testid="hosted-model-provenance"
    >
      {t.rich(provenanceKey(provenance), {
        difficulty,
        b: (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
      })}
    </p>
  );
}

export function HostedModelPicker({
  models,
  value,
  onChange,
  disabled,
  provenance = null,
  describedBy,
}: {
  models: HostedModelsState;
  value: string | null;
  onChange: (id: string) => void;
  disabled: boolean;
  /** The resolution the preselected model came from — null draws no line (F4, F6). */
  provenance?: HostedResolvedModel | null;
  /** The id of the door's `HostedModelProvenance` line, for the trigger. */
  describedBy?: string;
}) {
  const t = useTranslations('runs.hosted.picker');
  const difficulty = useDifficultyLabel(provenance);
  const rootRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    if (models.state !== 'ok') return [];
    return models.models.map((m) => ({
      value: m.id,
      label: m.id,
      secondary:
        m.id === models.default ? t('defaultSecondary', { provider: m.provider }) : m.provider,
      ...(provenance && m.id === provenance.model
        ? // The open menu's `description` is a string: the line, as plain text (F5).
          { description: t.markup(provenanceKey(provenance), { difficulty, b: (c) => c }) }
        : {}),
    }));
  }, [models, t, provenance, difficulty]);

  // The shipped `Combobox` takes no `aria-describedby`, so the trigger is pointed
  // at the door's line here; the attribute goes with the line.
  const described = provenance && describedBy ? describedBy : null;
  useEffect(() => {
    const trigger = rootRef.current?.querySelector('[role="combobox"]');
    if (!trigger) return;
    if (described) trigger.setAttribute('aria-describedby', described);
    else trigger.removeAttribute('aria-describedby');
  }, [described]);

  const placeholder =
    models.state === 'loading'
      ? t('loadingTrigger')
      : models.state === 'unavailable'
        ? t('unavailableTrigger')
        : models.models.length === 0
          ? t('emptyTrigger')
          : undefined;

  const offline = models.state !== 'ok' || models.models.length === 0;

  return (
    <div ref={rootRef} className="w-[15rem] max-w-full" data-testid="hosted-model-picker">
      <Combobox
        options={options}
        value={offline ? null : value}
        onChange={onChange}
        label={t('label')}
        placeholder={placeholder}
        searchable={false}
        disabled={disabled || offline}
        footer={<span className="text-xs text-(--el-text-secondary)">{t('footer')}</span>}
      />
    </div>
  );
}
