'use client';

import { useTranslations } from 'next-intl';
import { Languages, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { useFieldTranslation, useTranslationContext } from './TranslationProvider';

// THE PER-FIELD MARK (Story MOTIR-7735 · Subtask MOTIR-8122; design MOTIR-8112
// § *Element table*, § *Where each field's mark sits*, D4). The explanation's
// AI-drafted `Pill tone="neutral"`'s twin, in the field's existing header slot,
// so "who wrote this" marks read as one family. Renders NOTHING for a field that
// takes no part — already in the reader's language, outside the host's scope,
// or with no provider mounted (the public page).
//
// Each mark has a TEXT NAME: a visually hidden "{Field}: " prefix before its
// visible text; the glyphs are `aria-hidden`. A field Retry is named "Retry
// translating the {field}".

export type TranslatableFieldName =
  | 'title'
  | 'description'
  | 'explanation'
  | 'todo'
  | 'instructions';

const FIELD_LABEL = {
  title: 'fieldTitle',
  description: 'fieldDescription',
  explanation: 'fieldExplanation',
  todo: 'fieldTodo',
  instructions: 'fieldInstructions',
} as const;

const RETRY_LABEL = {
  title: 'retryTitle',
  description: 'retryDescription',
  explanation: 'retryExplanation',
  todo: 'retryTodo',
  instructions: 'retryInstructions',
} as const;

function FailedMark({ fieldRef, field }: { fieldRef: string; field: TranslatableFieldName }) {
  const t = useTranslations('itemTranslation');
  const ctx = useTranslationContext()!;
  return (
    <span
      data-translation-mark="failed"
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      <span className="inline-flex items-center gap-1 font-sans text-[12px] text-(--el-text)">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
        <span className="sr-only">{t('markPrefix', { field: t(FIELD_LABEL[field]) })}</span>
        {t('markFailed')}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t(RETRY_LABEL[field])}
        leftIcon={<RotateCw className="h-3.5 w-3.5" aria-hidden />}
        onClick={() => ctx.retryField(fieldRef)}
      >
        {t('retry')}
      </Button>
    </span>
  );
}

export function FieldTranslationMark({
  fieldRef,
  field,
}: {
  fieldRef: string;
  field: TranslatableFieldName;
}) {
  const t = useTranslations('itemTranslation');
  const ctx = useTranslationContext();
  const { mark } = useFieldTranslation(fieldRef);
  if (!ctx || !mark) return null;
  if (mark === 'failed') return <FailedMark fieldRef={fieldRef} field={field} />;
  const prefix = (
    <span className="sr-only">{t('markPrefix', { field: t(FIELD_LABEL[field]) })}</span>
  );
  if (mark === 'translating') {
    return (
      <Pill tone="neutral" data-translation-mark="loading">
        <Spinner size="sm" aria-hidden className="h-3 w-3 border-[1.5px]" />
        {prefix}
        {t('markTranslating')}
      </Pill>
    );
  }
  const source = ctx.sourceName(fieldRef);
  return (
    <Pill tone="neutral" data-translation-mark="translated">
      <Languages className="h-3 w-3" aria-hidden />
      {prefix}
      {source ? t('markTranslatedFrom', { language: source }) : t('markTranslated')}
    </Pill>
  );
}
