'use client';

import { useTranslations } from 'next-intl';
import { CheckCheck, EyeOff, TriangleAlert, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

// StopBuildInPublicDialog (Story 6.17 · Subtask 6.17.4) — the REVERSE
// "Stop building in public?" explainer / confirm Modal, built against
// design/public-projects Panel 12. The warn-toned mirror of BuildInPublicDialog
// (6.17.2): an eye-off glyph tile (yellow warn tile), a "what happens" list, a
// reassurance note (can restart anytime), and a Cancel / "Stop building in
// public" danger footer. Like its forward twin it is REUSABLE + controlled —
// opened from the settings manage row here, and ready for the project-shell
// header's stop affordance once 6.17.3's slot lands:
//   • it does NOT flip access on open — the mutation fires only when the footer
//     "Stop building in public" button is pressed (→ `onConfirm`);
//   • the owner holds the pending/optimistic state and closes the dialog on
//     success, so this component never calls `setAccessLevel` itself.
// All copy lives under `settings.buildInPublic.*` (the centralized namespace).

// The "what happens when you stop" rows carry distinct semantic glyphs (design
// Panel 12): a faint eye-off for the page going offline, a faint x for the link
// breaking, and a success check for what's KEPT (nothing is deleted).
const STOP_ROWS = [
  { key: 'stopBulletOffline', Icon: EyeOff, tone: 'text-(--el-text-faint)' },
  { key: 'stopBulletLink', Icon: X, tone: 'text-(--el-text-faint)' },
  { key: 'stopBulletKept', Icon: CheckCheck, tone: 'text-(--el-success)' },
] as const;

export interface StopBuildInPublicDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Fired when the user confirms. The owner reverts the access level (the
  // shipped 6.4 `setAccessLevel` path) and closes the dialog on success.
  onConfirm: () => void;
  // The owner's in-flight flag for the access write — disables both buttons and
  // shows the spinner on confirm.
  pending?: boolean;
}

export function StopBuildInPublicDialog({
  open,
  onOpenChange,
  onConfirm,
  pending = false,
}: StopBuildInPublicDialogProps) {
  const t = useTranslations('settings.buildInPublic');
  const tc = useTranslations('common');

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="md">
      {/* Head — warn-toned eye-off glyph tile + serif title (design Panel 12,
          `modal-glyph.warn`: yellow tile, `--el-warning` glyph). Custom heading
          inside the body (not Modal's `title` prop) so the glyph tile sits
          beside it — the same convention as BuildInPublicDialog. */}
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-yellow) text-(--el-warning)"
          aria-hidden
        >
          <EyeOff className="size-5" />
        </span>
        <h2 className="font-serif text-xl font-semibold text-(--el-text)">
          {t('stopConfirmTitle')}
        </h2>
      </div>

      <Modal.Body className="gap-4">
        <p className="text-(--el-text-secondary) font-sans text-sm">{t('stopConfirmLead')}</p>

        <ul role="list" className="flex flex-col gap-2">
          {STOP_ROWS.map(({ key, Icon, tone }) => (
            <li key={key} className="flex items-start gap-2">
              <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} aria-hidden />
              <span className="text-(--el-text) font-sans text-sm">
                {t.rich(key, { b: (chunks) => <strong>{chunks}</strong> })}
              </span>
            </li>
          ))}
        </ul>

        <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding)">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden />
          <p className="font-sans text-xs text-(--el-text-strong)">{t('stopReassurance')}</p>
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
          {tc('cancel')}
        </Button>
        <Button
          variant="danger"
          onClick={onConfirm}
          loading={pending}
          leftIcon={<EyeOff className="size-4" />}
        >
          {t('stopConfirmCta')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
