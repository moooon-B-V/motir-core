'use client';

import { useEffect, useRef, useState } from 'react';
import { Bookmark, Folder } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { FormField } from '@/components/ui/FormField';
import { Segmented } from '@/components/ui/Segmented';
import type { SavedFilterPageDto } from '@/lib/dto/savedFilters';

// The data-source XOR control (6.3.5, design panel 4): a Segmented
// `Saved filter | Project` that swaps the Combobox below it, so EXACTLY ONE of
// `savedFilterId` / `projectId` is ever set (the 6.3.1 422 on both/neither).
// The shared control across all three editor kinds (and, later, the 6.3.6
// report pages). Projects come from the server; saved filters are fetched
// across the workspace's projects (each project-contained — the 6.2 deviation —
// so a workspace dashboard aggregates widget-by-widget).

export interface ProjectLite {
  id: string;
  name: string;
  identifier: string;
}

export type SourceKind = 'saved_filter' | 'project';

export interface SourceValue {
  kind: SourceKind;
  savedFilterId: string | null;
  projectId: string | null;
}

interface FilterOption {
  id: string;
  name: string;
  projectName: string;
}

export function DataSourceField({
  projects,
  value,
  onChange,
}: {
  projects: ProjectLite[];
  value: SourceValue;
  onChange: (next: SourceValue) => void;
}) {
  const t = useTranslations('dashboards.config');
  const [filters, setFilters] = useState<FilterOption[] | null>(null);
  const fetchingRef = useRef(false);
  // Loading is DERIVED (no sync setState in the effect — the rule): we're
  // loading while in saved-filter mode and the list hasn't resolved yet.
  const loadingFilters = value.kind === 'saved_filter' && filters === null;

  // Lazily load saved filters across the workspace's projects the first time
  // the user switches to the saved-filter source. State is set only in the
  // resolved callback; a ref guards against a duplicate in-flight fetch.
  useEffect(() => {
    if (value.kind !== 'saved_filter' || filters !== null || fetchingRef.current) return;
    let cancelled = false;
    fetchingRef.current = true;
    void Promise.all(
      projects.map((p) =>
        fetch(`/api/projects/${encodeURIComponent(p.identifier)}/saved-filters?view=all`, {
          headers: { accept: 'application/json' },
        })
          .then((res) => (res.ok ? (res.json() as Promise<SavedFilterPageDto>) : null))
          .then((page) =>
            (page?.items ?? []).map((f) => ({ id: f.id, name: f.name, projectName: p.name })),
          )
          .catch(() => [] as FilterOption[]),
      ),
    ).then((perProject) => {
      fetchingRef.current = false;
      if (!cancelled) setFilters(perProject.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [value.kind, filters, projects]);

  const projectOptions: ComboboxOption<string>[] = projects.map((p) => ({
    value: p.id,
    label: p.name,
    icon: <Folder className="size-4" aria-hidden />,
  }));

  const filterOptions: ComboboxOption<string>[] = (filters ?? []).map((f) => ({
    value: f.id,
    label: f.name,
    secondary: f.projectName,
    keywords: f.projectName,
    icon: <Bookmark className="size-4" aria-hidden />,
  }));

  return (
    <div className="flex flex-col gap-3">
      <FormField label={t('dataSource')} htmlFor="widget-source-kind">
        <div id="widget-source-kind">
          <Segmented
            label={t('dataSource')}
            options={[
              { value: 'saved_filter', label: t('sourceFilter') },
              { value: 'project', label: t('sourceProject') },
            ]}
            value={value.kind}
            onChange={(kind) => onChange({ kind, savedFilterId: null, projectId: null })}
          />
        </div>
      </FormField>

      {value.kind === 'project' ? (
        <FormField label={t('sourceProject')} htmlFor="widget-project">
          <Combobox
            label={t('pickProject')}
            placeholder={projects.length === 0 ? t('noProjects') : t('pickProject')}
            options={projectOptions}
            value={value.projectId}
            searchable={projects.length > 8}
            onChange={(projectId) => onChange({ ...value, projectId })}
          />
        </FormField>
      ) : (
        <FormField label={t('sourceFilter')} htmlFor="widget-filter">
          <Combobox
            label={t('pickFilter')}
            placeholder={t('pickFilter')}
            emptyText={t('noFilters')}
            loading={loadingFilters}
            options={filterOptions}
            value={value.savedFilterId}
            searchable
            onChange={(savedFilterId) => onChange({ ...value, savedFilterId })}
          />
        </FormField>
      )}
    </div>
  );
}
