'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleAlert, X } from 'lucide-react';
import { LinkAddForm } from '@/components/issues/LinkAddForm';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { useLinkCandidateSearch } from '@/hooks/useLinkCandidateSearch';
import type { ComboboxOption } from '@/components/ui/Combobox';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import { listCreateLinkCandidatesAction } from '../items/actions';

// The create-modal "Linked issues" section (Subtask 2.4.10), per
// `design/work-items/links.mock.html` panel 5. Reuses the SHARED LinkAddForm
// (kind selector + 2.3.4 issue-search Combobox) but in COLLECT mode: Add pushes
// a PENDING row (kind chip · type icon · id · title · remove) into form state
// rather than writing immediately — the new issue has no id yet, so the links
// are written WHEN the issue is created (atomically, in createWorkItem's
// transaction). The pending list is owned by the modal (it submits + resets it);
// this component owns only the in-progress selection + the candidate fetch. The
// candidate read is the 6.9.1 server quick-search (Subtask 6.9.2 — closes finding
// #98): the Combobox is query-driven (debounced per keystroke via
// `useLinkCandidateSearch`), not a newest-50 window loaded once on mount.

export interface PendingLink {
  targetId: string;
  relationship: RelationshipKind;
  /** The resolved target summary — kept so the pending row renders without a refetch. */
  item: WorkItemSummaryDto;
}

export interface CreateIssueLinksFieldProps {
  links: PendingLink[];
  onChange: (links: PendingLink[]) => void;
  /** The create submit is in flight — freeze the remove buttons. */
  disabled?: boolean;
  /** Server-side link rejection (cycle / cross-workspace), surfaced inline. */
  error?: string | null;
}

export function CreateIssueLinksField({
  links,
  onChange,
  disabled,
  error,
}: CreateIssueLinksFieldProps) {
  const t = useTranslations('shell');
  const tl = useTranslations('labels');
  const tUi = useTranslations('ui');
  const [relationship, setRelationship] = useState<RelationshipKind>('blocked_by');
  const [targetId, setTargetId] = useState<string | null>(null);

  // Server-search: per-keystroke debounced fetch. The current item doesn't exist
  // yet, so there's nothing to exclude server-side; the per-relationship pending
  // exclusion stays client-side (below).
  const search = useLinkCandidateSearch({ fetcher: listCreateLinkCandidatesAction });

  // Candidates minus those already pending FOR THIS relationship — the same
  // (target, relationship) pair can't be added twice (the unique constraint
  // backstops a forged dup), but the same target under a different relationship
  // is allowed.
  const options: ComboboxOption<string>[] = search.candidates
    .filter((c) => !links.some((l) => l.targetId === c.id && l.relationship === relationship))
    .map((c) => ({
      value: c.id,
      label: c.title,
      secondary: c.identifier,
      icon: <IssueTypeIcon type={c.kind as IssueType} className="h-4 w-4" />,
    }));

  function add() {
    if (!targetId) return;
    const item = search.candidates.find((c) => c.id === targetId);
    if (!item) return;
    onChange([...links, { targetId, relationship, item }]);
    setTargetId(null);
  }

  // A new search invalidates a prior pick — typing clears the stale selection.
  function changeQuery(query: string) {
    setTargetId(null);
    search.setQuery(query);
  }

  function changeRelationship(rel: RelationshipKind) {
    setRelationship(rel);
    setTargetId(null); // the exclusion set changes — drop the stale selection
  }

  function remove(index: number) {
    onChange(links.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-2 font-sans text-sm">
      <SectionLabel label={t('links.section')} />

      {error ? (
        <div className="bg-(--el-tint-rose) flex items-start gap-2 rounded-md px-3 py-2">
          <CircleAlert className="text-(--el-danger) mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="text-(--el-text-strong) text-[13px]">{error}</span>
        </div>
      ) : null}

      {links.length ? (
        <ul className="flex flex-col">
          {links.map((l, i) => (
            <li
              key={`${l.relationship}:${l.targetId}`}
              className="hover:bg-(--el-surface) flex items-center gap-2 rounded-md px-2 py-1.5"
            >
              <Pill tone="neutral" className="shrink-0">
                {tl(`relationship.${l.relationship}`)}
              </Pill>
              <IssueTypeIcon type={l.item.kind as IssueType} className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                <span className="text-(--el-text-muted) font-mono text-xs">
                  {l.item.identifier}
                </span>
                <span className="text-(--el-text) ml-2 text-sm">{l.item.title}</span>
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                disabled={disabled}
                aria-label={t('links.removeAria', {
                  relationship: tl(`relationship.${l.relationship}`).toLowerCase(),
                  identifier: l.item.identifier,
                })}
                className="text-(--el-text-muted) hover:bg-(--el-tint-rose) hover:text-(--el-danger) shrink-0 rounded-md p-1 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <LinkAddForm
        relationship={relationship}
        onRelationshipChange={changeRelationship}
        options={options}
        targetId={targetId}
        onTargetChange={setTargetId}
        query={search.query}
        onQueryChange={changeQuery}
        emptyText={
          search.tooShort ? tUi('linkAddForm.typeToSearch') : tUi('linkAddForm.noMatchingIssues')
        }
        loading={search.loading}
        error={search.error}
        onSubmit={add}
      />

      <span className="text-(--el-text-secondary) text-xs">{t('links.helper')}</span>
    </div>
  );
}
