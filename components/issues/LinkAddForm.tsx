'use client';

import { CircleAlert } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import { RELATIONSHIP_KINDS } from '@/lib/workItems/linkRelationships';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';

// The inline "add a link" form, per `design/work-items/links.mock.html` — a
// KIND selector (the 5 relationships) + an issue-search Combobox (2.3.4) + an
// Add (and optional Cancel) button, with the typed-error rose banner below
// (strong text on tint — finding #35). PURELY presentational: it owns no
// fetching, no server calls, no pending/selection state — the parent feeds
// `options` and the current selection in and reacts to `onSubmit`. This is the
// ONE shared control behind BOTH link surfaces (no parallel control):
//   - the detail-page `AddLinkControl` (2.4.9) wraps it with immediate-write
//     semantics (Add → createLinkAction → refresh) + a Cancel that collapses;
//   - the create-modal `CreateIssueLinksField` (2.4.10) wraps it with
//     collect-on-create semantics (Add → push a pending row, written when the
//     issue is created) and no Cancel (the form stays open inline).

const KIND_OPTIONS: ComboboxOption<RelationshipKind>[] = RELATIONSHIP_KINDS.map((r) => ({
  value: r.kind,
  label: r.label,
}));

export interface LinkAddFormProps {
  /** The chosen relationship + its setter (the kind selector). */
  relationship: RelationshipKind;
  onRelationshipChange: (relationship: RelationshipKind) => void;
  /** The candidate target issues for the search Combobox. */
  options: ComboboxOption<string>[];
  /** The selected target id (null until one is picked) + its setter. */
  targetId: string | null;
  onTargetChange: (targetId: string | null) => void;
  /** Candidate fetch in flight (drives the Combobox spinner). */
  loading?: boolean;
  /** Inline error (typed-link rejection or a candidate-load failure). */
  error?: string | null;
  /** Commit the current (relationship, target) selection. */
  onSubmit: () => void;
  /** Add disabled / in-flight (the immediate-write path uses this). */
  pending?: boolean;
  /** Label on the commit button — "Add" on both surfaces by default. */
  submitLabel?: string;
  /** When provided, render a Cancel button (the detail-page collapse). */
  onCancel?: () => void;
}

export function LinkAddForm({
  relationship,
  onRelationshipChange,
  options,
  targetId,
  onTargetChange,
  loading,
  error,
  onSubmit,
  pending,
  submitLabel = 'Add',
  onCancel,
}: LinkAddFormProps) {
  return (
    <div className="bg-(--el-surface-soft) border-(--el-border) flex flex-col gap-2.5 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[140px] shrink-0">
          <Combobox
            label="Relationship"
            options={KIND_OPTIONS}
            value={relationship}
            onChange={onRelationshipChange}
          />
        </div>
        <div className="min-w-[180px] flex-1">
          <Combobox
            label="Issue to link"
            options={options}
            value={targetId}
            onChange={(v) => onTargetChange(v)}
            searchable
            placeholder="Search an issue…"
            searchPlaceholder="Search by identifier or title…"
            loading={loading}
            emptyText="No matching issues."
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={onSubmit} disabled={!targetId || pending} loading={pending}>
            {submitLabel}
          </Button>
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          ) : null}
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
