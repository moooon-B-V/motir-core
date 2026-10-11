'use client';

import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { localeLabel, type Locale } from '@/lib/i18n/locales';

// The content-language confirm (Story MOTIR-7731 · MOTIR-8095 ·
// `design/org-admin/org-admin--content-language.mock.html` panel 5). Saving a
// changed Content language opens this FIRST and nothing is sent until Confirm:
// the change is easy to misread as "convert my work", so the dialog says that
// existing work keeps its text and language and only new writing changes.
// Initial focus is Cancel (the `MembersOnlyConfirmDialog` precedent); while the
// request runs, Cancel / × / Escape are inert and Confirm shows `loading`.
// Language names are `localeLabel` endonyms, each with its own `lang`.

export interface ContentLanguageConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgName: string;
  from: Locale;
  to: Locale;
  onConfirm: () => void;
  pending?: boolean;
}

export function ContentLanguageConfirmDialog({
  open,
  onOpenChange,
  orgName,
  from,
  to,
  onConfirm,
  pending = false,
}: ContentLanguageConfirmDialogProps) {
  const t = useTranslations('orgAdmin.settings');
  const tc = useTranslations('common');
  const fromName = localeLabel[from];
  const toName = localeLabel[to];

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      size="md"
      title={t('contentLanguageConfirmTitle')}
      closeLabel={tc('close')}
    >
      <Modal.Body className="gap-3">
        <div className="flex flex-wrap items-center gap-2 font-sans text-sm text-(--el-text)">
          <span
            lang={from}
            className="rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-(--spacing-chip-y) font-medium text-(--el-text)"
          >
            {fromName}
          </span>
          <span aria-hidden className="text-(--el-text-secondary)">
            →
          </span>
          <span
            lang={to}
            className="rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) font-medium text-(--el-text-strong)"
          >
            {toName}
          </span>
        </div>
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t.rich('contentLanguageConfirmBody', {
            org: orgName,
            to: toName,
            from: fromName,
            b: (chunks) => (
              <strong lang={String(chunks) === toName ? to : from} className="text-(--el-text)">
                {chunks}
              </strong>
            ),
          })}
        </p>
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t('contentLanguageConfirmKeeps')}
        </p>
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('contentLanguageConfirmRecorded')}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button
          autoFocus
          variant="secondary"
          onClick={() => onOpenChange(false)}
          disabled={pending}
        >
          {tc('cancel')}
        </Button>
        <Button variant="primary" onClick={onConfirm} loading={pending}>
          {t('contentLanguageConfirmCta', { to: toName })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
