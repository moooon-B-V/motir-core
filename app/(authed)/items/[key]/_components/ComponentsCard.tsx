'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Component } from 'lucide-react';
import type { ComponentDto } from '@/lib/dto/components';
import {
  MultiSelectPicker,
  ValueChip,
  type MultiSelectOption,
} from '@/components/ui/MultiSelectPicker';
import { useComponentEditing } from '../../_components/fieldChipEditing';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { FieldCard } from './FieldCard';

// The Components rail card (Story 5.4 · Subtask 5.4.8), per
// design/work-items/labels-components-watch.mock.html panel 3: the SAME
// MultiSelectPicker, `onCreate` absent — an admin-managed taxonomy never
// grows from the issue field (mirror: company-managed Jira). Options are the
// project's components (server-fetched by the page, name-ordered), filtered
// client-side as you type; rows and chips carry the lucide `component` glyph
// and stay NEUTRAL (the label/component facets read differently at a
// glance). An empty project shows "No components defined" plus the quiet
// admin link — project admins only. Success confirms from the action
// response — no router.refresh (the inline-edit rule).

function toOption(component: { id: string; name: string }): MultiSelectOption {
  return { id: component.id, label: component.name, glyph: Component };
}

export function ComponentsCard({
  workItemId,
  initialComponents,
  projectComponents,
  canManageProject,
}: {
  workItemId: string;
  initialComponents: ComponentDto[];
  /** The project taxonomy (name-ordered) — the picker's option source. */
  projectComponents: ComponentDto[];
  /** Gates the empty-project "Manage components" link (admins only). */
  canManageProject: boolean;
}) {
  const t = useTranslations('issueViews');
  // MOTIR-2473 — the key this control's own write asserts:
  // `projectAccessService.assertCanEdit` resolves `work_item:edit`.
  const { can } = useProjectAccess();
  const canEdit = can('work_item:edit');
  // Open/closed stays with the CHROME; the behaviour is shared with the
  // quick-view peek's rail row (MOTIR-2566).
  const [editing, setEditing] = useState(false);
  const comps = useComponentEditing({
    workItemId,
    initialComponents,
    projectComponents,
    toOption,
  });
  const { chips, options, query, error, isPending, emptyTaxonomy } = comps;

  return (
    <FieldCard
      label={t('componentsField')}
      editable={canEdit}
      editing={editing}
      onToggle={() => {
        setEditing((cur) => !cur);
        comps.clearError();
        comps.setQuery('');
      }}
    >
      {editing ? (
        <MultiSelectPicker
          values={chips}
          options={options}
          onToggle={comps.toggle}
          onRemove={comps.remove}
          query={query}
          onQueryChange={comps.setQuery}
          label={t('componentsField')}
          placeholder={t('componentsPlaceholder')}
          removeLabel={(label) => t('componentsRemove', { label })}
          emptyText={t('componentsNoneDefined')}
          hint={
            emptyTaxonomy && canManageProject ? (
              // The quiet admin line (panel 3) — the settings hub carries the
              // Components card; 5.4.10 may deepen the target to its own page.
              <Link
                href="/settings/project"
                className="text-(--el-link) hover:text-(--el-link-pressed) hover:underline"
              >
                {t('componentsManageLink')}
              </Link>
            ) : undefined
          }
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
        <span className="text-(--el-text-secondary) italic">{t('noComponents')}</span>
      )}
    </FieldCard>
  );
}
