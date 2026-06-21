'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Mail, Clock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { ChangeEmailModal } from './ChangeEmailModal';
import { requestEmailChange, EmailChangeError } from '../profile/emailChangeClient';

// The Email row of the Account › Profile pane's Profile card (Story 8.8 ·
// Subtask 8.8.24b) — `design/settings/profile.mock.html` Panels 1 (resting) + 2
// (pending). Composed INTO ProfileCard in place of the scaffold's display-only
// email row. Two states, both client-owned (the page-state contract — this is a
// client island; the verified swap is out-of-band via the confirm link, so
// nothing server-rendered changes here and there's no `router.refresh()`):
//   * RESTING — the current address + a "Change email" ghost button that opens
//     ChangeEmailModal.
//   * PENDING — after a request is accepted: the current address struck through,
//     a peach "Pending → newaddr" Pill, the "Confirmation sent" helper, and
//     Resend / Cancel actions. This banner is intentionally ephemeral (held in
//     island state, not server-read): the backend exposes request + confirm
//     only, so the pending view lives until the page reloads or the user
//     confirms from the new inbox. "Cancel" dismisses the local banner (the
//     unconfirmed request harmlessly expires server-side, 1h).

export interface EmailFieldProps {
  email: string;
}

export function EmailField({ email }: EmailFieldProps) {
  const t = useTranslations('settings.profile');
  const { toast } = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [resending, startResend] = useTransition();

  function onPending(newEmail: string) {
    setPending(newEmail);
    toast({
      variant: 'success',
      title: t('email.toast.title'),
      description: t('email.toast.body', { email: newEmail }),
    });
  }

  function resend() {
    if (!pending) return;
    startResend(async () => {
      try {
        await requestEmailChange(pending);
        toast({
          variant: 'success',
          title: t('email.toast.title'),
          description: t('email.toast.body', { email: pending }),
        });
      } catch (err) {
        const code = err instanceof EmailChangeError ? err.code : 'UNKNOWN';
        toast({
          variant: 'error',
          title: t('email.toast.errorTitle'),
          description: t(
            `email.modal.errors.${code === 'EMAIL_TAKEN' ? 'taken' : code === 'EMAIL_CHANGE_RATE_LIMITED' ? 'rateLimited' : 'generic'}`,
          ),
        });
      }
    });
  }

  return (
    <div className="flex items-start justify-between gap-4 border-t border-(--el-border-soft) pt-4">
      <div className="min-w-0">
        <div className="font-sans text-sm font-medium text-(--el-text)">{t('email.label')}</div>
        <div className="mt-0.5 font-sans text-xs leading-snug text-(--el-text-muted)">
          {t('email.desc')}
        </div>
      </div>

      {pending ? (
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="font-sans text-sm text-(--el-text-muted) line-through">{email}</span>
          <Pill severity="warning">
            <Clock className="size-3.5" aria-hidden />
            {t('email.pending.badge', { email: pending })}
          </Pill>
          <div className="flex items-center gap-3.5 font-sans text-xs">
            <span className="text-(--el-text-muted)">{t('email.pending.helper')}</span>
            <button
              type="button"
              className="text-(--el-link) hover:underline disabled:opacity-60"
              onClick={resend}
              disabled={resending}
            >
              {t('email.pending.resend')}
            </button>
            <button
              type="button"
              className="text-(--el-link) hover:underline"
              onClick={() => setPending(null)}
            >
              {t('email.pending.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-sans text-sm text-(--el-text)">{email}</span>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Mail className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => setModalOpen(true)}
          >
            {t('email.change')}
          </Button>
        </div>
      )}

      <ChangeEmailModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        currentEmail={email}
        onPending={onPending}
      />
    </div>
  );
}
