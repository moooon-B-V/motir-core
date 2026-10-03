'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronDown, Globe, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { Switch } from '@/components/ui/Switch';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import type { PlatformLessonDetailDTO, PlatformLessonEditInput } from '@/lib/dto/platformLessons';
import {
  editLessonAction,
  promoteLessonAction,
  setLessonEnabledAction,
  type LessonActionResult,
} from '../actions';
import { GlobalPill, LessonInjectionCell, LessonTypePill, useLessonTypeLabel } from './LessonBits';

/**
 * The lesson's HEADER and TEXT card with its three curate acts — design Panels
 * 4–9, card MOTIR-1411.
 *
 * ⚠️ THIS ISLAND OWNS DRAFTS, NEVER THE STORED LESSON. The switch, the pills and
 * the text are the server-rendered `lesson` prop; each action calls
 * `revalidatePath`, so they re-read after a write (`CLAUDE.md`'s page-state
 * contract, its simplest branch). The switch moves only after the write
 * succeeds, because it renders `lesson.enabled`, never a local copy.
 *
 * ⚠️ AND A MISSING CONTROL IS PRESENTATION. A `support` reader gets pills and a
 * one-line note; the action and the service both re-gate every write.
 */

type Confirm =
  | { kind: 'enabled'; enabled: boolean }
  | { kind: 'edit' }
  | { kind: 'promote'; to: 'global' | 'planning_craft' };

type Draft = { title: string; why: string; howToApply: string; categories: string };

function toDraft(lesson: PlatformLessonDetailDTO): Draft {
  return {
    title: lesson.title,
    why: lesson.why,
    howToApply: lesson.howToApply,
    categories: lesson.categories.join(', '),
  };
}

function splitCategories(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  ];
}

/** The fields the draft moves, in the shape the action takes. */
function changedFields(lesson: PlatformLessonDetailDTO, draft: Draft): PlatformLessonEditInput {
  const out: PlatformLessonEditInput = {};
  if (draft.title.trim() !== lesson.title) out.title = draft.title.trim();
  if (draft.why.trim() !== lesson.why) out.why = draft.why.trim();
  if (draft.howToApply.trim() !== lesson.howToApply) out.howToApply = draft.howToApply.trim();
  const cats = splitCategories(draft.categories);
  if (cats.join('\u0000') !== lesson.categories.join('\u0000')) out.categories = cats;
  return out;
}

export function LessonCurate({ lesson }: { lesson: PlatformLessonDetailDTO }) {
  const t = useTranslations('platformAdmin.lessons');
  const typeLabel = useLessonTypeLabel();
  const router = useRouter();
  const { toast } = useToast();
  const reasonId = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [reason, setReason] = useState('');
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const ownerName = lesson.owner?.organizationName ?? t('owner.unknownOrg');
  const ownerPhrase = lesson.owner ? t('ownerOne', { owner: ownerName }) : t('ownerAll');
  const edits = draft ? changedFields(lesson, draft) : {};
  const blank =
    draft !== null &&
    (draft.title.trim() === '' || draft.why.trim() === '' || draft.howToApply.trim() === '');
  const dirty = Object.keys(edits).length > 0;

  function closeConfirm() {
    setConfirm(null);
    setReason('');
  }

  function report(result: LessonActionResult, done: Confirm) {
    closeConfirm();
    if (result.ok) {
      if (done.kind === 'edit') setDraft(null);
      const title =
        done.kind === 'enabled'
          ? t(done.enabled ? 'saved.on' : 'saved.off')
          : done.kind === 'edit'
            ? t('saved.edit')
            : t('saved.promote');
      const stops = done.kind === 'enabled' && !done.enabled;
      toast({ variant: 'success', title, description: t(stops ? 'saved.stops' : 'saved.reads') });
      return;
    }
    switch (result.code) {
      case 'UNCHANGED':
        if (done.kind === 'edit') setDraft(null);
        toast({ variant: 'warning', title: t('noop') });
        return;
      case 'GONE':
        toast({ variant: 'error', title: t('refused.gone') });
        router.push('/admin/planning-lessons');
        return;
      case 'UNAVAILABLE':
        // The form keeps the edit (Panel 9): the draft is untouched.
        toast({ variant: 'error', title: t('refused.unavailable') });
        return;
      case 'NOT_PERMITTED':
        toast({ variant: 'error', title: t('refused.notPermitted') });
        return;
      case 'REASON_REQUIRED':
        toast({ variant: 'error', title: t('refused.reasonRequired') });
        return;
      case 'INVALID':
        toast({ variant: 'error', title: t('refused.invalid') });
        return;
      case 'FAILED':
        toast({ variant: 'error', title: t('refused.failed') });
        return;
    }
  }

  function submit() {
    const trimmed = reason.trim();
    if (!trimmed || !confirm) return;
    const current = confirm;
    startTransition(async () => {
      const result =
        current.kind === 'enabled'
          ? await setLessonEnabledAction(lesson.id, current.enabled, trimmed)
          : current.kind === 'edit'
            ? await editLessonAction(lesson.id, edits, trimmed)
            : await promoteLessonAction(lesson.id, current.to, trimmed);
      report(result, current);
    });
  }

  const confirmCopy = (() => {
    if (!confirm) return { title: '', body: '', primary: '' };
    if (confirm.kind === 'enabled') {
      return confirm.enabled
        ? {
            title: t('on.title'),
            body: t('on.body', { owner: ownerPhrase, days: lesson.retentionDays }),
            primary: t('on.confirm'),
          }
        : {
            title: t('off.title'),
            body: t('off.body', { owner: ownerPhrase }),
            primary: t('off.confirm'),
          };
    }
    if (confirm.kind === 'edit') {
      return {
        title: t('edit.confirmTitle'),
        body: t('edit.confirmBody'),
        primary: t('edit.save'),
      };
    }
    const type = typeLabel(lesson.mistakeType);
    if (confirm.to === 'global') {
      return {
        title: t('promote.globalTitle'),
        body: t('promote.globalBody', { owner: ownerName }),
        primary: t('promote.confirm'),
      };
    }
    return {
      title: t('promote.craftTitle'),
      body: lesson.owner
        ? t('promote.craftBody', { owner: ownerName, type })
        : t('promote.craftBodyGlobal', { type }),
      primary: t('promote.confirm'),
    };
  })();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="font-serif text-2xl text-(--el-text)">{lesson.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <LessonTypePill mistakeType={lesson.mistakeType} />
            {lesson.owner ? (
              <span className="font-sans text-sm text-(--el-text)">{ownerName}</span>
            ) : (
              <GlobalPill />
            )}
            <LessonInjectionCell state={lesson.injection} retentionDays={lesson.retentionDays} />
          </div>
          {lesson.canEdit ? null : (
            <p
              data-testid="lesson-read-only"
              className="font-sans text-xs text-(--el-text-secondary)"
            >
              {t('detail.readOnly')}
            </p>
          )}
        </div>
        {lesson.canEdit ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="lesson-controls">
            <span className="flex items-center gap-2 font-sans text-sm text-(--el-text)">
              <Switch
                checked={lesson.enabled}
                aria-label={t('detail.switchLabel')}
                disabled={isPending}
                onCheckedChange={(next) => setConfirm({ kind: 'enabled', enabled: next })}
              />
              {t('inj.on')}
            </span>
            {draft ? null : (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Pencil className="h-3.5 w-3.5" />}
                onClick={() => setDraft(toDraft(lesson))}
              >
                {t('edit.open')}
              </Button>
            )}
            {lesson.promoteTargets.length > 0 ? (
              <Popover open={promoteOpen} onOpenChange={setPromoteOpen}>
                <Popover.Trigger asChild>
                  <Button
                    size="sm"
                    variant="secondary"
                    rightIcon={<ChevronDown className="h-3.5 w-3.5" />}
                  >
                    {t('promote.open')}
                  </Button>
                </Popover.Trigger>
                <Popover.Content align="end" width={300} className="py-1">
                  <ul role="menu" aria-label={t('promote.open')}>
                    {lesson.promoteTargets.map((to) => (
                      <li key={to} role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="flex w-full items-start gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left font-sans hover:bg-(--el-option-active-bg)"
                          onClick={() => {
                            setPromoteOpen(false);
                            setConfirm({ kind: 'promote', to });
                          }}
                        >
                          <Globe
                            aria-hidden
                            className="mt-0.5 h-4 w-4 shrink-0 text-(--el-accent-on-surface)"
                          />
                          <span className="flex flex-col gap-0.5">
                            <span className="text-sm text-(--el-text)">
                              {t(to === 'global' ? 'promote.toGlobal' : 'promote.toCraft')}
                            </span>
                            <span className="text-xs text-(--el-text-secondary)">
                              {to === 'global'
                                ? t('promote.globalHint', { type: typeLabel(lesson.mistakeType) })
                                : t('promote.craftHint')}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Popover.Content>
              </Popover>
            ) : null}
          </div>
        ) : null}
      </header>

      {draft ? (
        <Card data-testid="lesson-edit-form">
          <div className="flex flex-col gap-4">
            <Input
              label={t('edit.title')}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              error={draft.title.trim() === '' ? t('edit.blank') : undefined}
            />
            <Textarea
              label={t('edit.why')}
              value={draft.why}
              rows={3}
              onChange={(e) => setDraft({ ...draft, why: e.target.value })}
              error={draft.why.trim() === '' ? t('edit.blank') : undefined}
            />
            <Textarea
              label={t('edit.how')}
              value={draft.howToApply}
              rows={3}
              onChange={(e) => setDraft({ ...draft, howToApply: e.target.value })}
              error={draft.howToApply.trim() === '' ? t('edit.blank') : undefined}
            />
            <Input
              label={t('edit.categories')}
              helperText={t('edit.categoriesHint')}
              value={draft.categories}
              onChange={(e) => setDraft({ ...draft, categories: e.target.value })}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={isPending}>
                {t('edit.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={!dirty || blank || isPending}
                onClick={() => setConfirm({ kind: 'edit' })}
              >
                {t('edit.review')}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Card data-testid="lesson-text">
          <div className="flex flex-col gap-4 font-sans text-sm">
            <Section title={t('detail.why')}>{lesson.why}</Section>
            <Section title={t('detail.how')}>{lesson.howToApply}</Section>
            <Section title={t('detail.what')}>{lesson.body}</Section>
            <Section title={t('detail.categories')}>
              {lesson.categories.length === 0 ? (
                t('detail.noCategories')
              ) : (
                <span className="flex flex-wrap gap-1">
                  {lesson.categories.map((c) => (
                    <code
                      key={c}
                      className="rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) font-mono text-xs text-(--el-text-identifier)"
                    >
                      {c}
                    </code>
                  ))}
                </span>
              )}
            </Section>
          </div>
        </Card>
      )}

      <Modal
        open={confirm !== null}
        onOpenChange={(next) => (next ? undefined : closeConfirm())}
        role="alertdialog"
        title={confirmCopy.title}
        description={confirmCopy.body}
        size="md"
      >
        <Modal.Body className="gap-4">
          {confirm?.kind === 'edit' && draft ? <EditDiff lesson={lesson} edits={edits} /> : null}
          {confirm?.kind === 'promote' && lesson.owner ? (
            <p
              data-testid="lesson-promote-warning"
              className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)"
            >
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
              <span>{t('promote.warning', { org: ownerName })}</span>
            </p>
          ) : null}
          <Input
            id={reasonId}
            label={t('reasonLabel')}
            placeholder={t('reasonPlaceholder')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            autoFocus
            maxLength={280}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={closeConfirm} disabled={isPending}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={isPending}
            // A courtesy: the audit vocabulary's reason policy is the rule,
            // asserted in the service.
            disabled={reason.trim().length === 0}
          >
            {confirmCopy.primary}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
        {title}
      </h2>
      <div className="whitespace-pre-wrap text-(--el-text)">{children}</div>
    </section>
  );
}

/** Panel 6b — ONLY the fields that changed, old struck through above new. */
function EditDiff({
  lesson,
  edits,
}: {
  lesson: PlatformLessonDetailDTO;
  edits: PlatformLessonEditInput;
}) {
  const t = useTranslations('platformAdmin.lessons.field');
  const rows: { label: string; before: string; after: string }[] = [];
  if (edits.title !== undefined)
    rows.push({ label: t('title'), before: lesson.title, after: edits.title });
  if (edits.why !== undefined) rows.push({ label: t('why'), before: lesson.why, after: edits.why });
  if (edits.howToApply !== undefined) {
    rows.push({ label: t('howToApply'), before: lesson.howToApply, after: edits.howToApply });
  }
  if (edits.categories !== undefined) {
    rows.push({
      label: t('categories'),
      before: lesson.categories.join(', '),
      after: edits.categories.join(', '),
    });
  }
  return (
    <dl data-testid="lesson-edit-diff" className="flex flex-col gap-3 font-sans text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-(--el-text-secondary)">{row.label}</dt>
          <dd className="text-(--el-text-secondary) line-through">{row.before || '—'}</dd>
          <dd className="text-(--el-text)">{row.after || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
