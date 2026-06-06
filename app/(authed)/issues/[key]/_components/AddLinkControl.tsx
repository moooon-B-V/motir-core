'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import type { ComboboxOption } from '@/components/ui/Combobox';
import { LinkAddForm } from '@/components/issues/LinkAddForm';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import type { IssueType } from '@/lib/issues/parentRules';
import { createLinkAction, listLinkCandidatesAction } from '../actions';

// The add-link control on the relationships panel (Subtask 2.4.9), per
// `design/work-items/links.mock.html`. A quiet "+ Link issue" entry point that
// expands the inline LinkAddForm (the SHARED control — kind selector + 2.3.4
// issue-search Combobox + Add/Cancel; reused by the create modal in 2.4.10).
// This wrapper owns the IMMEDIATE-WRITE semantics: candidates refetch when the
// relationship changes (the already-linked exclusion is direction-aware), Add
// calls `createLinkAction` and `router.refresh()` re-renders the panel + banner,
// and the typed trigger errors surface inline (LinkAddForm's AA-safe banner).

export function AddLinkControl({
  currentItemId,
  identifier,
}: {
  currentItemId: string;
  identifier: string;
}) {
  const router = useRouter();
  const t = useTranslations('issueViews');
  const [open, setOpen] = useState(false);
  const [relationship, setRelationship] = useState<RelationshipKind>('blocked_by');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [options, setOptions] = useState<ComboboxOption<string>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Fetch candidates for a relationship — called from the event handlers (the
  // open trigger + the relationship change), not a sync-setState effect. A new
  // relationship invalidates the current selection (different exclusion set).
  function fetchCandidates(rel: RelationshipKind) {
    setLoading(true);
    setTargetId(null);
    listLinkCandidatesAction(currentItemId, rel).then((res) => {
      setLoading(false);
      if (res.ok) {
        setOptions(
          res.candidates.map((c) => ({
            value: c.id,
            label: c.title,
            secondary: c.identifier,
            keywords: c.identifier,
            icon: <IssueTypeIcon type={c.kind as IssueType} className="h-4 w-4" />,
          })),
        );
      } else {
        setError(res.error);
      }
    });
  }

  function openForm() {
    setOpen(true);
    setError(null);
    fetchCandidates(relationship);
  }

  function changeRelationship(rel: RelationshipKind) {
    setRelationship(rel);
    fetchCandidates(rel);
  }

  function reset() {
    setOpen(false);
    setError(null);
    setTargetId(null);
    setOptions([]);
    setRelationship('blocked_by');
  }

  function submit() {
    if (!targetId) return;
    setError(null);
    startTransition(async () => {
      const res = await createLinkAction({ currentItemId, identifier, targetId, relationship });
      if (res.ok) {
        reset();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={openForm}
          className="text-(--el-link) inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 font-sans text-sm font-semibold hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t('linkIssue')}
        </button>
      </div>
    );
  }

  return (
    <LinkAddForm
      relationship={relationship}
      onRelationshipChange={changeRelationship}
      options={options}
      targetId={targetId}
      onTargetChange={setTargetId}
      loading={loading}
      error={error}
      onSubmit={submit}
      pending={isPending}
      onCancel={reset}
    />
  );
}
