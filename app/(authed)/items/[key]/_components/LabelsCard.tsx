'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { LabelDto } from '@/lib/dto/labels';
import { MultiSelectPicker, ValueChip } from '@/components/ui/MultiSelectPicker';
import { LABELS_PER_ISSUE_LIMIT } from '@/lib/labels/constants';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { FieldCard } from './FieldCard';
import { useLabelEditing } from '../../_components/fieldChipEditing';

// The Labels rail card (Story 5.4 · Subtask 5.4.8), per
// design/work-items/labels-components-watch.mock.html panel 2: the
// MultiSelectPicker with `onCreate` wired to the 5.4.2 folksonomy — options
// from the bounded `searchLabels` autocomplete (debounced), the create-row
// when the typed text matches nothing, coloured chips (the name-hash tint —
// the recorded less-enterprise deviation), the inline no-spaces 422 (the
// rejected text stays for correction), the cap hint at 20, and the read-only
// (viewer) chips-only rendering. Success confirms from the action response —
// no router.refresh (the inline-edit rule).

export function LabelsCard({
  workItemId,
  projectKey,
  initialLabels,
}: {
  workItemId: string;
  projectKey: string;
  initialLabels: LabelDto[];
}) {
  const t = useTranslations('issueViews');
  // MOTIR-2473 — the key this control's own write asserts:
  // `projectAccessService.assertCanEdit` resolves `work_item:edit`.
  const { can } = useProjectAccess();
  const canEdit = can('work_item:edit');
  // Open/closed stays with the CHROME — this card's FieldCard chevron. The
  // behaviour behind it is shared with the quick-view peek's rail row
  // (MOTIR-2566), so it lives in the hook, not here.
  const [editing, setEditing] = useState(false);
  const labels = useLabelEditing({ workItemId, projectKey, initialLabels, active: editing });
  const { chips, options, query, error, isPending, atCap } = labels;

  return (
    <FieldCard
      label={t('labelsField')}
      editable={canEdit}
      editing={editing}
      onToggle={() => {
        setEditing((cur) => !cur);
        labels.clearError();
        labels.setQuery('');
      }}
    >
      {editing ? (
        <MultiSelectPicker
          values={chips}
          options={options}
          onToggle={labels.toggle}
          onRemove={labels.remove}
          onCreate={labels.create}
          query={query}
          onQueryChange={labels.setQuery}
          cap={LABELS_PER_ISSUE_LIMIT}
          label={t('labelsField')}
          placeholder={t('labelsPlaceholder')}
          createLabel={(q) => t('labelsCreate', { name: q })}
          removeLabel={(label) => t('labelsRemove', { label })}
          hint={atCap ? t('labelsLimitReached', { limit: LABELS_PER_ISSUE_LIMIT }) : undefined}
          error={error}
          disabled={isPending}
        />
      ) : chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <ValueChip key={c.id} option={c} />
          ))}
        </div>
      ) : (
        <span className="text-(--el-text-secondary) italic">{t('noLabels')}</span>
      )}
    </FieldCard>
  );
}
