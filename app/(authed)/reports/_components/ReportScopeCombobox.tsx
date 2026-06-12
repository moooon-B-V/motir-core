'use client';

import { useMemo } from 'react';
import { Folder, ListFilter } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';

// The report-page SCOPE control (Story 6.3 · Subtask 6.3.6) — the data-source
// picker shared by both report pages, per design/reports/dashboard.mock.html
// panel 7 ("Project · Motir" + the saved-filter list). The default scope is the
// active project; a saved filter narrows within it (filters are project-
// contained — the 6.2 deviation). It is the page-level reuse of the 6.3.5 widget
// data-source editor (one control vocabulary, two hosts). Pure presentational:
// it reports the picked saved-filter id (or null = project) and the host
// navigates — the config round-trips through the URL.

const PROJECT_VALUE = 'project';
const FILTER_PREFIX = 'f:';

export interface ReportScopeOption {
  id: string;
  name: string;
}

export function ReportScopeCombobox({
  projectName,
  savedFilters,
  savedFilterId,
  onChange,
  disabled,
}: {
  projectName: string;
  savedFilters: ReportScopeOption[];
  /** The current saved-filter scope, or null for the default project scope. */
  savedFilterId: string | null;
  /** Fired with the picked saved-filter id, or null for the project scope. */
  onChange: (savedFilterId: string | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('reports');

  const options = useMemo<ComboboxOption<string>[]>(() => {
    const opts: ComboboxOption<string>[] = [
      {
        value: PROJECT_VALUE,
        label: t('scope.project', { name: projectName }),
        icon: <Folder className="h-4 w-4" aria-hidden />,
        group: t('scope.groupProject'),
      },
    ];
    for (const f of savedFilters) {
      opts.push({
        value: `${FILTER_PREFIX}${f.id}`,
        label: f.name,
        icon: <ListFilter className="h-4 w-4" aria-hidden />,
        group: t('scope.groupFilters'),
      });
    }
    return opts;
  }, [projectName, savedFilters, t]);

  return (
    <Combobox
      label={t('scope.label')}
      options={options}
      value={savedFilterId ? `${FILTER_PREFIX}${savedFilterId}` : PROJECT_VALUE}
      onChange={(v) => onChange(v === PROJECT_VALUE ? null : v.slice(FILTER_PREFIX.length))}
      searchable={savedFilters.length > 6}
      searchPlaceholder={t('scope.searchPlaceholder')}
      disabled={disabled}
    />
  );
}
