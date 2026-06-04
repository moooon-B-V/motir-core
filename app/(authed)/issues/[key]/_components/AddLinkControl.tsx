'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, Plus } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { RELATIONSHIP_KINDS } from '@/lib/workItems/linkRelationships';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import type { IssueType } from '@/lib/issues/parentRules';
import { createLinkAction, listLinkCandidatesAction } from '../actions';

// The add-link control on the relationships panel (Subtask 2.4.9), per
// `design/work-items/links.mock.html`. A quiet "+ Link issue" entry point that
// expands an inline form: a KIND selector (the 5 relationships) + an
// issue-search Combobox (2.3.4) over the workspace candidate set + Add / Cancel.
// Candidates refetch when the relationship changes (the already-linked exclusion
// is direction-aware). The typed trigger errors surface as an inline AA-safe
// rose banner (strong text on tint — finding #35). On success the action
// revalidates the detail path; `router.refresh()` re-renders the panel + banner.

const KIND_OPTIONS: ComboboxOption<RelationshipKind>[] = RELATIONSHIP_KINDS.map((r) => ({
  value: r.kind,
  label: r.label,
}));

export function AddLinkControl({
  currentItemId,
  identifier,
}: {
  currentItemId: string;
  identifier: string;
}) {
  const router = useRouter();
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
          Link issue
        </button>
      </div>
    );
  }

  return (
    <div className="bg-(--el-surface-soft) border-(--el-border) flex flex-col gap-2.5 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[140px] shrink-0">
          <Combobox
            label="Relationship"
            options={KIND_OPTIONS}
            value={relationship}
            onChange={changeRelationship}
          />
        </div>
        <div className="min-w-[180px] flex-1">
          <Combobox
            label="Issue to link"
            options={options}
            value={targetId}
            onChange={(v) => setTargetId(v)}
            searchable
            placeholder="Search an issue…"
            searchPlaceholder="Search by identifier or title…"
            loading={loading}
            emptyText="No matching issues."
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={submit} disabled={!targetId || isPending} loading={isPending}>
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={reset} disabled={isPending}>
            Cancel
          </Button>
        </div>
      </div>
      {error ? (
        <div className="bg-(--el-tint-rose) flex items-start gap-2 rounded-md px-3 py-2">
          <CircleAlert className="text-(--el-danger) mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="text-(--el-text-strong) font-sans text-[13px]">{error}</span>
        </div>
      ) : null}
    </div>
  );
}
