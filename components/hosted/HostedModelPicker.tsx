'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox } from '@/components/ui/Combobox';
import type { HostedModelsState } from './hostedModels';

// THE MODEL PICKER at the Run hosted door (Story MOTIR-683 · MOTIR-691;
// `design/runs/design-notes.md` § The model picker).
//
// ⚠️ THE PLANNING PICKER'S PRIMITIVE, NOT A SECOND ONE: the shipped `Combobox`,
// composed exactly as `PlannerModelField` composes it — `searchable={false}`, each
// option's label the model and its `secondary` text on the right. It is never a
// free-text field: what the route answers is what it offers, and it keeps no list
// of its own.
//
// ⚠️ THREE FACES, NEVER ONE. Loading keeps the trigger's size; UNAVAILABLE
// (motir-ai did not answer) and EMPTY (it answered: no model) are opposite facts,
// and each disables the door. Their body lines are the Run section's.

export function HostedModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: HostedModelsState;
  value: string | null;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  const t = useTranslations('runs.hosted.picker');

  const options = useMemo(() => {
    if (models.state !== 'ok') return [];
    return models.models.map((m) => ({
      value: m.id,
      label: m.id,
      secondary:
        m.id === models.default ? t('defaultSecondary', { provider: m.provider }) : m.provider,
    }));
  }, [models, t]);

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
    <div className="w-[15rem] max-w-full" data-testid="hosted-model-picker">
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
