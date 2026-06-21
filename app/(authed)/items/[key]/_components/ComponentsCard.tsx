'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Component } from 'lucide-react';
import type { ComponentDto } from '@/lib/dto/components';
import {
  MultiSelectPicker,
  ValueChip,
  type MultiSelectOption,
} from '@/components/ui/MultiSelectPicker';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { FieldCard } from './FieldCard';
import { addComponentAction, removeComponentAction } from '../labelComponentActions';

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

function toOption(component: ComponentDto): MultiSelectOption {
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
  const { canEdit } = useProjectAccess();
  const [isPending, startTransition] = useTransition();
  const [components, setComponents] = useState<ComponentDto[]>(initialComponents);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  function applyResult(res: Awaited<ReturnType<typeof addComponentAction>>) {
    if (res.ok) {
      setComponents(res.components);
      setError(null);
    } else {
      setError(res.error);
    }
  }

  function toggle(option: MultiSelectOption) {
    setError(null);
    startTransition(async () => {
      const attached = components.some((c) => c.id === option.id);
      applyResult(
        attached
          ? await removeComponentAction({ workItemId, componentId: option.id })
          : await addComponentAction({ workItemId, componentId: option.id }),
      );
    });
  }

  function remove(value: MultiSelectOption) {
    setError(null);
    startTransition(async () => {
      applyResult(await removeComponentAction({ workItemId, componentId: value.id }));
    });
  }

  const q = query.trim().toLowerCase();
  const options = (
    q ? projectComponents.filter((c) => c.name.toLowerCase().includes(q)) : projectComponents
  ).map(toOption);
  const chips = components.map(toOption);
  const emptyTaxonomy = projectComponents.length === 0;

  return (
    <FieldCard
      label={t('componentsField')}
      editable={canEdit}
      editing={editing}
      onToggle={() => {
        setEditing((cur) => !cur);
        setError(null);
        setQuery('');
      }}
    >
      {editing ? (
        <MultiSelectPicker
          values={chips}
          options={options}
          onToggle={toggle}
          onRemove={remove}
          query={query}
          onQueryChange={(next) => {
            setQuery(next);
            setError(null);
          }}
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
