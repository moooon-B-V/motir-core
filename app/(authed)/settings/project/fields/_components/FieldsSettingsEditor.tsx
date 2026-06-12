'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Info, Plus, SlidersHorizontal, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { keyBetween } from '@/lib/workItems/positioning';
import { MAX_FIELDS_PER_PROJECT, MAX_OPTIONS_PER_FIELD } from '@/lib/customFields/limits';
import { CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_META } from '@/lib/customFields/typeMeta';
import type { CustomFieldType } from '@prisma/client';
import type { CustomFieldDefinitionDTO, CustomFieldOptionDTO } from '@/lib/dto/customFields';

// FieldsSettingsEditor (Story 5.3 · Subtask 5.3.6) — the Fields admin UI at
// Project settings → Fields, built against design/projects/fields.mock.html
// (the 5.3.4 design asset; THE layout authority) and calling the 5.3.2 REST
// API. Structure mirrors the shipped settings editors:
//
//   • mutations go fetch → 5.3.2 route → customFieldsService with optimistic
//     local state + revert-and-toast on failure — the members-page /
//     board-config grammar (the shipped settings-mutation pattern, which the
//     Subtask card's "server actions" line yields to per the
//     decision-authority ladder rung 2);
//   • field reorder is dnd-kit sortable with the keyboard sensor (the 3.6
//     board-settings grip grammar — pointer drag is the ENHANCEMENT over the
//     keyboard-operable grip button);
//   • `canManage` (computed server-side, re-gated in the service on every
//     write) governs whether the mutation affordances render at all — the
//     read-only degradation HIDES them (Read-only pill + the quiet permission
//     line), per the 5.3.4 design notes: unlike the viewer's board, every
//     control here is a mutation, so hiding is the legible shape;
//   • the verified mirror rules render as drawn: the 50/55 cap states
//     (disabled Add + tooltip/info line), the archive-vs-delete-when-unused
//     option split (in-use delete disabled with the tooltip), the hard
//     delete-field confirm naming the value count (refetched when the
//     confirm opens, so the consequence statement is fresh).

interface FieldsResponse {
  fields: CustomFieldDefinitionDTO[];
}

/** Compute the reordered field list + the moved field's new fractional key
 *  (the board-settings computeColumnReorder, verbatim shape). */
export function computeFieldReorder(
  fields: CustomFieldDefinitionDTO[],
  activeId: string,
  overId: string,
): { fields: CustomFieldDefinitionDTO[]; position: string } | null {
  const oldIndex = fields.findIndex((f) => f.id === activeId);
  const overIndex = fields.findIndex((f) => f.id === overId);
  if (oldIndex < 0 || overIndex < 0 || oldIndex === overIndex) return null;
  const without = fields.filter((f) => f.id !== activeId);
  const insertAt = without.findIndex((f) => f.id === overId) + (oldIndex < overIndex ? 1 : 0);
  const prev = without[insertAt - 1]?.position ?? null;
  const next = without[insertAt]?.position ?? null;
  const position = keyBetween(prev, next);
  const moved = { ...fields[oldIndex]!, position };
  return {
    fields: [...without.slice(0, insertAt), moved, ...without.slice(insertAt)],
    position,
  };
}

/** As computeFieldReorder, for one field's option list. Archived options are
 *  pinned after the active ones (the 5.3.4 grammar: archived rows lose their
 *  grip and sit last), so reorder only ever moves within the active slice. */
export function computeOptionReorder(
  options: CustomFieldOptionDTO[],
  activeId: string,
  overId: string,
): { options: CustomFieldOptionDTO[]; position: string } | null {
  const oldIndex = options.findIndex((o) => o.id === activeId);
  const overIndex = options.findIndex((o) => o.id === overId);
  if (oldIndex < 0 || overIndex < 0 || oldIndex === overIndex) return null;
  if (options[oldIndex]!.archived || options[overIndex]!.archived) return null;
  const without = options.filter((o) => o.id !== activeId);
  const insertAt = without.findIndex((o) => o.id === overId) + (oldIndex < overIndex ? 1 : 0);
  const prev = without[insertAt - 1]?.position ?? null;
  const next = without[insertAt]?.position ?? null;
  const position = keyBetween(prev, next);
  const moved = { ...options[oldIndex]!, position };
  return {
    options: [...without.slice(0, insertAt), moved, ...without.slice(insertAt)],
    position,
  };
}

/** Active options first (position order), archived last — the 5.3.4 rule. */
function sortOptionsForDisplay(options: CustomFieldOptionDTO[]): CustomFieldOptionDTO[] {
  return [...options].sort((a, b) =>
    a.archived === b.archived ? (a.position < b.position ? -1 : 1) : a.archived ? 1 : -1,
  );
}

export interface FieldsSettingsEditorProps {
  projectKey: string;
  fields: CustomFieldDefinitionDTO[];
  canManage: boolean;
}

export function FieldsSettingsEditor({
  projectKey,
  fields: initialFields,
  canManage,
}: FieldsSettingsEditorProps) {
  const t = useTranslations('settings.customFields');
  const { toast } = useToast();

  const [fields, setFields] = useState<CustomFieldDefinitionDTO[]>(initialFields);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CustomFieldDefinitionDTO | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const atFieldCap = fields.length >= MAX_FIELDS_PER_PROJECT;
  const editingField = editingId ? (fields.find((f) => f.id === editingId) ?? null) : null;

  // Shared failure path for optimistic writes (the board-config revert).
  const revert = useCallback(
    (snapshot: CustomFieldDefinitionDTO[], description: string) => {
      setFields(snapshot);
      toast({ variant: 'error', title: t('errorGenericTitle'), description });
    },
    [t, toast],
  );

  /** Replace one field's DTO in place (from a mutation response). */
  const patchField = useCallback((next: CustomFieldDefinitionDTO) => {
    setFields((current) => current.map((f) => (f.id === next.id ? next : f)));
  }, []);

  async function readErrorCode(res: Response): Promise<string> {
    const data = (await res.json().catch(() => ({}))) as { code?: string };
    return data.code ?? 'UNKNOWN';
  }

  // ── Field reorder (dnd) ───────────────────────────────────────────────────
  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const snapshot = fields;
      const result = computeFieldReorder(snapshot, String(active.id), String(over.id));
      if (!result) return;
      setFields(result.fields);
      void fetch(`/api/fields/${encodeURIComponent(String(active.id))}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ position: result.position }),
      })
        .then((res) => {
          if (!res.ok) revert(snapshot, t('toastReorderError'));
        })
        .catch(() => revert(snapshot, t('toastReorderError')));
    },
    [fields, revert, t],
  );

  // ── Delete field (confirm names the FRESH value count) ───────────────────
  const openDeleteConfirm = useCallback(
    (field: CustomFieldDefinitionDTO) => {
      setDeleting(field);
      // The consequence statement is fetched fresh when the confirm opens
      // (the 5.3.4 legend) — refresh the list and the held count behind it.
      void fetch(`/api/projects/${encodeURIComponent(projectKey)}/fields`)
        .then(async (res) => {
          if (!res.ok) return;
          const data = (await res.json()) as FieldsResponse;
          setFields(data.fields);
          const fresh = data.fields.find((f) => f.id === field.id);
          if (fresh) setDeleting((cur) => (cur && cur.id === field.id ? fresh : cur));
        })
        .catch(() => undefined);
    },
    [projectKey],
  );

  async function confirmDeleteField(field: CustomFieldDefinitionDTO) {
    const snapshot = fields;
    setFields((current) => current.filter((f) => f.id !== field.id));
    setDeleting(null);
    try {
      const res = await fetch(`/api/fields/${encodeURIComponent(field.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await readErrorCode(res));
      toast({ variant: 'success', title: t('deletedToast', { label: field.label }) });
    } catch {
      revert(snapshot, t('toastDeleteError'));
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const showEmpty = fields.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {showEmpty ? (
        <EmptyState
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          icon={<SlidersHorizontal className="h-12 w-12" aria-hidden />}
          action={
            canManage ? (
              <Button
                leftIcon={<Plus className="size-4" aria-hidden />}
                onClick={() => setCreateOpen(true)}
              >
                {t('addField')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card
          header={
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <h2 className="font-sans text-base font-semibold text-(--el-text)">
                  {t('listHeading')}
                </h2>
                <Pill
                  tone="neutral"
                  aria-label={t('countPillLabel', {
                    count: fields.length,
                    max: MAX_FIELDS_PER_PROJECT,
                  })}
                >
                  {t('countPill', { count: fields.length, max: MAX_FIELDS_PER_PROJECT })}
                </Pill>
              </div>
              {canManage ? (
                atFieldCap ? (
                  <Tooltip content={t('fieldCapTooltip', { max: MAX_FIELDS_PER_PROJECT })}>
                    {/* Disabled buttons swallow pointer events; the focusable
                        wrapper keeps the cap tooltip reachable (5.3.4 notes). */}
                    <span
                      tabIndex={0}
                      className="focus-visible:ring-(--focus-ring-color) inline-flex rounded-(--radius-btn) focus-visible:outline-none focus-visible:ring-2"
                    >
                      <Button size="sm" disabled leftIcon={<Plus className="size-4" aria-hidden />}>
                        {t('addField')}
                      </Button>
                    </span>
                  </Tooltip>
                ) : (
                  <Button
                    size="sm"
                    leftIcon={<Plus className="size-4" aria-hidden />}
                    onClick={() => setCreateOpen(true)}
                  >
                    {t('addField')}
                  </Button>
                )
              ) : (
                <Pill tone="neutral">{t('readOnly')}</Pill>
              )}
            </div>
          }
        >
          {!canManage ? (
            <QuietNote>{t('readOnlyNote')}</QuietNote>
          ) : atFieldCap ? (
            <QuietNote>{t('fieldCapInfo', { max: MAX_FIELDS_PER_PROJECT })}</QuietNote>
          ) : null}

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
              <ul role="list" className="flex flex-col">
                {fields.map((field) => (
                  <SortableFieldRow
                    key={field.id}
                    field={field}
                    canManage={canManage}
                    onEdit={() => setEditingId(field.id)}
                    onDelete={() => openDeleteConfirm(field)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </Card>
      )}

      {canManage ? (
        <>
          <CreateFieldModal
            open={createOpen}
            onOpenChange={setCreateOpen}
            projectKey={projectKey}
            onCreated={(field) => setFields((current) => [...current, field])}
          />
          {editingField ? (
            <EditFieldModal
              field={editingField}
              onClose={() => setEditingId(null)}
              onFieldChange={patchField}
            />
          ) : null}
          <DeleteFieldModal
            field={deleting}
            onOpenChange={(open) => {
              if (!open) setDeleting(null);
            }}
            onConfirm={confirmDeleteField}
          />
        </>
      ) : null}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function QuietNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface) p-(--spacing-control-y) px-(--spacing-control-x)">
      <Info className="text-(--el-text-muted) size-4 shrink-0" aria-hidden />
      <p className="text-(--el-text-muted) font-sans text-xs">{children}</p>
    </div>
  );
}

/** The tinted type tile — per-type hue in the background, strong glyph
 *  (AA-safe, finding #35; the glyph map shared with the 5.3.7 rail). */
function FieldTypeTile({ type, className }: { type: CustomFieldType; className?: string }) {
  const meta = CUSTOM_FIELD_TYPE_META[type];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-(--radius-control) ${meta.tintClass} text-(--el-text-strong) ${className ?? 'size-8'}`}
      aria-hidden
    >
      <Icon className="size-4" />
    </span>
  );
}

/** The gloss line: type · option count (select only) · usage. */
function FieldGloss({ field }: { field: CustomFieldDefinitionDTO }) {
  const t = useTranslations('settings.customFields');
  const parts = [t(`type.${field.fieldType}`)];
  if (field.fieldType === 'select') parts.push(t('glossOptions', { count: field.options.length }));
  parts.push(
    field.valueCount > 0 ? t('glossUsage', { count: field.valueCount }) : t('glossNotUsed'),
  );
  return (
    <span className="text-(--el-text-muted) block truncate font-sans text-xs">
      {parts.join(' · ')}
    </span>
  );
}

// ── Field row ────────────────────────────────────────────────────────────────

function SortableFieldRow({
  field,
  canManage,
  onEdit,
  onDelete,
}: {
  field: CustomFieldDefinitionDTO;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('settings.customFields');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
    disabled: !canManage,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`field-row-${field.id}`}
      className={`border-(--el-border-soft) flex items-center gap-3 border-b py-3 last:border-b-0 ${
        isDragging ? 'opacity-60' : ''
      }`}
    >
      {canManage ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('reorderFieldAria', { label: field.label })}
          data-testid={`field-grip-${field.id}`}
          className="text-(--el-text-faint) hover:text-(--el-text-muted) inline-flex size-4 shrink-0 cursor-grab items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      ) : null}
      <FieldTypeTile type={field.fieldType} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-sm font-medium text-(--el-text)">
          {field.label}
        </span>
        <FieldGloss field={field} />
      </span>
      {canManage ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('editAria', { label: field.label })}
            onClick={onEdit}
          >
            {t('edit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('deleteAria', { label: field.label })}
            onClick={onDelete}
          >
            {t('delete')}
          </Button>
        </>
      ) : null}
    </li>
  );
}

// ── Type picker (create modal) ───────────────────────────────────────────────

function TypePicker({
  value,
  onChange,
  disabled,
}: {
  value: CustomFieldType;
  onChange: (type: CustomFieldType) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('settings.customFields');
  return (
    <div role="radiogroup" aria-label={t('typeGroupLabel')} className="flex flex-col gap-2">
      {CUSTOM_FIELD_TYPES.map((type) => {
        const selected = value === type;
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(type)}
            className={`focus-visible:ring-(--focus-ring-color) flex items-center gap-3 rounded-(--radius-card) border px-(--spacing-control-x) py-(--spacing-control-y) text-left focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default ${
              selected
                ? 'border-(--el-accent)'
                : 'border-(--el-border) enabled:hover:border-(--el-border-strong)'
            }`}
          >
            <FieldTypeTile type={type} />
            <span className="flex-1">
              <span className="block font-sans text-sm font-medium text-(--el-text)">
                {t(`type.${type}`)}
              </span>
              <span className="text-(--el-text-muted) block font-sans text-xs">
                {t(`typeDesc.${type}`)}
              </span>
            </span>
            <span
              className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
              }`}
              aria-hidden
            >
              {selected ? <span className="size-2 rounded-full bg-(--el-accent)" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Create modal ─────────────────────────────────────────────────────────────

interface PendingOption {
  id: number;
  label: string;
}

function CreateFieldModal({
  open,
  onOpenChange,
  projectKey,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectKey: string;
  onCreated: (field: CustomFieldDefinitionDTO) => void;
}) {
  const t = useTranslations('settings.customFields');
  const tc = useTranslations('common');
  const { toast } = useToast();

  const [label, setLabel] = useState('');
  const [labelError, setLabelError] = useState<string | null>(null);
  const [fieldType, setFieldType] = useState<CustomFieldType>('text');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState<PendingOption[]>([]);
  const [pending, setPending] = useState(false);
  const nextOptionIdRef = useRef(1);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setLabel('');
      setLabelError(null);
      setFieldType('text');
      setDescription('');
      setOptions([]);
    }
    onOpenChange(next);
  }

  async function handleCreate() {
    const trimmed = label.trim();
    if (!trimmed) {
      setLabelError(t('labelRequired'));
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/fields`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: trimmed,
          fieldType,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(fieldType === 'select'
            ? { options: options.map((o) => o.label.trim()).filter(Boolean) }
            : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        const description =
          data.code === 'FIELD_LIMIT_REACHED'
            ? t('toastFieldCapError', { max: MAX_FIELDS_PER_PROJECT })
            : data.code === 'OPTION_LIMIT_REACHED'
              ? t('toastOptionCapError', { max: MAX_OPTIONS_PER_FIELD })
              : t('toastCreateError');
        toast({ variant: 'error', title: t('errorGenericTitle'), description });
        return;
      }
      const data = (await res.json()) as { field: CustomFieldDefinitionDTO };
      onCreated(data.field);
      handleOpenChange(false);
      toast({ variant: 'success', title: t('createdToast', { label: data.field.label }) });
    } catch {
      toast({
        variant: 'error',
        title: t('errorGenericTitle'),
        description: t('toastCreateError'),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={handleOpenChange} title={t('createTitle')} size="lg">
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <Modal.Body className="gap-4">
          <Input
            label={t('labelLabel')}
            helperText={t('labelHelper')}
            error={labelError ?? undefined}
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              if (labelError) setLabelError(null);
            }}
            disabled={pending}
            autoFocus
          />
          <div>
            <span className="text-(--el-text-secondary) mb-1.5 block font-sans text-sm font-medium">
              {t('typeLabel')}
            </span>
            <TypePicker value={fieldType} onChange={setFieldType} disabled={pending} />
            <span className="text-(--el-text-muted) mt-1.5 block font-sans text-xs">
              {t('typeHelper')}
            </span>
          </div>
          {fieldType === 'select' ? (
            <PendingOptionsEditor
              options={options}
              onChange={setOptions}
              nextIdRef={nextOptionIdRef}
              disabled={pending}
            />
          ) : null}
          <Input
            label={t('descriptionLabel')}
            placeholder={t('descriptionPlaceholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={pending}
          />
        </Modal.Body>
        <Modal.Footer className="shrink-0">
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={pending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {t('createConfirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

/** The create-modal option list (pre-persist; the 5.3.4 panel-3 grammar:
 *  ordered rows + Add option + the 55 cap). Rows are plain inputs — nothing
 *  exists server-side yet, so rename is direct and remove is always legal
 *  (an unused option's delete is enabled, the panel-4 rule at count zero). */
function PendingOptionsEditor({
  options,
  onChange,
  nextIdRef,
  disabled,
}: {
  options: PendingOption[];
  onChange: (options: PendingOption[]) => void;
  nextIdRef: React.RefObject<number>;
  disabled?: boolean;
}) {
  const t = useTranslations('settings.customFields');
  const atCap = options.length >= MAX_OPTIONS_PER_FIELD;

  return (
    <div>
      <span className="text-(--el-text-secondary) mb-1.5 block font-sans text-sm font-medium">
        {t('optionsLabel')}
      </span>
      <div className="border-(--el-border) flex flex-col rounded-(--radius-card) border">
        {options.map((option, index) => (
          <div
            key={option.id}
            className="border-(--el-border-soft) flex items-center gap-2 border-b px-(--spacing-control-x) py-(--spacing-control-y)"
          >
            <Input
              aria-label={t('optionRename', { label: option.label || `${index + 1}` })}
              placeholder={t('addOptionPlaceholder')}
              value={option.label}
              onChange={(e) =>
                onChange(
                  options.map((o) => (o.id === option.id ? { ...o, label: e.target.value } : o)),
                )
              }
              disabled={disabled}
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('optionRemoveAria', { label: option.label || `${index + 1}` })}
              onClick={() => onChange(options.filter((o) => o.id !== option.id))}
              disabled={disabled}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        ))}
        <div className="flex items-center justify-between gap-2 px-(--spacing-control-x) py-(--spacing-control-y)">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Plus className="size-4" aria-hidden />}
            disabled={disabled || atCap}
            onClick={() => {
              onChange([...options, { id: nextIdRef.current, label: '' }]);
              nextIdRef.current += 1;
            }}
          >
            {t('addOption')}
          </Button>
          <span className="text-(--el-text-muted) font-sans text-xs">
            {atCap
              ? t('optionCapReached', { count: options.length, max: MAX_OPTIONS_PER_FIELD })
              : t('optionCapGloss', { count: options.length, max: MAX_OPTIONS_PER_FIELD })}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Edit modal ───────────────────────────────────────────────────────────────

function EditFieldModal({
  field,
  onClose,
  onFieldChange,
}: {
  field: CustomFieldDefinitionDTO;
  onClose: () => void;
  onFieldChange: (field: CustomFieldDefinitionDTO) => void;
}) {
  const t = useTranslations('settings.customFields');
  const tc = useTranslations('common');
  const { toast } = useToast();

  const [label, setLabel] = useState(field.label);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [description, setDescription] = useState(field.description ?? '');
  const [pending, setPending] = useState(false);

  async function patchFieldRequest(body: Record<string, string>) {
    const res = await fetch(`/api/fields/${encodeURIComponent(field.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('save');
    const data = (await res.json()) as { field: CustomFieldDefinitionDTO };
    onFieldChange(data.field);
  }

  async function handleSave() {
    const trimmed = label.trim();
    if (!trimmed) {
      setLabelError(t('labelRequired'));
      return;
    }
    setPending(true);
    try {
      if (trimmed !== field.label) await patchFieldRequest({ label: trimmed });
      if (description.trim() !== (field.description ?? '')) {
        await patchFieldRequest({ description: description.trim() });
      }
      onClose();
      toast({ variant: 'success', title: t('savedToast', { label: trimmed }) });
    } catch {
      toast({ variant: 'error', title: t('errorGenericTitle'), description: t('toastSaveError') });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('editTitle')}
      size="lg"
    >
      <Modal.Body className="gap-4">
        <Input
          label={t('labelLabel')}
          helperText={t('labelHelper')}
          error={labelError ?? undefined}
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            if (labelError) setLabelError(null);
          }}
          disabled={pending}
        />
        <div>
          <span className="text-(--el-text-secondary) mb-1.5 block font-sans text-sm font-medium">
            {t('typeLabel')}
          </span>
          {/* The frozen type row — immutable after create (the verified mirror rule). */}
          <div className="border-(--el-border) flex items-center gap-3 rounded-(--radius-card) border px-(--spacing-control-x) py-(--spacing-control-y)">
            <FieldTypeTile type={field.fieldType} />
            <span className="font-sans text-sm font-medium text-(--el-text)">
              {t(`type.${field.fieldType}`)}
            </span>
          </div>
          <span className="text-(--el-text-muted) mt-1.5 block font-sans text-xs">
            {t('typeHelper')}
          </span>
        </div>
        {field.fieldType === 'select' ? (
          <OptionsEditor field={field} onFieldChange={onFieldChange} />
        ) : null}
        <Input
          label={t('descriptionLabel')}
          placeholder={t('descriptionPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={pending}
        />
      </Modal.Body>
      <Modal.Footer className="shrink-0">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          {tc('cancel')}
        </Button>
        <Button loading={pending} onClick={() => void handleSave()}>
          {t('saveConfirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

// ── Options editor (edit modal — persisted options) ──────────────────────────

function OptionsEditor({
  field,
  onFieldChange,
}: {
  field: CustomFieldDefinitionDTO;
  onFieldChange: (field: CustomFieldDefinitionDTO) => void;
}) {
  const t = useTranslations('settings.customFields');
  const { toast } = useToast();

  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const display = useMemo(() => sortOptionsForDisplay(field.options), [field.options]);
  const atCap = field.options.length >= MAX_OPTIONS_PER_FIELD;

  function setPending(id: string, on: boolean) {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function replaceOption(next: CustomFieldOptionDTO) {
    onFieldChange({
      ...field,
      options: field.options.map((o) => (o.id === next.id ? next : o)),
    });
  }

  function optionError(description: string) {
    toast({ variant: 'error', title: t('errorGenericTitle'), description });
  }

  async function patchOption(option: CustomFieldOptionDTO, body: Record<string, unknown>) {
    setPending(option.id, true);
    try {
      const res = await fetch(
        `/api/fields/${encodeURIComponent(field.id)}/options/${encodeURIComponent(option.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error('option');
      const data = (await res.json()) as { option: CustomFieldOptionDTO };
      replaceOption(data.option);
      return true;
    } catch {
      optionError(t('toastOptionError'));
      return false;
    } finally {
      setPending(option.id, false);
    }
  }

  async function addOption() {
    const label = newLabel.trim();
    if (!label) return;
    setPending('new', true);
    try {
      const res = await fetch(`/api/fields/${encodeURIComponent(field.id)}/options`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        optionError(
          data.code === 'OPTION_LIMIT_REACHED'
            ? t('toastOptionCapError', { max: MAX_OPTIONS_PER_FIELD })
            : t('toastOptionError'),
        );
        return;
      }
      const data = (await res.json()) as { option: CustomFieldOptionDTO };
      onFieldChange({ ...field, options: [...field.options, data.option] });
      setNewLabel('');
      setAdding(false);
    } catch {
      optionError(t('toastOptionError'));
    } finally {
      setPending('new', false);
    }
  }

  async function deleteOption(option: CustomFieldOptionDTO) {
    setPending(option.id, true);
    try {
      const res = await fetch(
        `/api/fields/${encodeURIComponent(field.id)}/options/${encodeURIComponent(option.id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        optionError(
          data.code === 'OPTION_IN_USE' ? t('toastOptionInUseError') : t('toastOptionError'),
        );
        return;
      }
      onFieldChange({ ...field, options: field.options.filter((o) => o.id !== option.id) });
    } catch {
      optionError(t('toastOptionError'));
    } finally {
      setPending(option.id, false);
    }
  }

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const result = computeOptionReorder(display, String(active.id), String(over.id));
      if (!result) return;
      const moved = result.options.find((o) => o.id === String(active.id))!;
      const snapshot = field;
      onFieldChange({ ...field, options: result.options });
      void fetch(
        `/api/fields/${encodeURIComponent(field.id)}/options/${encodeURIComponent(moved.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ position: moved.position }),
        },
      )
        .then((res) => {
          if (!res.ok) {
            onFieldChange(snapshot);
            optionError(t('toastReorderError'));
          }
        })
        .catch(() => {
          onFieldChange(snapshot);
          optionError(t('toastReorderError'));
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [display, field, onFieldChange, t],
  );

  return (
    <div>
      <span className="text-(--el-text-secondary) mb-1.5 block font-sans text-sm font-medium">
        {t('optionsLabel')}
      </span>
      <div className="border-(--el-border) flex flex-col rounded-(--radius-card) border">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={display.filter((o) => !o.archived).map((o) => o.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul role="list" className="flex flex-col">
              {display.map((option) => (
                <SortableOptionRow
                  key={option.id}
                  option={option}
                  busy={pendingIds.has(option.id)}
                  renaming={renamingId === option.id}
                  renameValue={renameValue}
                  onRenameValueChange={setRenameValue}
                  onStartRename={() => {
                    setRenamingId(option.id);
                    setRenameValue(option.label);
                  }}
                  onCommitRename={() => {
                    const label = renameValue.trim();
                    setRenamingId(null);
                    if (label && label !== option.label) {
                      void patchOption(option, { label });
                    }
                  }}
                  onCancelRename={() => setRenamingId(null)}
                  onArchiveToggle={() => void patchOption(option, { archived: !option.archived })}
                  onDelete={() => void deleteOption(option)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        <div className="flex items-center justify-between gap-2 px-(--spacing-control-x) py-(--spacing-control-y)">
          {adding ? (
            <form
              className="flex flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void addOption();
              }}
            >
              <Input
                aria-label={t('addOption')}
                placeholder={t('addOptionPlaceholder')}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                disabled={pendingIds.has('new')}
                autoFocus
              />
              <Button type="submit" size="sm" loading={pendingIds.has('new')}>
                {t('addOptionCommit')}
              </Button>
            </form>
          ) : atCap ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Plus className="size-4" aria-hidden />}
              disabled
            >
              {t('addOption')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Plus className="size-4" aria-hidden />}
              onClick={() => setAdding(true)}
            >
              {t('addOption')}
            </Button>
          )}
          <span className="text-(--el-text-muted) shrink-0 font-sans text-xs">
            {atCap
              ? t('optionCapReached', { count: field.options.length, max: MAX_OPTIONS_PER_FIELD })
              : t('optionCapGloss', { count: field.options.length, max: MAX_OPTIONS_PER_FIELD })}
          </span>
        </div>
      </div>
    </div>
  );
}

function SortableOptionRow({
  option,
  busy,
  renaming,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onArchiveToggle,
  onDelete,
}: {
  option: CustomFieldOptionDTO;
  busy: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('settings.customFields');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: option.id,
    disabled: option.archived,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };

  // The verified delete-only-when-unused affordance: an in-use option's
  // Delete is disabled with the "archive instead" tooltip (the count names
  // the usage); delete is enabled only at zero usage. The service's 409 +
  // the DB Restrict remain the authority behind the affordance.
  const inUse = option.valueCount > 0;

  const deleteButton = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={t('deleteAria', { label: option.label })}
      disabled={busy}
      onClick={onDelete}
    >
      {t('delete')}
    </Button>
  );

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`option-row-${option.id}`}
      className={`border-(--el-border-soft) flex items-center gap-2 border-b px-(--spacing-control-x) py-(--spacing-control-y) last:border-b-0 ${
        isDragging ? 'opacity-60' : ''
      } ${option.archived ? 'opacity-70' : ''}`}
    >
      {!option.archived ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('reorderOptionAria', { label: option.label })}
          className="text-(--el-text-faint) hover:text-(--el-text-muted) inline-flex size-4 shrink-0 cursor-grab items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      ) : (
        <span className="size-4 shrink-0" aria-hidden />
      )}

      {renaming ? (
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onCommitRename();
          }}
        >
          <Input
            aria-label={t('optionRename', { label: option.label })}
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelRename();
            }}
            autoFocus
          />
          <Button type="submit" variant="ghost" size="sm">
            {t('optionRenameSave')}
          </Button>
        </form>
      ) : (
        <>
          <button
            type="button"
            className="focus-visible:ring-(--focus-ring-color) min-w-0 flex-1 truncate rounded-(--radius-control) text-left font-sans text-sm text-(--el-text) focus-visible:outline-none focus-visible:ring-2"
            aria-label={t('optionRename', { label: option.label })}
            onClick={onStartRename}
            disabled={busy}
          >
            {option.label}
          </button>
          {option.archived ? (
            <>
              <Pill tone="neutral">{t('archivedPill')}</Pill>
              <span className="text-(--el-text-muted) hidden shrink-0 font-sans text-xs sm:block">
                {t('archivedGloss')}
              </span>
            </>
          ) : inUse ? (
            <span className="text-(--el-text-muted) hidden shrink-0 font-sans text-xs sm:block">
              {t('optionUsage', { count: option.valueCount })}
            </span>
          ) : null}
          <Button variant="ghost" size="sm" disabled={busy} onClick={onArchiveToggle}>
            {option.archived ? t('unarchive') : t('archive')}
          </Button>
          {inUse ? (
            <Tooltip content={t('optionInUseTooltip', { count: option.valueCount })}>
              <span
                tabIndex={0}
                className="focus-visible:ring-(--focus-ring-color) inline-flex rounded-(--radius-btn) focus-visible:outline-none focus-visible:ring-2"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled
                  aria-label={t('deleteAria', { label: option.label })}
                >
                  {t('delete')}
                </Button>
              </span>
            </Tooltip>
          ) : (
            deleteButton
          )}
        </>
      )}
    </li>
  );
}

// ── Delete-field confirm ─────────────────────────────────────────────────────

function DeleteFieldModal({
  field,
  onOpenChange,
  onConfirm,
}: {
  field: CustomFieldDefinitionDTO | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (field: CustomFieldDefinitionDTO) => void;
}) {
  const t = useTranslations('settings.customFields');
  const tc = useTranslations('common');
  if (!field) return null;

  return (
    <Modal open onOpenChange={onOpenChange} size="md">
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--el-tint-rose)' }}
        >
          <TriangleAlert className="h-5 w-5" style={{ color: 'var(--el-danger)' }} aria-hidden />
        </span>
        <div>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('deleteFieldTitle', { label: field.label })}
          </h2>
          <p className="text-(--el-text-muted) mt-1 font-sans text-sm">
            {field.valueCount > 0
              ? t.rich('deleteFieldBody', {
                  count: field.valueCount,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })
              : t('deleteFieldBodyNoValues')}
          </p>
        </div>
      </div>
      <Modal.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button variant="danger" onClick={() => onConfirm(field)}>
          {t('deleteFieldConfirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
