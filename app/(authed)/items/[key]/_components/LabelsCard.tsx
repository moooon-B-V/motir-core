'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { LabelDto } from '@/lib/dto/labels';
import {
  MultiSelectPicker,
  ValueChip,
  type MultiSelectOption,
} from '@/components/ui/MultiSelectPicker';
import { labelTint } from '@/lib/labels/labelTint';
import { LABELS_PER_ISSUE_LIMIT } from '@/lib/labels/constants';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { FieldCard } from './FieldCard';
import { addLabelAction, removeLabelAction } from '../labelComponentActions';

// The Labels rail card (Story 5.4 · Subtask 5.4.8), per
// design/work-items/labels-components-watch.mock.html panel 2: the
// MultiSelectPicker with `onCreate` wired to the 5.4.2 folksonomy — options
// from the bounded `searchLabels` autocomplete (debounced), the create-row
// when the typed text matches nothing, coloured chips (the name-hash tint —
// the recorded less-enterprise deviation), the inline no-spaces 422 (the
// rejected text stays for correction), the cap hint at 20, and the read-only
// (viewer) chips-only rendering. Success confirms from the action response —
// no router.refresh (the inline-edit rule).

const SEARCH_DEBOUNCE_MS = 200;

function toOption(label: LabelDto): MultiSelectOption {
  return { id: label.id, label: label.name, tint: labelTint(label.name) };
}

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
  const { canEdit } = useProjectAccess();
  const [isPending, startTransition] = useTransition();
  const [labels, setLabels] = useState<LabelDto[]>(initialLabels);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<LabelDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Drops a stale autocomplete response that resolves after a newer one (the
  // debounced fetches are not guaranteed to return in order).
  const fetchSeq = useRef(0);

  // The bounded autocomplete (finding #57): a debounced, case-insensitive
  // prefix read over the project's labels; an empty query lists the first
  // window (opening the picker before typing — the Jira field's behaviour).
  useEffect(() => {
    if (!editing) return;
    const seq = ++fetchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectKey)}/labels?q=${encodeURIComponent(query.trim())}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as { labels: LabelDto[] };
        if (seq === fetchSeq.current) setOptions(body.labels);
      } catch {
        // A failed autocomplete read just leaves the previous window — the
        // create-row still works and the next keystroke retries.
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [editing, query, projectKey]);

  function applyResult(res: Awaited<ReturnType<typeof addLabelAction>>, clearQueryOnOk: boolean) {
    if (res.ok) {
      setLabels(res.labels);
      setError(null);
      if (clearQueryOnOk) setQuery('');
    } else {
      setError(res.error);
    }
  }

  function add(name: string, clearQueryOnOk: boolean) {
    setError(null);
    startTransition(async () => {
      applyResult(await addLabelAction({ workItemId, name }), clearQueryOnOk);
    });
  }

  function remove(value: MultiSelectOption) {
    setError(null);
    startTransition(async () => {
      applyResult(await removeLabelAction({ workItemId, labelId: value.id }), false);
    });
  }

  function toggle(option: MultiSelectOption) {
    if (labels.some((l) => l.id === option.id)) remove(option);
    else add(option.label, false);
  }

  const atCap = labels.length >= LABELS_PER_ISSUE_LIMIT;
  const chips = labels.map(toOption);

  return (
    <FieldCard
      label={t('labelsField')}
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
          options={options.map(toOption)}
          onToggle={toggle}
          onRemove={remove}
          onCreate={(name) => add(name, true)}
          query={query}
          onQueryChange={(q) => {
            setQuery(q);
            setError(null);
          }}
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
