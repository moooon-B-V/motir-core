'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GitMerge } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { listCreateLinkCandidatesAction } from '@/app/(authed)/issues/actions';

// The Mark-duplicate / Merge picker (Subtask 6.11.6, design panel 1c) — a
// query-driven Combobox over the project's work items (the 6.9.1 quick-search
// the link picker reuses). Each option row is `IssueTypeIcon` + mono PROD-{n}
// key + title (the "option name = label + secondary" convention — the E2E
// selector matches the key substring). On select a confirm note states the
// destructive-but-recoverable fold, then `POST .../duplicate` with the chosen
// canonical id. `excludeId` drops the submission itself from candidates.

export interface MergePickerProps {
  excludeId: string;
  busy: boolean;
  onMerge: (canonicalId: string, canonicalKey: string) => void;
}

export function MergePicker({ excludeId, busy, onMerge }: MergePickerProps) {
  const t = useTranslations('triage');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ComboboxOption<string>[]>([]);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState<string | null>(null);

  // Re-fetch per query keystroke; an empty / short query returns []. The action
  // already 6.4-scopes + bounds the result. Await the response before updating
  // (no race) — the data-fetching effect legitimately resets loading/options.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listCreateLinkCandidatesAction(query).then((res) => {
      if (cancelled) return;
      setLoading(false);
      const candidates = res.ok ? res.candidates : [];
      setOptions(
        candidates
          .filter((c) => c.id !== excludeId)
          .map((c) => ({
            value: c.id,
            label: c.title,
            secondary: c.identifier,
            keywords: c.identifier,
            icon: <IssueTypeIcon type={c.kind} className="h-4 w-4" />,
          })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [open, query, excludeId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selected = options.find((o) => o.value === value);
  const canonicalKey = selected?.secondary ?? '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="secondary" size="sm" leftIcon={<GitMerge className="h-4 w-4" />}>
          {t('actions.markDuplicate')}
        </Button>
      </Popover.Trigger>
      <Popover.Content align="start" width={360} className="flex flex-col gap-2 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-(--el-text-faint)">
          {t('merge.heading')}
        </p>
        <Combobox
          options={options}
          value={value}
          onChange={(v) => setValue(v)}
          label={t('merge.searchLabel')}
          searchable
          searchPlaceholder={t('merge.searchPlaceholder')}
          emptyText={t('merge.empty')}
          loading={loading}
          query={query}
          onQueryChange={setQuery}
        />
        {value ? (
          <p className="text-xs text-(--el-text-muted)">{t('merge.note', { key: canonicalKey })}</p>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          disabled={!value}
          loading={busy}
          onClick={() => value && onMerge(value, canonicalKey)}
        >
          {t('merge.confirm')}
        </Button>
      </Popover.Content>
    </Popover>
  );
}
