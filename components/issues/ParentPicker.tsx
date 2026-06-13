'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { allowedParentKinds, type IssueType } from '@/lib/issues/parentRules';
import { listCandidateParentsAction } from '@/app/(authed)/issues/actions';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';

// The parent picker (Subtask 2.3.4): an async Combobox that surfaces 2.1.2's
// kind-parent rule AS CONSTRUCTIBILITY — only legal parents for the current
// `childType` are in the list, so an illegal pair can't be picked. Re-fetches
// whenever `childType` changes; if that change invalidates the current
// selection, the parent is cleared with a one-line notice. "No parent" is the
// first option. The service + DB trigger remain the backstops for a forged id.

const NONE = '__none__';

function kindIcon(kind: WorkItemKindDto) {
  return <IssueTypeIcon type={kind} className="h-4 w-4" />;
}

export interface ParentPickerProps {
  childType: IssueType;
  /** Selected parent work-item id, or null for "No parent". */
  value: string | null;
  onChange: (
    parentId: string | null,
    parent?: { identifier: string; title: string } | null,
  ) => void;
  /** Inline error from the server (defense-in-depth path), rendered below. */
  error?: string | null;
  id?: string;
  disabled?: boolean;
}

export function ParentPicker({
  childType,
  value,
  onChange,
  error,
  id,
  disabled,
}: ParentPickerProps) {
  const t = useTranslations('ui');
  const tl = useTranslations('labels');
  const [options, setOptions] = useState<ComboboxOption<string>[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The label of the current selection, for the cleared-parent notice. Written
  // only from the change handler (never during render).
  const selectedLabelRef = useRef<string | null>(null);

  // Fetch candidates whenever childType changes; clear an invalidated selection.
  // This is a data-fetching effect, so it legitimately resets loading/notice/
  // options around the async call. `value` is read from the effect's closure —
  // it can't change between a childType switch and the fetch resolving (the
  // list is loading, so no new selection is possible), so it isn't a dep.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let cancelled = false;
    setNotice(null);
    const typeLabel = tl(`issueType.${childType}`);

    // A childType with no legal parent (epic) is top-level by definition.
    if (allowedParentKinds(childType).length === 0) {
      setOptions([]);
      setLoading(false);
      if (value !== null) {
        onChange(null);
        setNotice(t('parentPicker.topLevelNotice', { type: typeLabel }));
        selectedLabelRef.current = null;
      }
      return;
    }

    setLoading(true);
    listCandidateParentsAction(childType).then((res) => {
      if (cancelled) return;
      setLoading(false);
      const candidates = res.ok ? res.candidates : [];
      setOptions(
        candidates.map((c) => ({
          value: c.id,
          label: c.title,
          secondary: c.identifier,
          keywords: c.identifier,
          icon: kindIcon(c.kind),
        })),
      );
      // Clear a selection the new childType no longer permits.
      if (value !== null && !candidates.some((c) => c.id === value)) {
        onChange(null);
        const who = selectedLabelRef.current ?? t('parentPicker.previousParent');
        setNotice(t('parentPicker.clearedNotice', { who, type: typeLabel }));
        selectedLabelRef.current = null;
      }
    });

    return () => {
      cancelled = true;
    };
    // Only re-run on childType — see note above on why value/onChange aren't deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childType]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleChange(v: string) {
    setNotice(null);
    if (v === NONE) {
      onChange(null, null);
      selectedLabelRef.current = null;
      return;
    }
    const picked = options.find((o) => o.value === v);
    // Hand the chosen parent's label up too (secondary = identifier, label =
    // title), so an inline editor can show it optimistically without a re-read.
    onChange(
      v,
      picked ? { identifier: picked.secondary ?? '', title: String(picked.label) } : null,
    );
    selectedLabelRef.current = picked ? `${picked.secondary ?? ''} ${picked.label}`.trim() : null;
  }

  const comboOptions: ComboboxOption<string>[] = [
    { value: NONE, label: t('parentPicker.noParent') },
    ...options,
  ];

  return (
    <div className="flex flex-col gap-1">
      <Combobox
        options={comboOptions}
        value={value ?? NONE}
        onChange={handleChange}
        label={t('parentPicker.label')}
        placeholder={t('parentPicker.noParent')}
        searchable
        searchPlaceholder={t('parentPicker.searchPlaceholder')}
        emptyText={t('parentPicker.emptyText')}
        loading={loading}
        loadingText={t('parentPicker.loadingText')}
        id={id}
        disabled={disabled}
      />
      {error ? (
        <p className="text-(--el-danger) text-xs" role="alert">
          {error}
        </p>
      ) : notice ? (
        <p className="text-(--el-text-muted) text-xs">{notice}</p>
      ) : null}
    </div>
  );
}
