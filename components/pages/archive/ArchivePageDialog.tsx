'use client';

import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Archive } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { PageArchiveSetDto } from '@/lib/dto/pages';

// THE ARCHIVE CONFIRM (Story MOTIR-5755 · MOTIR-7423) — design MOTIR-7416,
// surface 3. Shown only for a page WITH live sub-pages: a single page archives
// at once and its toast's Undo is the safety net, the work-item precedent.
//
// `Modal` sm as an `alertdialog`, focus on Cancel. The title names the page and
// how many sub-pages go with it; the body says what archiving does and does not
// do; the impact box states the total and names the sub-pages — up to five,
// shallowest first, then "and N more" — joined by the reader's locale. Page
// titles are the writer's own words and are never translated.
//
// The action is the PRIMARY button, not danger: archiving is reversible. While
// it runs the action shows the spinner and "Archiving…", and Cancel and × are
// disabled — the request is out, and closing would not stop it.

export interface ArchivePageDialogProps {
  /** The page's title as the surface shows it (Untitled already resolved). */
  title: string;
  /** What the archive takes: the live sub-pages, counted and the first named. */
  set: PageArchiveSetDto;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The sub-page names, then "and N more", as one list in the reader's locale. */
export function useSubPageNames(set: PageArchiveSetDto, untitled: string): string {
  const t = useTranslations('pages.archive.confirm');
  const locale = useLocale();
  const names = set.subPageTitles.map((title) => title || untitled);
  const rest = set.subPageCount - names.length;
  if (rest > 0) names.push(t('more', { count: rest }));
  return new Intl.ListFormat(locale, { type: 'conjunction', style: 'narrow' }).format(names);
}

const bold = (chunks: ReactNode) => (
  <strong className="font-semibold text-(--el-text)">{chunks}</strong>
);

export function ArchivePageDialog({
  title,
  set,
  pending,
  onConfirm,
  onCancel,
}: ArchivePageDialogProps) {
  const t = useTranslations('pages.archive');
  const tp = useTranslations('pages');
  const tc = useTranslations('common');
  const names = useSubPageNames(set, tp('untitled'));
  const total = set.subPageCount + 1;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      size="sm"
      role="alertdialog"
      title={t('confirm.title', { title, count: set.subPageCount })}
    >
      <Modal.Body className="gap-4" aria-busy={pending || undefined}>
        <p className="text-sm text-(--el-text-secondary)">{t('confirm.body')}</p>
        <ul className="flex flex-col gap-2 rounded-(--radius-card) bg-(--el-surface-soft) p-(--spacing-card-padding) text-sm text-(--el-text-secondary)">
          <li className="flex gap-2">
            <Archive className="mt-0.5 size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
            <span>{t.rich('confirm.impact', { total, title, names, b: bold })}</span>
          </li>
        </ul>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={pending} autoFocus>
          {tc('cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={pending}
          leftIcon={<Archive className="size-4" aria-hidden />}
          onClick={onConfirm}
        >
          {pending ? t('archiving') : t('confirm.action', { total })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
