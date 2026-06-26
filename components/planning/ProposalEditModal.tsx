'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { TypePicker } from '@/components/issues/TypePicker';
import { WorkItemTypePicker } from '@/components/issues/WorkItemTypePicker';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import type { WorkItemPriorityDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { UpdateProposalInput } from '@/lib/dto/plans';

// The inline-edit affordance for a proposed `add` (Subtask 7.21.6 / MOTIR-1370),
// opened from the edit trigger on an `add` node in the plan-detail canvas. A small
// Modal form over the add's editable proposed fields (title / kind / work-type /
// priority / description) — the canvas node itself stays a compact fixed card, so
// editing happens here, NOT inside the node. Composes the SHIPPED design-system
// pickers (TypePicker / WorkItemTypePicker / PriorityPicker) + Input/Textarea, so
// the field controls match the create-issue modal exactly. On save the parent
// PATCHes the proposal and refetches the review model (no WorkItem is created —
// the add stays a proposal until approve). Only an `add` is editable.

const DEFAULT_PRIORITY: WorkItemPriorityDto = 'medium';

function toKind(raw: string): IssueType {
  return (ISSUE_TYPES as readonly string[]).includes(raw) ? (raw as IssueType) : 'task';
}
function toWorkType(raw: string | null): WorkItemTypeDto | null {
  return raw && (WORK_ITEM_TYPES as readonly string[]).includes(raw)
    ? (raw as WorkItemTypeDto)
    : null;
}
function toPriority(raw: string | null): WorkItemPriorityDto {
  return raw && PRIORITY_OPTIONS.some((o) => o.value === raw)
    ? (raw as WorkItemPriorityDto)
    : DEFAULT_PRIORITY;
}

export interface ProposalEditModalProps {
  /** The `add` item being edited, or `null` when the modal is closed. */
  item: PlanReviewItemDto | null;
  onOpenChange: (open: boolean) => void;
  /** Persist the edit (the parent PATCHes the proposal, then refetches). */
  onSubmit: (planItemId: string, input: UpdateProposalInput) => void | Promise<void>;
  busy: boolean;
  /** A failed save's error code (e.g. `PLAN_NOT_IN_EXPECTED_STATUS`), or null. */
  errorCode: string | null;
}

export function ProposalEditModal({
  item,
  onOpenChange,
  onSubmit,
  busy,
  errorCode,
}: ProposalEditModalProps) {
  const t = useTranslations('planReview');
  return (
    <Modal open={item !== null} onOpenChange={onOpenChange} title={t('editModalTitle')} size="md">
      {item ? (
        // Keyed by the item id so reopening on a DIFFERENT node reseeds the form
        // from that node's values (the inner form seeds via useState initializers).
        <EditForm
          key={item.planItemId}
          item={item}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
          busy={busy}
          errorCode={errorCode}
          t={t}
        />
      ) : null}
    </Modal>
  );
}

function EditForm({
  item,
  onSubmit,
  onCancel,
  busy,
  errorCode,
  t,
}: {
  item: PlanReviewItemDto;
  onSubmit: (planItemId: string, input: UpdateProposalInput) => void | Promise<void>;
  onCancel: () => void;
  busy: boolean;
  errorCode: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const [title, setTitle] = useState(item.title);
  const [kind, setKind] = useState<IssueType>(toKind(item.kind));
  const [workType, setWorkType] = useState<WorkItemTypeDto | null>(toWorkType(item.type));
  const [priority, setPriority] = useState<WorkItemPriorityDto>(toPriority(item.priority));
  const [description, setDescription] = useState(item.descriptionMd ?? '');
  const [showTitleError, setShowTitleError] = useState(false);

  const titleEmpty = title.trim() === '';

  const submit = () => {
    if (titleEmpty) {
      setShowTitleError(true);
      return;
    }
    const input: UpdateProposalInput = {
      title: title.trim(),
      kind,
      type: workType,
      priority,
      descriptionMd: description.trim() === '' ? null : description,
    };
    void onSubmit(item.planItemId, input);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Modal.Body className="gap-4">
        <Input
          label={t('editLabelTitle')}
          value={title}
          autoFocus
          onChange={(e) => {
            setTitle(e.target.value);
            if (showTitleError) setShowTitleError(false);
          }}
          error={showTitleError ? t('editTitleRequired') : undefined}
        />

        <Field label={t('editLabelKind')} htmlFor="proposal-edit-kind">
          <TypePicker id="proposal-edit-kind" value={kind} onChange={setKind} disabled={busy} />
        </Field>

        <Field label={t('editLabelType')} htmlFor="proposal-edit-type">
          <WorkItemTypePicker
            id="proposal-edit-type"
            value={workType}
            onChange={setWorkType}
            disabled={busy}
          />
        </Field>

        <Field label={t('editLabelPriority')} htmlFor="proposal-edit-priority">
          <PriorityPicker
            id="proposal-edit-priority"
            value={priority}
            onChange={setPriority}
            disabled={busy}
          />
        </Field>

        <Textarea
          label={t('editLabelDescription')}
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
        />

        {errorCode ? (
          <p role="alert" className="text-sm text-(--el-danger)">
            {t('actionError')}
          </p>
        ) : null}
      </Modal.Body>

      <Modal.Footer>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('editCancel')}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={busy || titleEmpty}>
          {t('editSave')}
        </Button>
      </Modal.Footer>
    </form>
  );
}

// A labelled wrapper for a picker (the pickers carry an aria-label but no visible
// label) — mirrors FormField's label styling so the picker rows align with the
// Input/Textarea labels above and below them.
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="font-sans text-sm font-medium text-(--el-text)">
        {label}
      </label>
      {children}
    </div>
  );
}
