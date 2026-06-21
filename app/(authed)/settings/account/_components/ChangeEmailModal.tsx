'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Mail } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import {
  requestEmailChange,
  EmailChangeError,
  type EmailChangeErrorCode,
} from '../profile/emailChangeClient';

// Change-email modal on the Account › Profile pane (Story 8.8 · Subtask 8.8.24b)
// — `design/settings/profile.mock.html` Panel 4. A single new-email form wired to
// the 8.8.22 verified-change endpoint (`POST /api/account/request-email-change`):
// the swap happens only when the user clicks the confirm link emailed to the NEW
// address, so a successful submit reports a CONFIRMATION-PENDING result up to the
// EmailField (which renders the pending banner + fires the success toast) — the
// page-state contract: this is a client island, no full-tree refresh (nothing
// server-rendered changes until the out-of-band confirm).
//
// Errors: client-side empty/format validation gates the POST; the route's typed
// codes (EMAIL_TAKEN / SAME_EMAIL / INVALID_EMAIL / rate-limit) map to the
// rose-tint inline error BOX under the field (Input errorVariant="box"), matching
// the design's `.err-box` — the email-taken case is the one the design draws.

// A pragmatic syntactic check so an obviously-malformed address never costs a
// round-trip; the server (and ultimately the confirm email landing) is the real
// validator (route → InvalidEmailError).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ERROR_KEY: Record<EmailChangeErrorCode, string> = {
  EMAIL_TAKEN: 'taken',
  SAME_EMAIL: 'same',
  INVALID_EMAIL: 'invalid',
  EMAIL_CHANGE_RATE_LIMITED: 'rateLimited',
  USER_NOT_FOUND: 'generic',
  UNAUTHENTICATED: 'generic',
  BAD_REQUEST: 'generic',
  UNKNOWN: 'generic',
};

export interface ChangeEmailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentEmail: string;
  /** Called with the trimmed new address once the request is accepted (200) —
   *  the EmailField shows the pending banner and fires the confirmation toast. */
  onPending: (newEmail: string) => void;
}

export function ChangeEmailModal({
  open,
  onOpenChange,
  currentEmail,
  onPending,
}: ChangeEmailModalProps) {
  const t = useTranslations('settings.profile.email');
  const inputId = useId();

  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    onOpenChange(false);
    // Reset so the next open starts clean (no lingering value/error).
    setValue('');
    setError(null);
    setSubmitting(false);
  }

  async function submit() {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError(t('modal.errors.empty'));
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
      setError(t('modal.errors.invalid'));
      return;
    }
    if (trimmed.toLowerCase() === currentEmail.trim().toLowerCase()) {
      setError(t('modal.errors.same'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await requestEmailChange(trimmed);
      onPending(trimmed);
      close();
    } catch (err) {
      const code = err instanceof EmailChangeError ? err.code : 'UNKNOWN';
      setError(t(`modal.errors.${ERROR_KEY[code]}`));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={t('modal.title')}
      description={t('modal.description')}
      size="sm"
    >
      <form
        className="flex flex-col gap-4"
        // Custom validation owns the field — `noValidate` stops the browser's
        // native `type="email"` bubble from pre-empting the submit so our own
        // inline error copy (the design's `.err-box`) always shows. The
        // `type="email"` hint is kept for the mobile keyboard.
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          id={inputId}
          type="email"
          label={t('modal.newLabel')}
          placeholder={t('modal.placeholder')}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          error={error ?? undefined}
          errorVariant="box"
          disabled={submitting}
          autoFocus
          autoComplete="email"
        />
        <Modal.Footer>
          <Button type="button" variant="secondary" onClick={close} disabled={submitting}>
            {t('modal.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            leftIcon={<Mail className="size-4" aria-hidden />}
            disabled={value.trim().length === 0}
          >
            {t('modal.submit')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
