'use client';

import { useTranslations } from 'next-intl';
import { CheckCheck, EyeOff, Lock, Megaphone, ShieldCheck } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

// BuildInPublicDialog (Story 6.17 · Subtask 6.17.2) — the "Start building in
// public?" explainer / confirm Modal, built against design/public-projects
// Panel 11. It is the REUSABLE confirm piece: opened from the make-public
// control here (6.17.2) AND, later, from the discoverable entry points (6.17.3
// — the project-shell header button, the dismissible nudge, and the Settings →
// General promo card). Keep it presentational + controlled so every entry point
// reuses the same copy and footer:
//   • it does NOT flip access on open — the mutation fires only when the footer
//     "Start building in public" button is pressed (→ `onConfirm`);
//   • the owner holds the pending/optimistic state and closes the dialog on
//     success, so this component never calls `setAccessLevel` itself.
// All copy lives under `settings.buildInPublic.*` (the centralized namespace).

export interface BuildInPublicDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Fired when the user confirms. The owner runs the `setAccessLevel('public')`
  // write (the shipped 6.4 path) and closes the dialog on success.
  onConfirm: () => void;
  // The owner's in-flight flag for the access write — disables both buttons and
  // shows the spinner on confirm.
  pending?: boolean;
}

// The "What becomes public" rows carry distinct semantic glyphs (design Panel
// 11): a success check for what's shared, an info lock for the sign-in-to-act
// gate, and a faint eye-off for what stays stripped.
const VIS_ROWS = [
  { key: 'bulletBoard', Icon: CheckCheck, tone: 'text-(--el-success)' },
  { key: 'bulletItems', Icon: CheckCheck, tone: 'text-(--el-success)' },
  { key: 'bulletSignIn', Icon: Lock, tone: 'text-(--el-info)' },
  { key: 'bulletPrivate', Icon: EyeOff, tone: 'text-(--el-text-faint)' },
] as const;

export function BuildInPublicDialog({
  open,
  onOpenChange,
  onConfirm,
  pending = false,
}: BuildInPublicDialogProps) {
  const t = useTranslations('settings.buildInPublic');
  const tc = useTranslations('common');

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="md">
      {/* Head — accent megaphone glyph tile + serif title (design Panel 11).
          Custom heading inside the body (not Modal's `title` prop) so the glyph
          tile sits beside it — the same convention as ArchiveProjectModal /
          ChangeKeyModal. */}
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-build-bg) text-(--el-build-glyph)"
          aria-hidden
        >
          <Megaphone className="size-5" />
        </span>
        <h2 className="font-serif text-xl font-semibold text-(--el-text)">{t('confirmTitle')}</h2>
      </div>

      <Modal.Body className="gap-4">
        <p className="text-(--el-text-secondary) font-sans text-sm">{t('confirmLead')}</p>

        <div>
          <p className="text-(--el-text-muted) mb-2 font-sans text-xs font-medium uppercase tracking-wide">
            {t('whatBecomesLabel')}
          </p>
          <ul role="list" className="flex flex-col gap-2">
            {VIS_ROWS.map(({ key, Icon, tone }) => (
              <li key={key} className="flex items-start gap-2">
                <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} aria-hidden />
                <span className="text-(--el-text) font-sans text-sm">
                  {t.rich(key, { b: (chunks) => <strong>{chunks}</strong> })}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-mint) p-(--spacing-card-padding)">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-(--el-text-strong)" aria-hidden />
          <p className="font-sans text-xs text-(--el-text-strong)">{t('reassurance')}</p>
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
          {tc('cancel')}
        </Button>
        <Button variant="primary" onClick={onConfirm} loading={pending}>
          <Megaphone className="size-4" aria-hidden />
          {t('confirmCta')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
