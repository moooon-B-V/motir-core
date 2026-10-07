'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { MultiSelectPicker, type MultiSelectOption } from '@/components/ui/MultiSelectPicker';
import { Segmented } from '@/components/ui/Segmented';
import { Textarea } from '@/components/ui/Textarea';
import type { IdeaCategory, IdeaKind } from '@/generated/prisma/client';
import type { StaffIdeaDto, StaffIdeaTagDto } from '@/lib/dto/ideas';
import { IDEA_CATEGORIES, IDEA_CATEGORY_LABELS, IDEA_KINDS } from '@/lib/ideas/categories';
import { IDEA_LIMITS } from '@/lib/ideas/limits';
import { updateIdeaAction, type IdeaRefusalCode } from '../../actions';
import {
  draftKey,
  fieldMessage,
  moveRow,
  toDraft,
  toPatch,
  withKind,
  type EvidenceDraft,
  type IdeaDraft,
} from './ideaDraft';

/**
 * The EDIT FORM — design `platform-admin` § Ideas, Panels 6–7, card MOTIR-7681.
 * **Edit** turns the detail into this form in place.
 *
 * ⚠️ THE FORM OWNS ONLY ITS DRAFT. A refused save keeps what was typed and marks
 * each refused field in place (`aria-invalid`, its message linked by
 * `aria-describedby`, focus on the first); a summary callout says how many. A
 * saved one hands the DTO the action returned to `onSaved`, so the detail shows
 * the stored idea at once without waiting on a re-read.
 *
 * There is no reason field: the audit row's reason is the service's own
 * _Edited in the operator console_.
 */

export interface IdeaEditFormProps {
  idea: StaffIdeaDto;
  tags: StaffIdeaTagDto[];
  onCancel: () => void;
  /** `added` is the positions of evidence rows this save added, marked _New_. */
  onSaved: (idea: StaffIdeaDto, added: ReadonlySet<number>) => void;
  /** A refusal that is not about a field (`not_permitted`, `not_found`, `failed`). */
  onRefused: (code: IdeaRefusalCode) => void;
}

type Errors = Record<string, string>;

export function IdeaEditForm({ idea, tags, onCancel, onSaved, onRefused }: IdeaEditFormProps) {
  const t = useTranslations('platformAdmin.ideas');
  const [draft, setDraft] = useState<IdeaDraft>(() => toDraft(idea));
  const [errors, setErrors] = useState<Errors>({});
  const [unchanged, setUnchanged] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const storedEvidence = useRef(new Set(idea.evidence.map((e) => e.url + '\u0000' + e.claim)));

  // Focus the first refused field once the errors render (design § A11y).
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  const set = <K extends keyof IdeaDraft>(key: K, value: IdeaDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const err = (field: string) => errors[field];

  function submit() {
    const patch = toPatch(idea, draft);
    if (Object.keys(patch).length === 0) {
      setUnchanged(true);
      return;
    }
    setUnchanged(false);
    const sent = draft;
    startTransition(async () => {
      const result = await updateIdeaAction(idea.slug, patch);
      if (result.ok) {
        setErrors({});
        const added = new Set<number>();
        sent.evidence.forEach((e, i) => {
          if (!storedEvidence.current.has(e.url.trim() + '\u0000' + e.claim.trim())) added.add(i);
        });
        onSaved(result.idea, added);
        return;
      }
      if (result.code === 'invalid') {
        const next: Errors = {};
        for (const issue of result.issues) {
          const message = fieldMessage(issue, sent);
          next[issue.field] = t(`fieldError.${message.key}`, message.values);
        }
        setErrors(next);
        return;
      }
      onRefused(result.code);
    });
  }

  const kindOptions = IDEA_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) }));
  const categoryOptions: ComboboxOption<IdeaCategory>[] = IDEA_CATEGORIES.map((c) => ({
    value: c,
    label: IDEA_CATEGORY_LABELS[c],
  }));
  const tagOption = (slug: string): MultiSelectOption => {
    const tag = tags.find((x) => x.slug === slug);
    return { id: slug, label: tag?.label ?? slug };
  };
  const query = tagQuery.trim().toLowerCase();
  const tagOptions: MultiSelectOption[] = tags
    .filter((tag) => !query || tag.label.toLowerCase().includes(query) || tag.slug.includes(query))
    .map((tag) => ({
      id: tag.slug,
      label: t('edit.tags.option', { label: tag.label, count: tag.count }),
    }));
  const toggleTag = (slug: string) =>
    set(
      'tags',
      draft.tags.includes(slug) ? draft.tags.filter((s) => s !== slug) : [...draft.tags, slug],
    );

  const errorCount = Object.keys(errors).length;

  return (
    <Card
      data-testid="idea-edit-form"
      header={
        <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('edit.title')}</h2>
      }
    >
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-5 font-sans text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {errorCount > 0 ? (
          <p
            role="alert"
            data-testid="idea-edit-refused"
            className="rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding) text-(--el-text-strong)"
          >
            {t('edit.refused', { n: errorCount })}
          </p>
        ) : null}

        <Input
          label={t('edit.field.title')}
          value={draft.title}
          maxLength={IDEA_LIMITS.title}
          helperText={t('edit.limit', { n: draft.title.length, max: IDEA_LIMITS.title })}
          onChange={(e) => set('title', e.target.value)}
          error={err('title')}
        />
        <Textarea
          label={t('edit.field.pitch')}
          value={draft.pitch}
          rows={3}
          maxLength={IDEA_LIMITS.pitch}
          helperText={t('edit.limit', { n: draft.pitch.length, max: IDEA_LIMITS.pitch })}
          onChange={(e) => set('pitch', e.target.value)}
          error={err('pitch')}
        />
        <div className="flex flex-wrap gap-4">
          <Labelled label={t('edit.field.kind')}>
            <Segmented<IdeaKind>
              label={t('edit.field.kind')}
              value={draft.kind}
              options={kindOptions}
              onChange={(kind) => setDraft((d) => withKind(d, kind))}
            />
          </Labelled>
          <Labelled label={t('edit.field.category')} className="w-56">
            <Combobox<IdeaCategory>
              label={t('edit.field.category')}
              options={categoryOptions}
              value={draft.category}
              onChange={(category) => set('category', category)}
              searchable
            />
          </Labelled>
        </div>
        <MultiSelectPicker
          label={t('edit.field.tags')}
          placeholder={t('edit.tags.placeholder')}
          values={draft.tags.map(tagOption)}
          options={tagOptions}
          onToggle={(option) => toggleTag(option.id)}
          onRemove={(option) => toggleTag(option.id)}
          query={tagQuery}
          onQueryChange={setTagQuery}
          cap={IDEA_LIMITS.tags}
          removeLabel={(label) => t('edit.tags.remove', { label })}
          emptyText={t('edit.tags.empty')}
          hint={t('edit.tags.hint')}
          error={err('tags') ?? null}
        />

        <ListSection
          title={t('edit.field.capabilities')}
          count={t('edit.limit', { n: draft.capabilities.length, max: IDEA_LIMITS.capabilities })}
          error={err('capabilities')}
        >
          <ol className="flex flex-col gap-2">
            {draft.capabilities.map((line, i) => (
              <li key={line.key} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Input
                    label={t('edit.line', { n: i + 1 })}
                    value={line.text}
                    maxLength={IDEA_LIMITS.capability}
                    onChange={(e) =>
                      set(
                        'capabilities',
                        draft.capabilities.map((c) =>
                          c.key === line.key ? { ...c, text: e.target.value } : c,
                        ),
                      )
                    }
                    error={err(`capabilities[${i}]`)}
                  />
                </div>
                <RowTool
                  label={t('edit.removeLine', { n: i + 1 })}
                  onClick={() =>
                    set(
                      'capabilities',
                      draft.capabilities.filter((c) => c.key !== line.key),
                    )
                  }
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                </RowTool>
              </li>
            ))}
          </ol>
          {draft.capabilities.length < IDEA_LIMITS.capabilities ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              leftIcon={<Plus className="h-3.5 w-3.5" />}
              onClick={() =>
                set('capabilities', [...draft.capabilities, { key: draftKey(), text: '' }])
              }
            >
              {t('edit.addLine')}
            </Button>
          ) : null}
        </ListSection>

        <ListSection
          title={t('edit.field.evidence')}
          count={t('edit.limit', { n: draft.evidence.length, max: IDEA_LIMITS.evidence })}
          error={err('evidence')}
        >
          <ol className="flex flex-col gap-3" data-testid="idea-edit-evidence">
            {draft.evidence.map((row, i) => (
              <EvidenceRow
                key={row.key}
                row={row}
                index={i}
                last={i === draft.evidence.length - 1}
                errorFor={(part) => err(`evidence[${i}].${part}`)}
                onChange={(next) =>
                  set(
                    'evidence',
                    draft.evidence.map((e) => (e.key === row.key ? next : e)),
                  )
                }
                onMove={(by) => set('evidence', moveRow(draft.evidence, i, by))}
                onRemove={() =>
                  set(
                    'evidence',
                    draft.evidence.filter((e) => e.key !== row.key),
                  )
                }
              />
            ))}
          </ol>
          {draft.evidence.length < IDEA_LIMITS.evidence ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              leftIcon={<Plus className="h-3.5 w-3.5" />}
              onClick={() =>
                set('evidence', [
                  ...draft.evidence,
                  { key: draftKey(), claim: '', sourceName: '', url: '', sourceDate: '' },
                ])
              }
            >
              {t('edit.evidence.add')}
            </Button>
          ) : null}
        </ListSection>

        <LongText
          label={t('edit.field.gap')}
          value={draft.gap}
          onChange={(v) => set('gap', v)}
          error={err('gap')}
        />
        <LongText
          label={t('edit.field.whyNow')}
          value={draft.whyNow}
          onChange={(v) => set('whyNow', v)}
          error={err('whyNow')}
        />
        {draft.kind === 'motir_buys' ? (
          <>
            <LongText
              label={t('edit.field.whyMotir')}
              value={draft.whyMotir}
              onChange={(v) => set('whyMotir', v)}
              error={err('whyMotir')}
            />
            <LongText
              label={t('edit.field.whoElse')}
              value={draft.whoElse}
              onChange={(v) => set('whoElse', v)}
              error={err('whoElse')}
            />
          </>
        ) : (
          <p data-testid="idea-edit-motir-only" className="text-xs text-(--el-text-secondary)">
            {t('edit.motirOnly')}
          </p>
        )}

        {unchanged ? (
          <p role="status" className="text-xs text-(--el-text-secondary)">
            {t('edit.unchanged')}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-(--el-border-soft) pt-4">
          <Checkbox
            label={t('edit.reviewed')}
            labelVisible
            checked={draft.reviewed}
            onChange={(next) => set('reviewed', next)}
          />
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              {t('edit.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              {t('edit.save')}
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

function Labelled({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span aria-hidden className="text-xs font-medium text-(--el-text-secondary)">
        {label}
      </span>
      {children}
    </div>
  );
}

function ListSection({
  title,
  count,
  error,
  children,
}: {
  title: string;
  count: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-2" aria-invalid={error ? true : undefined}>
      <legend className="flex w-full items-baseline justify-between gap-2 pb-1">
        <span className="text-xs font-medium text-(--el-text)">{title}</span>
        <span className="text-xs text-(--el-text-secondary)">{count}</span>
      </legend>
      {error ? (
        <p className="text-xs text-(--el-danger-on-surface)" data-testid="idea-edit-list-error">
          {error}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

function LongText({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
}) {
  return (
    <Textarea
      label={label}
      value={value}
      rows={2}
      maxLength={IDEA_LIMITS.longText}
      onChange={(e) => onChange(e.target.value)}
      error={error}
    />
  );
}

function RowTool({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className="inline-flex h-(--height-btn-sm) w-(--height-btn-sm) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-option-active-bg) hover:text-(--el-text) aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function EvidenceRow({
  row,
  index,
  last,
  errorFor,
  onChange,
  onMove,
  onRemove,
}: {
  row: EvidenceDraft;
  index: number;
  last: boolean;
  errorFor: (part: 'claim' | 'sourceName' | 'url' | 'sourceDate') => string | undefined;
  onChange: (row: EvidenceDraft) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('platformAdmin.ideas.edit.evidence');
  const n = index + 1;
  return (
    <li
      data-testid="idea-edit-evidence-row"
      aria-label={t('row', { n })}
      className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border-soft) p-(--spacing-card-padding)"
    >
      <div className="flex items-center justify-between gap-2">
        <span aria-hidden className="font-mono text-xs text-(--el-text-identifier)">
          {n}
        </span>
        <div className="flex gap-1">
          <RowTool label={t('up', { n })} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp aria-hidden className="h-3.5 w-3.5" />
          </RowTool>
          <RowTool label={t('down', { n })} disabled={last} onClick={() => onMove(1)}>
            <ArrowDown aria-hidden className="h-3.5 w-3.5" />
          </RowTool>
          <RowTool label={t('remove', { n })} onClick={onRemove}>
            <X aria-hidden className="h-3.5 w-3.5" />
          </RowTool>
        </div>
      </div>
      <Textarea
        label={t('claim')}
        value={row.claim}
        rows={2}
        maxLength={IDEA_LIMITS.claim}
        onChange={(e) => onChange({ ...row, claim: e.target.value })}
        error={errorFor('claim')}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_12rem]">
        <Input
          label={t('source')}
          value={row.sourceName}
          maxLength={IDEA_LIMITS.sourceName}
          onChange={(e) => onChange({ ...row, sourceName: e.target.value })}
          error={errorFor('sourceName')}
        />
        <Input
          label={t('sourceDate')}
          placeholder={t('datePlaceholder')}
          value={row.sourceDate}
          inputMode="numeric"
          onChange={(e) => onChange({ ...row, sourceDate: e.target.value })}
          error={errorFor('sourceDate')}
        />
      </div>
      <Input
        label={t('link')}
        type="url"
        value={row.url}
        maxLength={IDEA_LIMITS.url}
        onChange={(e) => onChange({ ...row, url: e.target.value })}
        error={errorFor('url')}
      />
    </li>
  );
}
