'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Check, Eye, Info, PencilLine } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { useToast } from '@/components/ui/Toast';
import { updateProjectOverviewAction } from '../../actions';

// EditOverview (Story 6.12 · Subtask 6.12.8, design/public-projects Panel 7) —
// the dedicated public Overview/README authoring view: a split MarkdownEditor
// (left) + a LIVE MarkdownView preview (right) rendered with the SAME render
// stack the public Overview tab (6.12.4) uses, so what the admin sees is what
// ships. Save persists `project.publicOverviewMd` via `updateProjectOverviewAction`
// and treats the success response as the confirmation — NO whole-tree refresh
// (the inline-edit no-tree-refresh rule). Project-admin gated: a non-admin sees
// the same surface read-only (no Save / Cancel, the editor is read-only).
const BACK_HREF = '/settings/project/members';

export interface EditOverviewProps {
  initialValue: string;
  canManage: boolean;
  /** Whether the project is currently public (drives the "hidden while not public" note). */
  isPublic: boolean;
}

export function EditOverview({ initialValue, canManage, isPublic }: EditOverviewProps) {
  const t = useTranslations('settings');
  const router = useRouter();
  const { toast } = useToast();

  const [value, setValue] = useState(initialValue);
  const [savedValue, setSavedValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);

  const dirty = value !== savedValue;

  async function save() {
    if (!canManage || !dirty || saving) return;
    setSaving(true);
    try {
      const result = await updateProjectOverviewAction({ publicOverviewMd: value });
      if (result.ok) {
        // Success IS the confirmation — keep the optimistic value, mark it the
        // new committed baseline, and DON'T refresh (the no-tree-refresh rule).
        setSavedValue(value);
        toast({ variant: 'success', title: t('overview.savedToast') });
      } else {
        toast({
          variant: 'error',
          title: t('overview.saveErrorTitle'),
          description:
            result.code === 'TOO_LONG'
              ? t('overview.errorTooLong')
              : result.code === 'NOT_ADMIN'
                ? t('overview.errorNotAdmin')
                : t('overview.errorGeneric'),
        });
      }
    } catch {
      toast({
        variant: 'error',
        title: t('overview.saveErrorTitle'),
        description: t('overview.errorGeneric'),
      });
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    if (dirty) setValue(savedValue);
    else router.push(BACK_HREF);
  }

  return (
    <div className="mx-auto flex max-w-[64rem] flex-col gap-4">
      <Card
        header={
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <Link
                href={BACK_HREF}
                aria-label={t('overview.back')}
                className="focus-visible:ring-(--focus-ring-color) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) inline-flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) focus-visible:outline-none focus-visible:ring-2"
              >
                <ArrowLeft className="size-4" aria-hidden />
              </Link>
              <div>
                <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
                  {t('overview.title')}
                </h1>
                <p className="text-(--el-text-muted) font-sans text-xs">{t('overview.subtitle')}</p>
              </div>
            </div>
            {canManage ? (
              <div className="flex items-center gap-2">
                {!dirty ? (
                  <span className="text-(--el-success) inline-flex items-center gap-1 font-sans text-xs font-medium">
                    <Check className="size-4" aria-hidden />
                    {t('overview.saved')}
                  </span>
                ) : null}
                <Button variant="ghost" size="md" onClick={cancel} disabled={saving}>
                  {t('overview.cancel')}
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={save}
                  loading={saving}
                  disabled={!dirty}
                >
                  {t('overview.save')}
                </Button>
              </div>
            ) : null}
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Source — the MarkdownEditor (read-only for non-admins) */}
          <div className="flex flex-col gap-2">
            <span className="text-(--el-text-muted) inline-flex items-center gap-1.5 font-sans text-xs font-medium uppercase tracking-wide">
              <PencilLine className="size-3.5" aria-hidden />
              {t('overview.sourceLabel')}
            </span>
            <MarkdownEditor
              value={value}
              onChange={setValue}
              label={t('overview.editorLabel')}
              size="full"
              readOnly={!canManage}
            />
          </div>

          {/* Live preview — the SAME MarkdownView the public Overview tab uses */}
          <div className="flex flex-col gap-2">
            <span className="text-(--el-text-muted) inline-flex items-center gap-1.5 font-sans text-xs font-medium uppercase tracking-wide">
              <Eye className="size-3.5" aria-hidden />
              {t('overview.previewLabel')}
            </span>
            <div className="border-(--el-border) bg-(--el-page-bg) relative min-h-[18rem] rounded-(--radius-card) border p-(--spacing-card-padding)">
              <span className="border-(--el-border) bg-(--el-surface) text-(--el-text-muted) absolute right-3 top-3 inline-flex items-center gap-1 rounded-(--radius-badge) border px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-[0.65rem] font-medium uppercase tracking-wide">
                {t('overview.livePreview')}
              </span>
              {value.trim() ? (
                <MarkdownView value={value} aria-label={t('overview.previewLabel')} />
              ) : (
                <p className="text-(--el-text-muted) font-sans text-sm">
                  {t('overview.previewEmpty')}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding)">
          <Info className="mt-0.5 size-4 shrink-0 text-(--el-text-strong)" aria-hidden />
          <p className="font-sans text-xs text-(--el-text-strong)">
            {isPublic ? t('overview.notePublic') : t('overview.noteNotPublic')}
          </p>
        </div>
      </Card>
    </div>
  );
}
