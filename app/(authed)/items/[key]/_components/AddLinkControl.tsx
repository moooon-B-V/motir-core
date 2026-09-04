'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import type { ComboboxOption } from '@/components/ui/Combobox';
import { LinkAddForm } from '@/components/issues/LinkAddForm';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { useLinkCandidateSearch } from '@/hooks/useLinkCandidateSearch';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { IssueType } from '@/lib/issues/parentRules';
import { listLinkCandidatesAction, type CreateLinkActionResult } from '../actions';

// The add-link control on the relationships panel (Subtask 2.4.9), per
// `design/work-items/links.mock.html`. A quiet "+ Link issue" entry point that
// expands the inline LinkAddForm (the SHARED control — kind selector + 2.3.4
// issue-search Combobox + Add/Cancel; reused by the create modal in 2.4.10).
// This wrapper owns the IMMEDIATE-WRITE semantics. The candidate read is the
// 6.9.1 server quick-search (Subtask 6.9.2 — closes finding #98): the Combobox
// is query-driven, fetching per debounced keystroke through
// `useLinkCandidateSearch` instead of loading a newest-50 window once;
// candidates also refetch when the relationship changes (the already-linked
// exclusion is direction-aware), and the typed trigger errors surface inline
// (LinkAddForm's AA-safe banner).
//
// MOTIR-4496: Add no longer performs the write. It hands the picked CANDIDATE
// to the panel's `onAdd`, which inserts the row OPTIMISTICALLY from that
// candidate before the request leaves — the candidate is a full
// `WorkItemSummaryDto`, so the optimistic row is the real row minus its
// server-assigned `linkId`, which the response supplies. The panel owns the
// refresh; this control owns the form and its inline error.

export function AddLinkControl({
  currentItemId,
  onAdd,
}: {
  currentItemId: string;
  /** The panel's optimistic add — inserts the row from `target`, awaits the
   *  Server Action, and rolls back on a non-2xx (whose message lands here). */
  onAdd: (
    relationship: RelationshipKind,
    target: WorkItemSummaryDto,
  ) => Promise<CreateLinkActionResult>;
}) {
  const t = useTranslations('issueViews');
  const tForm = useTranslations('ui');
  const [open, setOpen] = useState(false);
  const [relationship, setRelationship] = useState<RelationshipKind>('blocked_by');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setPending] = useState(false);

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
    // The picked candidate IS the row's content — `listLinkCandidatesAction`
    // returns full summaries, so the panel needs no round trip to draw it.
    const target = search.candidates.find((c) => c.id === targetId);
    if (!target) return;
    setError(null);
    setPending(true);
    // ⚠️ NOT a `useTransition` (MOTIR-4496) — see RemoveLinkButton: `onAdd`'s
    // optimistic insert must be an URGENT update, and a transition makes every
    // update inside it non-urgent.
    void (async () => {
      try {
        const res = await onAdd(relationship, target);
        if (res.ok) reset();
        else setError(res.error);
      } finally {
        setPending(false);
      }
    })();
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={openForm}
          className="text-(--el-link) inline-flex items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 font-sans text-sm font-semibold hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
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
