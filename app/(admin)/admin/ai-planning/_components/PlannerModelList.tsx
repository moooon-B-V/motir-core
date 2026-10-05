'use client';

import { useId, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ListChecks, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type {
  PlatformPlannerModelListDTO,
  PlatformPlannerModelListEntryDTO,
} from '@/lib/dto/platformPlannerModel';
import {
  addPlannerListModelAction,
  removePlannerListModelAction,
  type PlannerListActionResult,
} from '../actions';

/**
 * The PLANNING-MODEL LIST card — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-04 (Model lists) Panels 1–4 and 12, card MOTIR-7527; its
 * Add dialog is a picker of motir-ai's `candidates` (MOTIR-7614), drawn as the
 * run list's add (Panel 6) — § AMENDMENT 2026-10-05.
 *
 * Which models an audience may be set to. The rows are server-rendered props
 * and the actions `revalidatePath` the page, so a write re-reads the list AND
 * the audience pickers above it (`CLAUDE.md`'s page-state contract, its
 * simplest branch). This island owns only what is not stored: an open dialog,
 * its draft, and the last refusal.
 *
 * ⚠️ The missing controls are presentation. A `support` / `operator` reader
 * gets plain rows (Panel 2); the action and the service both re-gate at
 * `superadmin`.
 */

export interface PlannerModelListProps {
  list: PlatformPlannerModelListDTO;
}

type Translator = ReturnType<typeof useTranslations<'platformAdmin'>>;

export function PlannerModelList({ list }: PlannerModelListProps) {
  const t = useTranslations('platformAdmin');
  // The models this tab added. "Added just now by you" holds while listed.
  const [addedHere, setAddedHere] = useState<string[]>([]);

  return (
    <>
      <Card
        data-testid="planner-model-list"
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
              >
                <ListChecks className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                  {t('planningList.title')}
                </h2>
                <p className="font-sans text-xs text-(--el-text-secondary)">
                  {t('planningList.subtitle')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Pill tone="neutral">{t('modelLists.count', { n: list.entries.length })}</Pill>
              {list.canEdit ? (
                <AddPlannerModel
                  candidates={list.candidates}
                  onAdded={(m) => setAddedHere((prev) => [...prev, m])}
                />
              ) : null}
            </div>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse font-sans text-sm">
            <thead>
              <tr className="border-b border-(--el-border) text-left">
                <Th>{t('modelLists.col.model')}</Th>
                <Th>{t('modelLists.col.offered')}</Th>
                <Th>{t('modelLists.col.inUse')}</Th>
                <Th>{t('modelLists.col.added')}</Th>
                {list.canEdit ? (
                  <Th>
                    <span className="sr-only">{t('modelLists.col.action')}</span>
                  </Th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {list.entries.map((entry) => (
                <PlannerListRow
                  key={entry.model}
                  entry={entry}
                  canEdit={list.canEdit}
                  addedHere={addedHere.includes(entry.model)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {list.canEdit ? null : (
        <p
          data-testid="planner-model-list-read-only"
          className="font-sans text-xs text-(--el-text-secondary)"
        >
          {t('modelLists.readOnly')}
        </p>
      )}
    </>
  );
}

function PlannerListRow({
  entry,
  canEdit,
  addedHere,
}: {
  entry: PlatformPlannerModelListEntryDTO;
  canEdit: boolean;
  addedHere: boolean;
}) {
  const t = useTranslations('platformAdmin');
  const format = useFormatter();
  const [refusal, setRefusal] = useState<string | null>(null);

  const audiences = entry.inUseBy.map((a) => t(`aiPlanning.audience.${a}.name`));
  const addedLine = addedHere
    ? t('modelLists.added.justNowByYou')
    : entry.seeded
      ? t('modelLists.added.seeded')
      : entry.addedBy
        ? t('modelLists.added.by', {
            when: formatWhen(format, entry.createdAt),
            who: entry.addedBy,
          })
        : t('modelLists.added.byUnknown', { when: formatWhen(format, entry.createdAt) });

  return (
    <tr
      data-testid={`planner-model-list-row-${entry.model}`}
      className="border-b border-(--el-border-soft) last:border-b-0"
    >
      <Td>
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-xs text-(--el-text)">{entry.model}</span>
          <span className="text-xs text-(--el-text-identifier)">
            {entry.provider ?? t('modelLists.notInCatalog')}
          </span>
          {refusal ? (
            <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
              {refusal}
            </p>
          ) : null}
        </div>
      </Td>
      <Td>
        {entry.offered ? (
          <Pill severity="success">{t('modelLists.offered')}</Pill>
        ) : (
          <div className="flex flex-col items-start gap-1">
            <Pill severity="warning">{t('modelLists.notOffered')}</Pill>
            {entry.reason ? (
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t(`planningList.reason.${entry.reason}`)}
              </p>
            ) : null}
          </div>
        )}
      </Td>
      <Td className="text-xs text-(--el-text-secondary)">
        <div className="flex flex-col gap-0.5">
          {audiences.length > 0 ? (
            <span className="text-(--el-text-strong)">{audiences.join(', ')}</span>
          ) : entry.fallback ? null : (
            <span>{t('modelLists.inUse.nothing')}</span>
          )}
          {entry.fallback ? <span>{t('planningList.fallback')}</span> : null}
        </div>
      </Td>
      <Td className="text-xs text-(--el-text-secondary)">{addedLine}</Td>
      {canEdit ? (
        <Td>
          <RemovePlannerModel entry={entry} onRefused={setRefusal} />
        </Td>
      ) : null}
    </tr>
  );
}

function AddPlannerModel({
  candidates,
  onAdded,
}: {
  candidates: PlatformPlannerModelListDTO['candidates'];
  onAdded: (model: string) => void;
}) {
  const t = useTranslations('platformAdmin');
  const { toast } = useToast();
  const modelId = useId();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function close() {
    setOpen(false);
    setModel(null);
    setReason('');
    setRefusal(null);
  }

  function submit() {
    const why = reason.trim();
    if (!model || !why) return;
    const id = model;
    startTransition(async () => {
      const result = await addPlannerListModelAction(id, why);
      if (result.ok) {
        onAdded(id);
        close();
        toast({ variant: 'success', title: t('planningList.added', { model: id }) });
        return;
      }
      // Panel 3b: the dialog stays open with the reason; nothing was added. A
      // candidate can stop being plannable between the read and this confirm.
      setRefusal(addRefusalText(t, result));
    });
  }

  const options = candidates.map((m) => ({ value: m.id, label: m.id, group: m.provider }));

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<Plus className="h-3.5 w-3.5" />}
        onClick={() => setOpen(true)}
      >
        {t('modelLists.add')}
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => (next ? undefined : close())}
        role="alertdialog"
        title={t('planningList.add.title')}
        description={t('planningList.add.body')}
        size="md"
      >
        <Modal.Body className="gap-4">
          {options.length === 0 ? (
            <p
              data-testid="planner-model-add-nothing"
              className="font-sans text-sm text-(--el-text-secondary)"
            >
              {t('planningList.add.nothing')}
            </p>
          ) : (
            <>
              <Combobox
                id={modelId}
                label={t('planningList.add.modelLabel')}
                placeholder={t('planningList.add.placeholder')}
                options={options}
                value={model}
                onChange={(value) => {
                  setRefusal(null);
                  setModel(value);
                }}
                footer={
                  <span className="font-sans text-xs text-(--el-text-secondary)">
                    {t('planningList.add.pickerFoot')}
                  </span>
                }
              />
              <Input
                id={reasonId}
                label={t('modelLists.reasonLabel')}
                placeholder={t('modelLists.reasonPlaceholder')}
                helperText={t('modelLists.reasonHint')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={280}
              />
            </>
          )}
          {refusal ? (
            <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
              {refusal}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={close} disabled={isPending}>
            {t('modelLists.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={isPending}
            disabled={!model || reason.trim().length === 0}
          >
            {t('planningList.add.confirm')}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}

function RemovePlannerModel({
  entry,
  onRefused,
}: {
  entry: PlatformPlannerModelListEntryDTO;
  onRefused: (text: string | null) => void;
}) {
  const t = useTranslations('platformAdmin');
  const { toast } = useToast();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();

  function close() {
    setOpen(false);
    setReason('');
  }

  function submit() {
    const why = reason.trim();
    if (!why) return;
    startTransition(async () => {
      const result = await removePlannerListModelAction(entry.model, why);
      close();
      if (result.ok) {
        onRefused(null);
        toast({ variant: 'success', title: t('planningList.removed', { model: entry.model }) });
        return;
      }
      // Panel 4b / 4c: the refusal sits on the row it is about.
      onRefused(removeRefusalText(t, result, entry.model));
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-label={t('modelLists.removeAria', { model: entry.model })}
        leftIcon={<Trash2 className="h-3.5 w-3.5" />}
        onClick={() => {
          onRefused(null);
          setOpen(true);
        }}
      >
        {t('modelLists.remove')}
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => (next ? undefined : close())}
        role="alertdialog"
        title={t('planningList.remove.title', { model: entry.model })}
        description={t('planningList.remove.body')}
        size="md"
      >
        <Modal.Body className="gap-4">
          <Input
            id={reasonId}
            label={t('modelLists.reasonLabel')}
            placeholder={t('modelLists.reasonPlaceholder')}
            helperText={t('modelLists.reasonHint')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            autoFocus
            maxLength={280}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={close} disabled={isPending}>
            {t('modelLists.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={submit}
            loading={isPending}
            disabled={reason.trim().length === 0}
          >
            {t('planningList.remove.confirm')}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}

type Refusal = Extract<PlannerListActionResult, { ok: false }>;

function commonRefusalText(t: Translator, result: Refusal): string {
  switch (result.code) {
    case 'REASON_REQUIRED':
      return t('modelLists.error.reasonRequired');
    case 'NOT_PERMITTED':
      return t('modelLists.error.notPermitted');
    case 'UNAVAILABLE':
      return t('modelLists.error.unavailable');
    default:
      return t('modelLists.error.failed');
  }
}

function addRefusalText(t: Translator, result: Refusal): string {
  if (result.code === 'NOT_QUALIFIED') {
    // motir-ai's three reasons are localized; anything else is shown as it came.
    const detail = result.reason ? t(`planningList.reason.${result.reason}`) : result.detail;
    return t('planningList.add.refused', { detail });
  }
  if (result.code === 'REFUSED') return t('planningList.add.refused', { detail: result.detail });
  return commonRefusalText(t, result);
}

function removeRefusalText(t: Translator, result: Refusal, model: string): string {
  if (result.code === 'IN_USE') {
    const audiences = result.audiences
      .map((a) =>
        a === 'customer' || a === 'meta' || a === 'internal'
          ? t(`aiPlanning.audience.${a}.name`)
          : a,
      )
      .join(', ');
    return t('planningList.remove.inUse', { audiences, model });
  }
  if (result.code === 'FALLBACK') return t('planningList.remove.fallback', { model });
  if (result.code === 'REFUSED') return t('planningList.remove.refused', { detail: result.detail });
  return commonRefusalText(t, result);
}

function formatWhen(format: ReturnType<typeof useFormatter>, iso: string): string {
  return format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-3 pr-4 align-top ${className}`}>{children}</td>;
}
