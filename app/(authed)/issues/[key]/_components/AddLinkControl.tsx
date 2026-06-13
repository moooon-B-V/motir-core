'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import type { ComboboxOption } from '@/components/ui/Combobox';
import { LinkAddForm } from '@/components/issues/LinkAddForm';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { useLinkCandidateSearch } from '@/hooks/useLinkCandidateSearch';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import type { IssueType } from '@/lib/issues/parentRules';
import { createLinkAction, listLinkCandidatesAction } from '../actions';

// The add-link control on the relationships panel (Subtask 2.4.9), per
// `design/work-items/links.mock.html`. A quiet "+ Link issue" entry point that
// expands the inline LinkAddForm (the SHARED control — kind selector + 2.3.4
// issue-search Combobox + Add/Cancel; reused by the create modal in 2.4.10).
// This wrapper owns the IMMEDIATE-WRITE semantics. The candidate read is the
// 6.9.1 server quick-search (Subtask 6.9.2 — closes finding #98): the Combobox
// is query-driven, fetching per debounced keystroke through
// `useLinkCandidateSearch` instead of loading a newest-50 window once;
// candidates also refetch when the relationship changes (the already-linked
// exclusion is direction-aware), Add calls `createLinkAction` and
// `router.refresh()` re-renders the panel + banner, and the typed trigger errors
// surface inline (LinkAddForm's AA-safe banner).

export function AddLinkControl({
  currentItemId,
  identifier,
}: {
  currentItemId: string;
  identifier: string;
}) {
  const router = useRouter();
  const t = useTranslations('issueViews');
  const tForm = useTranslations('ui');
  const [open, setOpen] = useState(false);
  const [relationship, setRelationship] = useState<RelationshipKind>('blocked_by');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Server-search: per-keystroke debounced fetch, refetched per relationship
  // (the exclusion set is direction-aware). The empty/short query returns nothing
  // (the picker prompts "type to search").
  const search = useLinkCandidateSearch({
    fetcher: (query) => listLinkCandidatesAction(currentItemId, relationship, query),
    refetchKey: relationship,
  });

  const options: ComboboxOption<string>[] = search.candidates.map((c) => ({
    value: c.id,
    label: c.title,
    secondary: c.identifier,
    icon: <IssueTypeIcon type={c.kind as IssueType} className="h-4 w-4" />,
  }));

  // A new search invalidates a prior pick — typing clears the stale selection.
  function changeQuery(query: string) {
    setTargetId(null);
    search.setQuery(query);
  }

  function openForm() {
    setOpen(true);
    setError(null);
  }

  function changeRelationship(rel: RelationshipKind) {
    setRelationship(rel);
    setTargetId(null); // the exclusion set changes — drop the stale selection
  }

  function reset() {
    setOpen(false);
    setError(null);
    setTargetId(null);
    setRelationship('blocked_by');
    search.reset();
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
      query={search.query}
      onQueryChange={changeQuery}
      emptyText={
        search.tooShort ? tForm('linkAddForm.typeToSearch') : tForm('linkAddForm.noMatchingIssues')
      }
      loading={search.loading}
      error={error ?? search.error}
      onSubmit={submit}
      pending={isPending}
      onCancel={reset}
    />
  );
}
