'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, Mail, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { changePasswordAction, sendSetPasswordLinkAction } from '../profile/actions';

// The "Password & security" card on the Account › Profile pane (Story 8.8 ·
// Subtask 8.8.24c). Branches on `hasPassword` (read SSR via
// usersService.getPasswordCapability, threaded from the page):
//   - credential user (hasPassword)  → ChangePasswordModal (current → new →
//     confirm), wired to changePasswordAction (8.8.23).
//   - OAuth-only user (!hasPassword) → SendResetLinkButton, wired to
//     sendSetPasswordLinkAction (8.8.23), which reuses the shipped reset flow so
//     they can SET a first password and also sign in with email.
// Built to `design/settings/profile.mock.html` panels 1 (credential card),
// 3 (change-password modal + toast) and 4 (OAuth-only variant). Composed from
// the shipped primitives (Card / Modal / Input / Button / Toast); colour through
// `--el-*`, shape through element-semantic tokens. Do not improvise the UI or the
// branch — both are specified by the design + the backend's capability split.
//
// Page-state contract (CLAUDE.md): a password change touches NO other surface on
// the pane (nothing else renders the password), so success is a Toast only — no
// router.refresh()/revalidatePath().

// Mirrors lib/auth/passwordPolicy.MIN_PASSWORD_LENGTH and the shipped
// /reset-password/new client check — instant feedback before the round-trip; the
// server is the real gate (returns WEAK_PASSWORD).
const MIN_PASSWORD_LENGTH = 8;

export interface PasswordSecurityCardProps {
  /** Whether the account has a credential (email/password) login. OAuth-only
   *  accounts (Google, no password) get the set-password-link path instead. */
  hasPassword: boolean;
}

export function PasswordSecurityCard({ hasPassword }: PasswordSecurityCardProps) {
  return hasPassword ? <CredentialSecurityCard /> : <OAuthSecurityCard />;
}

/** Shared card header — title + descriptive subtitle. */
function SecurityCardHeader({ subtitle }: { subtitle: string }) {
  const t = useTranslations('settings.profile.security');
  return (
    <div>
      <h3 className="font-sans text-base font-semibold text-(--el-text)">{t('card.title')}</h3>
      <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">{subtitle}</p>
    </div>
  );
}

// ── Credential user — Change password ──────────────────────────────────────

function CredentialSecurityCard() {
  const t = useTranslations('settings.profile.security');
  const [open, setOpen] = useState(false);

  return (
    <Card header={<SecurityCardHeader subtitle={t('card.subtitle')} />}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-sans text-sm font-medium text-(--el-text)">
            {t('password.label')}
          </div>
          <div className="mt-0.5 font-sans text-xs leading-snug text-(--el-text-muted)">
            {t('password.desc')}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Lock className="h-3.5 w-3.5" aria-hidden />}
          onClick={() => setOpen(true)}
        >
          {t('changePassword')}
        </Button>
      </div>
      <ChangePasswordModal open={open} onOpenChange={setOpen} />
    </Card>
  );
}

interface FieldErrors {
  current?: string;
  next?: string;
  confirm?: string;
  form?: string;
}

function ChangePasswordModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('settings.profile.security');
  const { toast } = useToast();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [isPending, startTransition] = useTransition();

  function reset() {
    setCurrent('');
    setNext('');
    setConfirm('');
    setErrors({});
  }

  // Reset the form whenever the modal closes so a re-open starts clean (and a
  // stale typed password never lingers in state).
  function handleOpenChange(value: boolean) {
    if (!value) reset();
    onOpenChange(value);
  }

  function submit() {
    // Client-side validation — instant feedback (the server re-validates).
    const nextErrors: FieldErrors = {};
    if (current.length === 0) nextErrors.current = t('errors.currentRequired');
    if (next.length < MIN_PASSWORD_LENGTH) nextErrors.next = t('errors.tooShort');
    if (confirm !== next) nextErrors.confirm = t('errors.mismatch');
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});

    startTransition(async () => {
      const result = await changePasswordAction({ currentPassword: current, newPassword: next });
      if (result.ok) {
        toast({
          variant: 'success',
          title: t('toast.changed.title'),
          description: t('toast.changed.desc'),
        });
        handleOpenChange(false);
        return;
      }
      switch (result.code) {
        case 'WRONG_CURRENT_PASSWORD':
          setErrors({ current: t('errors.wrongCurrent') });
          break;
        case 'WEAK_PASSWORD':
          setErrors({ next: t('errors.tooShort') });
          break;
        case 'RATE_LIMITED':
          setErrors({ form: t('errors.rateLimited') });
          break;
        case 'NO_CREDENTIAL_PASSWORD':
          setErrors({ form: t('errors.noCredential') });
          break;
      }
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title={t('modal.title')}
      description={t('modal.desc')}
      size="sm"
    >
      <Modal.Body className="gap-4">
        {errors.form ? (
          <p
            role="alert"
            className="rounded-(--radius-control) bg-(--el-tint-rose) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs text-(--el-text-strong)"
          >
            {errors.form}
          </p>
        ) : null}
        <PasswordField
          label={t('fields.current')}
          autoComplete="current-password"
          value={current}
          onChange={(value) => {
            setCurrent(value);
            if (errors.current || errors.form)
              setErrors((e) => ({ ...e, current: undefined, form: undefined }));
          }}
          error={errors.current}
          autoFocus
        />
        <PasswordField
          label={t('fields.new')}
          autoComplete="new-password"
          value={next}
          onChange={(value) => {
            setNext(value);
            if (errors.next) setErrors((e) => ({ ...e, next: undefined }));
          }}
          error={errors.next}
          helperText={t('fields.newHelper')}
        />
        <PasswordField
          label={t('fields.confirm')}
          autoComplete="new-password"
          value={confirm}
          onChange={(value) => {
            setConfirm(value);
            if (errors.confirm) setErrors((e) => ({ ...e, confirm: undefined }));
          }}
          error={errors.confirm}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>
          {t('modal.cancel')}
        </Button>
        <Button variant="primary" onClick={submit} loading={isPending}>
          {isPending ? t('modal.saving') : t('modal.submit')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** A password input with a show/hide toggle — mirrors the shipped
 *  /reset-password/new + /sign-in field pattern (toggle in `addonEnd`). */
function PasswordField({
  label,
  value,
  onChange,
  error,
  helperText,
  autoComplete,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helperText?: string;
  autoComplete: string;
  autoFocus?: boolean;
}) {
  const t = useTranslations('settings.profile.security');
  const [show, setShow] = useState(false);
  return (
    <Input
      type={show ? 'text' : 'password'}
      label={label}
      aria-label={label}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={error}
      helperText={error ? undefined : helperText}
      addonStart={<Lock className="h-4 w-4" aria-hidden />}
      addonEnd={
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? t('fields.hide') : t('fields.show')}
          className="inline-flex h-6 w-6 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          {show ? (
            <EyeOff className="h-4 w-4" aria-hidden />
          ) : (
            <Eye className="h-4 w-4" aria-hidden />
          )}
        </button>
      }
    />
  );
}

// ── OAuth-only user — Send a set-password link ─────────────────────────────

function OAuthSecurityCard() {
  const t = useTranslations('settings.profile.security');
  const { toast } = useToast();
  const [sent, setSent] = useState(false);
  const [isPending, startTransition] = useTransition();

  function send() {
    startTransition(async () => {
      const result = await sendSetPasswordLinkAction();
      if (result.ok) {
        setSent(true);
        toast({
          variant: 'success',
          title: t('toast.linkSent.title'),
          description: t('toast.linkSent.desc'),
        });
        return;
      }
      if (result.code === 'RATE_LIMITED') {
        toast({ variant: 'error', title: t('errors.rateLimited') });
      } else {
        // ALREADY_HAS_PASSWORD — the UI branched on hasPassword, so this is a
        // backstop; surface it rather than silently swallow.
        toast({ variant: 'error', title: t('errors.alreadyHasPassword') });
      }
    });
  }

  return (
    <Card header={<SecurityCardHeader subtitle={t('card.oauthSubtitle')} />}>
      {/* Callout — explains the Google sign-in method + what the link does. */}
      <div className="flex items-start gap-3 rounded-(--radius-card) bg-(--el-surface) p-(--spacing-card-padding)">
        <span className="mt-0.5 shrink-0">
          <GoogleGlyph />
        </span>
        <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
          {t.rich('oauth.body', {
            b: (chunks) => <span className="font-medium text-(--el-text)">{chunks}</span>,
          })}
        </p>
      </div>

      {sent ? (
        <div className="mt-(--spacing-md) flex items-center gap-2 font-sans text-sm text-(--el-success)">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          <span role="status">{t('oauth.sent')}</span>
        </div>
      ) : (
        <div className="mt-(--spacing-md) flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Mail className="h-3.5 w-3.5" aria-hidden />}
            onClick={send}
            loading={isPending}
          >
            {isPending ? t('oauth.sending') : t('oauth.sendLink')}
          </Button>
        </div>
      )}
    </Card>
  );
}

// Official multi-color Google "G" — inlined (no third-party hotlink), matching
// the shipped GoogleButton glyph (app/(auth)/_components/GoogleButton.tsx).
function GoogleGlyph() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
