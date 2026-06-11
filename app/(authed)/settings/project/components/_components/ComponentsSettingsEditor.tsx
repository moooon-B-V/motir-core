'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Component as ComponentIcon, Info, Plus, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { ComponentDto, ComponentWithCountDto } from '@/lib/dto/components';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// ComponentsSettingsEditor (Story 5.4 · Subtask 5.4.10) — the Components
// admin UI at Project settings → Components, built against
// design/projects/components.mock.html (the 5.4.7 design asset; THE layout
// authority) and calling the 5.4.3 REST API. Structure mirrors the shipped
// settings editors (the 6.4.5 members page / 5.3.6 fields page):
//
//   • mutations go fetch → 5.4.3 route → componentsService with optimistic
//     local state + revert-and-toast on failure — the shipped
//     settings-mutation grammar (which the Subtask card's "server actions"
//     line yields to, per the decision-authority ladder rung 2 — the 5.3.6
//     precedent);
//   • rows are NAME-ordered (listComponents returns nameLower order) and
//     never manually reordered — no grip, unlike fields (the mirror rule);
//   • `canManage` (computed server-side, re-gated in the service on every
//     write) governs whether the mutation affordances render at all — the
//     read-only degradation HIDES them (Read-only pill + the quiet
//     permission line), per the 5.4.7 notes: every control here is a
//     mutation, so hiding is the legible shape;
//   • the verified mirror rules render as drawn: the case-insensitive
//     unique-name 409 surfaces INLINE under the Name input naming the
//     EXISTING casing; deleting an IN-USE component forces the
//     move-or-remove radio choice (the 6.4.1 radio-card grammar, move
//     target excluding self) with the count refetched when the dialog
//     opens, while an unused component confirms simply.

/** Combobox sentinel for the explicit "None" row (no automatic assignment). */
const NONE = '__none__';

/** Sort the list the way the server returns it — nameLower ascending. */
function byName(a: ComponentWithCountDto, b: ComponentWithCountDto): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export interface ComponentsSettingsEditorProps {
  projectKey: string;
  components: ComponentWithCountDto[];
  /** The 6.4.6 assignable set — who the default-assignee picker may offer. */
  assignableMembers: WorkspaceMemberDTO[];
  canManage: boolean;
}

export function ComponentsSettingsEditor({
  projectKey,
  components: initialComponents,
  assignableMembers,
  canManage,
}: ComponentsSettingsEditorProps) {
  const t = useTranslations('settings.components');
  const { toast } = useToast();

  const [components, setComponents] = useState<ComponentWithCountDto[]>(initialComponents);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ComponentWithCountDto | null>(null);

  const editingComponent = editingId ? (components.find((c) => c.id === editingId) ?? null) : null;

  /** Resolve a picked default assignee to the row's renderable user. */
  function resolveAssignee(userId: string | null) {
    if (userId == null) return null;
    const member = assignableMembers.find((m) => m.userId === userId);
    return member ? { id: member.userId, name: member.name, email: member.email } : null;
  }

  function upsertSorted(next: ComponentWithCountDto) {
    setComponents((current) => [...current.filter((c) => c.id !== next.id), next].sort(byName));
  }

  // The consequence statement is fetched fresh when the delete dialog opens
  // (the 5.3.6 pattern) — refresh the list and the held count behind it.
  function openDeleteConfirm(component: ComponentWithCountDto) {
    setDeleting(component);
    void fetch(`/api/projects/${encodeURIComponent(projectKey)}/components`)
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { components?: ComponentWithCountDto[] };
        if (!Array.isArray(data.components)) return;
        const fresh = data.components.find((c) => c.id === component.id);
        setComponents(data.components);
        if (fresh) setDeleting((cur) => (cur && cur.id === component.id ? fresh : cur));
      })
      .catch(() => undefined);
  }

  async function confirmDelete(component: ComponentWithCountDto, moveToComponentId: string | null) {
    const snapshot = components;
    setComponents((current) => current.filter((c) => c.id !== component.id));
    setDeleting(null);
    try {
      const res = await fetch(`/api/components/${encodeURIComponent(component.id)}`, {
        method: 'DELETE',
        ...(moveToComponentId
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ moveToComponentId }),
            }
          : {}),
      });
      if (!res.ok) throw new Error();
      toast({ variant: 'success', title: t('deletedToast', { name: component.name }) });
      // The move branch shifts the target's in-use count server-side
      // (duplicates skipped) — true the list up from the source of record.
      if (moveToComponentId) {
        const fresh = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/components`);
        if (fresh.ok) {
          const data = (await fresh.json()) as { components?: ComponentWithCountDto[] };
          if (Array.isArray(data.components)) setComponents(data.components);
        }
      }
    } catch {
      setComponents(snapshot);
      toast({
        variant: 'error',
        title: t('errorGenericTitle'),
        description: t('toastDeleteError'),
      });
    }
  }

  const showEmpty = components.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {showEmpty ? (
        <EmptyState
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          icon={<ComponentIcon className="h-12 w-12" aria-hidden />}
          action={
            canManage ? (
              <Button
                leftIcon={<Plus className="size-4" aria-hidden />}
                onClick={() => setCreateOpen(true)}
              >
                {t('addComponent')}
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
                <Pill tone="neutral" aria-label={t('countPillLabel', { count: components.length })}>
                  {components.length}
                </Pill>
              </div>
              {canManage ? (
                <Button
                  size="sm"
                  leftIcon={<Plus className="size-4" aria-hidden />}
                  onClick={() => setCreateOpen(true)}
                >
                  {t('addComponent')}
                </Button>
              ) : (
                <Pill tone="neutral">{t('readOnly')}</Pill>
              )}
            </div>
          }
        >
          {!canManage ? (
            <div className="mb-3 flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface) p-(--spacing-control-y) px-(--spacing-control-x)">
              <Info className="text-(--el-text-muted) size-4 shrink-0" aria-hidden />
              <p className="text-(--el-text-muted) font-sans text-xs">{t('readOnlyNote')}</p>
            </div>
          ) : null}

          <ul role="list" className="flex flex-col">
            {components.map((component) => (
              <ComponentRow
                key={component.id}
                component={component}
                canManage={canManage}
                onEdit={() => setEditingId(component.id)}
                onDelete={() => openDeleteConfirm(component)}
              />
            ))}
          </ul>
        </Card>
      )}

      {canManage ? (
        <>
          <CreateComponentModal
            open={createOpen}
            onOpenChange={setCreateOpen}
            projectKey={projectKey}
            components={components}
            assignableMembers={assignableMembers}
            onCreated={(component, defaultAssigneeId) =>
              upsertSorted({
                ...component,
                defaultAssignee: resolveAssignee(defaultAssigneeId),
                itemCount: 0,
              })
            }
          />
          {editingComponent ? (
            <EditComponentModal
              component={editingComponent}
              components={components}
              assignableMembers={assignableMembers}
              onClose={() => setEditingId(null)}
              onSaved={(component) =>
                upsertSorted({
                  ...editingComponent,
                  ...component,
                  defaultAssignee: resolveAssignee(component.defaultAssigneeId),
                })
              }
            />
          ) : null}
          <DeleteComponentModal
            component={deleting}
            components={components}
            onOpenChange={(open) => {
              if (!open) setDeleting(null);
            }}
            onConfirm={confirmDelete}
          />
        </>
      ) : null}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

/** The neutral component tile — the 5.4.6 recorded decision: components stay
 *  NEUTRAL (no invented hue) so the labels' name-hash tints read as
 *  meaningful; colour enters via avatars and the state grammars. */
function ComponentTile({ className }: { className?: string }) {
  return (
    <span
      className={`border-(--el-border-soft) bg-(--el-surface) text-(--el-text-secondary) inline-flex shrink-0 items-center justify-center rounded-(--radius-control) border ${className ?? 'size-8'}`}
      aria-hidden
    >
      <ComponentIcon className="size-4" />
    </span>
  );
}

/** The shipped ink-circle initial avatar (the MembersCard grammar). */
function InkAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={`bg-(--el-text) text-(--el-text-inverted) inline-flex shrink-0 items-center justify-center rounded-full font-sans font-semibold ${className ?? 'size-7 text-xs'}`}
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** The dashed "no assignee" avatar — absence conveyed with text, never
 *  colour alone (the visible "None" carries the meaning). */
function NoneAvatar({ className }: { className?: string }) {
  return (
    <span
      className={`border-(--el-border-strong) text-(--el-text-faint) inline-flex shrink-0 items-center justify-center rounded-full border border-dashed font-sans text-xs ${className ?? 'size-7'}`}
      aria-hidden
    >
      —
    </span>
  );
}

// ── Component row (members-row grammar; NO grip — name-ordered) ──────────────

function ComponentRow({
  component,
  canManage,
  onEdit,
  onDelete,
}: {
  component: ComponentWithCountDto;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('settings.components');
  return (
    <li
      data-testid={`component-row-${component.id}`}
      className="border-(--el-border-soft) flex items-center gap-3 border-b py-3 last:border-b-0"
    >
      <ComponentTile />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-sm font-medium text-(--el-text)">
          {component.name}
        </span>
        {component.description ? (
          <span className="text-(--el-text-muted) block truncate font-sans text-xs">
            {component.description}
          </span>
        ) : null}
      </span>
      <span className="flex w-[9.5rem] shrink-0 items-center gap-2">
        {component.defaultAssignee ? (
          <InkAvatar name={component.defaultAssignee.name || component.defaultAssignee.email} />
        ) : (
          <NoneAvatar />
        )}
        <span className="min-w-0">
          <span
            className={`block truncate font-sans text-xs ${
              component.defaultAssignee ? 'text-(--el-text)' : 'text-(--el-text-muted)'
            }`}
          >
            {component.defaultAssignee?.name ?? t('noneName')}
          </span>
          {/* --el-text-muted, not -faint: 11px text on the page bg needs the
              AA-passing sublabel token (the 5.3.6 fields-row grammar) — the
              faint tier sits at 2.6:1 here (5.4.11's strict axe sweep). */}
          <span className="text-(--el-text-muted) block font-sans text-[11px]">
            {t('defaultAssigneeSublabel')}
          </span>
        </span>
      </span>
      <span className="text-(--el-text-muted) w-[5.75rem] shrink-0 text-right font-sans text-xs">
        {component.itemCount > 0 ? t('usage', { count: component.itemCount }) : t('notUsed')}
      </span>
      {canManage ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('editAria', { name: component.name })}
            onClick={onEdit}
          >
            {t('edit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('deleteAria', { name: component.name })}
            onClick={onDelete}
          >
            {t('delete')}
          </Button>
        </>
      ) : null}
    </li>
  );
}

// ── Default-assignee picker (the 6.4.1 add-member Combobox grammar) ──────────

function DefaultAssigneePicker({
  value,
  onChange,
  assignableMembers,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  assignableMembers: WorkspaceMemberDTO[];
  disabled?: boolean;
}) {
  const t = useTranslations('settings.components');
  const id = useId();

  const options = useMemo<ComboboxOption<string>[]>(
    () => [
      {
        value: NONE,
        label: t('pickerNone'),
        secondary: t('pickerNoneGloss'),
        icon: <NoneAvatar className="size-[22px]" />,
      },
      ...assignableMembers.map((m) => ({
        value: m.userId,
        label: m.name,
        secondary: m.email,
        keywords: m.email,
        icon: <InkAvatar name={m.name || m.email} className="size-[22px] text-[10px]" />,
      })),
    ],
    [assignableMembers, t],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <FormField
        label={t('defaultAssigneeLabel')}
        htmlFor={id}
        helperText={t('defaultAssigneeHelper')}
      >
        <Combobox
          id={id}
          options={options}
          value={value}
          onChange={onChange}
          label={t('defaultAssigneeLabel')}
          searchable
          searchPlaceholder={t('pickerSearch')}
          emptyText={t('pickerEmpty')}
          disabled={disabled}
        />
      </FormField>
      <p className="text-(--el-text-muted) font-sans text-xs">{t('pickerScopeNote')}</p>
    </div>
  );
}

// ── Create / edit form plumbing ──────────────────────────────────────────────

/** Surface the case-insensitive unique-name 409 INLINE, naming the EXISTING
 *  casing (the 5.4.7 legend) — the local list holds the display form. */
function conflictMessage(
  t: (key: 'nameConflict', values: { name: string }) => string,
  components: ComponentWithCountDto[],
  submitted: string,
): string {
  const existing = components.find((c) => c.name.toLowerCase() === submitted.toLowerCase());
  return t('nameConflict', { name: existing?.name ?? submitted });
}

function CreateComponentModal({
  open,
  onOpenChange,
  projectKey,
  components,
  assignableMembers,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectKey: string;
  components: ComponentWithCountDto[];
  assignableMembers: WorkspaceMemberDTO[];
  onCreated: (component: ComponentDto, defaultAssigneeId: string | null) => void;
}) {
  const t = useTranslations('settings.components');
  const tc = useTranslations('common');
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState<string>(NONE);
  const [pending, setPending] = useState(false);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setName('');
      setNameError(null);
      setDescription('');
      setAssigneeId(NONE);
    }
    onOpenChange(next);
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('nameRequired'));
      return;
    }
    const defaultAssigneeId = assigneeId === NONE ? null : assigneeId;
    setPending(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/components`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(defaultAssigneeId ? { defaultAssigneeId } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        if (data.code === 'COMPONENT_NAME_CONFLICT') {
          setNameError(conflictMessage(t, components, trimmed));
        } else {
          toast({
            variant: 'error',
            title: t('errorGenericTitle'),
            description: t('toastCreateError'),
          });
        }
        return;
      }
      const data = (await res.json()) as { component: ComponentDto };
      onCreated(data.component, defaultAssigneeId);
      handleOpenChange(false);
      toast({ variant: 'success', title: t('createdToast', { name: data.component.name }) });
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
    <Modal open={open} onOpenChange={handleOpenChange} title={t('createTitle')} size="md">
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <Input
            label={t('nameLabel')}
            helperText={t('nameHelper')}
            error={nameError ?? undefined}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            disabled={pending}
            autoFocus
          />
          <Input
            label={t('descriptionLabel')}
            placeholder={t('descriptionPlaceholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={pending}
          />
          <DefaultAssigneePicker
            value={assigneeId}
            onChange={setAssigneeId}
            assignableMembers={assignableMembers}
            disabled={pending}
          />
        </div>
        <Modal.Footer>
          <Button variant="ghost" type="button" onClick={() => handleOpenChange(false)}>
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

function EditComponentModal({
  component,
  components,
  assignableMembers,
  onClose,
  onSaved,
}: {
  component: ComponentWithCountDto;
  components: ComponentWithCountDto[];
  assignableMembers: WorkspaceMemberDTO[];
  onClose: () => void;
  onSaved: (component: ComponentDto) => void;
}) {
  const t = useTranslations('settings.components');
  const tc = useTranslations('common');
  const { toast } = useToast();

  const [name, setName] = useState(component.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [description, setDescription] = useState(component.description ?? '');
  const [assigneeId, setAssigneeId] = useState<string>(component.defaultAssigneeId ?? NONE);
  const [pending, setPending] = useState(false);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('nameRequired'));
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/components/${encodeURIComponent(component.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          description: description.trim() || null,
          defaultAssigneeId: assigneeId === NONE ? null : assigneeId,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        if (data.code === 'COMPONENT_NAME_CONFLICT') {
          setNameError(conflictMessage(t, components, trimmed));
        } else {
          toast({
            variant: 'error',
            title: t('errorGenericTitle'),
            description: t('toastSaveError'),
          });
        }
        return;
      }
      const data = (await res.json()) as { component: ComponentDto };
      onSaved(data.component);
      onClose();
      toast({ variant: 'success', title: t('savedToast', { name: data.component.name }) });
    } catch {
      toast({
        variant: 'error',
        title: t('errorGenericTitle'),
        description: t('toastSaveError'),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('editTitle')}
      size="md"
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <Input
            label={t('nameLabel')}
            helperText={t('nameHelper')}
            error={nameError ?? undefined}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            disabled={pending}
            autoFocus
          />
          <Input
            label={t('descriptionLabel')}
            placeholder={t('descriptionPlaceholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={pending}
          />
          <DefaultAssigneePicker
            value={assigneeId}
            onChange={setAssigneeId}
            assignableMembers={assignableMembers}
            disabled={pending}
          />
        </div>
        <Modal.Footer>
          <Button variant="ghost" type="button" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {t('saveConfirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

// ── Delete confirm — the verified move-or-remove choice ──────────────────────

function DeleteComponentModal({
  component,
  components,
  onOpenChange,
  onConfirm,
}: {
  component: ComponentWithCountDto | null;
  components: ComponentWithCountDto[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (component: ComponentWithCountDto, moveToComponentId: string | null) => void;
}) {
  if (!component) return null;
  return (
    <DeleteComponentModalInner
      key={component.id}
      component={component}
      components={components}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  );
}

function DeleteComponentModalInner({
  component,
  components,
  onOpenChange,
  onConfirm,
}: {
  component: ComponentWithCountDto;
  components: ComponentWithCountDto[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (component: ComponentWithCountDto, moveToComponentId: string | null) => void;
}) {
  const t = useTranslations('settings.components');
  const tc = useTranslations('common');

  // The move target excludes the component being deleted (the mirror rule);
  // with no other component to move to, only the remove branch is offered.
  const others = useMemo(
    () => components.filter((c) => c.id !== component.id),
    [components, component.id],
  );
  const inUse = component.itemCount > 0;
  const canMove = inUse && others.length > 0;
  const [choice, setChoice] = useState<'move' | 'remove'>(canMove ? 'move' : 'remove');
  const [moveTargetId, setMoveTargetId] = useState<string | null>(others[0]?.id ?? null);

  const targetOptions = useMemo<ComboboxOption<string>[]>(
    () =>
      others.map((c) => ({
        value: c.id,
        label: c.name,
        icon: <ComponentTile className="size-[22px]" />,
      })),
    [others],
  );

  const moveSelected = canMove && choice === 'move';

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      size="md"
      srTitle={t('deleteTitle', { name: component.name })}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="flex items-center gap-3">
          <span
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: 'var(--el-tint-rose)' }}
          >
            <TriangleAlert className="h-5 w-5" style={{ color: 'var(--el-danger)' }} aria-hidden />
          </span>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('deleteTitle', { name: component.name })}
          </h2>
        </div>
        <p className="text-(--el-text-secondary) font-sans text-sm">
          {inUse
            ? t.rich('deleteInUseBody', {
                name: component.name,
                count: component.itemCount,
                strong: (chunks) => <strong>{chunks}</strong>,
              })
            : t('deleteUnusedBody')}
        </p>

        {inUse ? (
          <div
            role="radiogroup"
            aria-label={t('deleteChoiceLabel')}
            className="flex flex-col gap-2"
          >
            {canMove ? (
              <div
                className={`rounded-(--radius-card) border p-3 ${
                  moveSelected
                    ? 'border-(--el-accent) shadow-[0_0_0_1px_var(--el-accent)]'
                    : 'border-(--el-border)'
                }`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={moveSelected}
                  onClick={() => setChoice('move')}
                  className="focus-visible:ring-(--focus-ring-color) flex w-full items-start gap-2.5 rounded-(--radius-control) text-left focus-visible:outline-none focus-visible:ring-2"
                >
                  <ChoiceDot selected={moveSelected} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-sans text-sm font-semibold text-(--el-text)">
                      {t('moveChoice', { count: component.itemCount })}
                    </span>
                    <span className="text-(--el-text-muted) block font-sans text-xs">
                      {t('moveChoiceGloss', { name: component.name })}
                    </span>
                  </span>
                </button>
                {moveSelected ? (
                  <div className="mt-2 pl-[26px]">
                    <Combobox
                      options={targetOptions}
                      value={moveTargetId}
                      onChange={setMoveTargetId}
                      label={t('moveTargetLabel')}
                      className="max-w-[14rem]"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              role="radio"
              aria-checked={choice === 'remove'}
              onClick={() => setChoice('remove')}
              className={`focus-visible:ring-(--focus-ring-color) flex items-start gap-2.5 rounded-(--radius-card) border p-3 text-left focus-visible:outline-none focus-visible:ring-2 ${
                choice === 'remove'
                  ? 'border-(--el-accent) shadow-[0_0_0_1px_var(--el-accent)]'
                  : 'border-(--el-border)'
              }`}
            >
              <ChoiceDot selected={choice === 'remove'} />
              <span className="min-w-0 flex-1">
                <span className="block font-sans text-sm font-semibold text-(--el-text)">
                  {t('removeChoice', { count: component.itemCount })}
                </span>
                <span className="text-(--el-text-muted) block font-sans text-xs">
                  {t('removeChoiceGloss')}
                </span>
              </span>
            </button>
          </div>
        ) : null}
      </div>
      <Modal.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button
          variant="danger"
          disabled={moveSelected && !moveTargetId}
          onClick={() => onConfirm(component, moveSelected ? moveTargetId : null)}
        >
          {t('deleteConfirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** The radio-card dot (the 6.4.1 access-card grammar, dot on the left). */
function ChoiceDot({ selected }: { selected: boolean }) {
  return (
    <span
      className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
        selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
      }`}
      aria-hidden
    >
      {selected ? <span className="size-2 rounded-full bg-(--el-accent)" /> : null}
    </span>
  );
}
