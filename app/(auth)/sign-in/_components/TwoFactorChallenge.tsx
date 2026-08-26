'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound, Mail, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { twoFactor } from '@/lib/auth/client';
import { AuthShell, FormAlert } from '../../_components/AuthShell';

// The second-factor step of sign-in (Story 8.11 · Subtask MOTIR-1221), built to
// `design/auth/two-factor-challenge.mock.html`.
//
// ── IT IS A STEP, NOT A ROUTE ─────────────────────────────────────────────
// There is no `/sign-in/two-factor` page and there must not be. `signIn.email`
// either returns a session or answers `{ twoFactorRedirect: true }`, and this
// component is what the card renders in the second case — so the frame, the
// brand lockup and the shell are the ones `app/(auth)/layout.tsx` already drew,
// and the reader never navigates. A route would also be reachable by typing,
// which is a screen with no challenge to answer.
//
// ── THE PARTIAL STATE CANNOT REACH THE APP, AND NOT BECAUSE OF THIS FILE ──
// Between the password and the code there is NO session — the plugin sets a
// short-lived signed `two_factor` cookie instead and returns before
// `createSession`. So a reader who closes the tab here is simply not signed in,
// and `app/(authed)/layout.tsx` bounces them exactly as it bounces anyone else.
// The card's "cannot reach app resources until the second factor succeeds" is
// therefore a property of the plugin's ordering rather than a guard this screen
// implements, which is the right place for it to live.
//
// ── WHY A DOCUMENT LOAD ON SUCCESS ───────────────────────────────────────
// The same reason `SignInCard`'s password step gives: a returning user's saved
// appearance is server-applied onto the root layout's `<html>` element, and an
// RSC navigation cannot rewrite those attributes. The verify endpoints answer
// `{ token, user }` rather than `{ redirect, url }`, so unlike the password step
// nothing navigates for us and this component assigns `location.href` itself.

type View = 'totp' | 'choose' | 'email' | 'backup';

interface Props {
  /** Shown so the reader knows which account they are completing. */
  email: string;
  /** Where to land once the second factor succeeds. */
  callbackURL: string;
  /** What the sign-in said this account can answer with. */
  methods: string[];
  /** How long device trust lasts, for the checkbox's own words. */
  trustDeviceDays: number;
  /** Minutes an emailed code stays valid — the same constant the email states. */
  otpPeriodMinutes: number;
}

export function TwoFactorChallenge({
  email,
  callbackURL,
  methods,
  trustDeviceDays,
  otpPeriodMinutes,
}: Props) {
  const t = useTranslations('auth.twoFactor');

  const [view, setView] = useState<View>(methods.includes('totp') ? 'totp' : 'choose');
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sending, setSending] = useState(false);

  const hasTotp = methods.includes('totp');

  function reset(next: View) {
    setView(next);
    setCode('');
    setError('');
  }

  async function verify() {
    if (!code) return;
    setSubmitting(true);
    setError('');
    try {
      const res =
        view === 'backup'
          ? await twoFactor.verifyBackupCode({ code, trustDevice })
          : view === 'email'
            ? await twoFactor.verifyOtp({ code, trustDevice })
            : await twoFactor.verifyTotp({ code, trustDevice });

      if (res.error) {
        // ONE message per VIEW, because the remedies differ: a rejected
        // authenticator code is usually a drifted phone clock, a rejected
        // emailed code is usually an expired one, and a rejected recovery code
        // is usually one already spent. A single "that didn't work" would leave
        // a reader holding a correctly-typed code with nothing to try.
        setError(t(view === 'email' ? 'errors.expired' : `errors.${view}`));
        setSubmitting(false);
        return;
      }
      // A DOCUMENT load, not a router push — see the header.
      window.location.href = callbackURL;
    } catch {
      setError(t('errors.generic'));
      setSubmitting(false);
    }
  }

  async function sendEmailCode() {
    setSending(true);
    setError('');
    try {
      const res = await twoFactor.sendOtp();
      if (res.error) throw new Error('send failed');
      reset('email');
    } catch {
      // ⚠️ THIS BRANCH NOW ALSO CATCHES A DROPPED ENQUEUE (MOTIR-3583). The
      // comment here used to say the opposite — that a failure reaching this
      // point is one the endpoint itself reports, "not a dropped event" —
      // because `sendEvent` swallowed the transport failure and answered
      // `{ status: true }` on an outage. It was true, and it was the defect:
      // the reader was moved to the "we emailed you a code" view with no code
      // coming. `dispatchOtpEmail` is strict now, and the catch-all auth route
      // turns the recorded failure into a 503, so `sendOtp()` reports it and
      // the reader is told to try again or use their authenticator.
      setError(t('errors.sendFailed'));
    } finally {
      setSending(false);
    }
  }

  const codeField = (
    <Input
      label={view === 'backup' ? t('backup.label') : t('codeLabel')}
      value={code}
      onChange={(e) =>
        setCode(view === 'backup' ? e.target.value.trim() : e.target.value.replace(/\D/g, ''))
      }
      maxLength={view === 'backup' ? 11 : 6}
      inputMode={view === 'backup' ? 'text' : 'numeric'}
      autoComplete="one-time-code"
      className="font-mono tracking-[0.3em]"
      helperText={view === 'backup' ? t('backup.helper') : undefined}
      autoFocus
      required
    />
  );

  const trustCheckbox = (
    <Checkbox
      checked={trustDevice}
      onChange={setTrustDevice}
      label={t('trustDevice', { days: trustDeviceDays })}
      labelVisible
    />
  );

  if (view === 'choose') {
    return (
      <AuthShell headline={t('chooseTitle')} subhead={t('chooseSubtitle')}>
        <div className="flex flex-col gap-3">
          {hasTotp ? (
            <AltMethod
              icon={<Smartphone className="h-4 w-4" aria-hidden />}
              label={t('methods.totp.label')}
              sub={t('methods.totp.sub')}
              onClick={() => reset('totp')}
            />
          ) : null}
          <AltMethod
            icon={<Mail className="h-4 w-4" aria-hidden />}
            label={t('methods.email.label', { email: maskEmail(email) })}
            sub={t('methods.email.sub')}
            onClick={() => void sendEmailCode()}
            busy={sending}
          />
          <AltMethod
            icon={<KeyRound className="h-4 w-4" aria-hidden />}
            label={t('methods.backup.label')}
            sub={t('methods.backup.sub')}
            onClick={() => reset('backup')}
          />
        </div>
        {error ? <FormAlert>{error}</FormAlert> : null}
        {hasTotp ? <FootLink onClick={() => reset('totp')}>{t('backToCode')}</FootLink> : null}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      headline={
        view === 'backup' ? t('backup.title') : view === 'email' ? t('emailSent.title') : t('title')
      }
      subhead={
        view === 'backup'
          ? t('backup.subtitle')
          : view === 'email'
            ? t('emailSent.subtitle', { email: maskEmail(email) })
            : t('subtitle')
      }
    >
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
      >
        <div
          className="flex h-(--height-input) w-full items-center gap-2 rounded-(--radius-input) bg-(--el-surface) px-(--spacing-input-x)"
          aria-label={t('signingInAs', { email })}
        >
          <Mail className="h-5 w-5 text-(--el-text-secondary)" aria-hidden />
          <span className="flex-1 truncate font-sans text-sm text-(--el-text)">{email}</span>
        </div>

        {error ? <FormAlert>{error}</FormAlert> : null}
        {codeField}

        {view === 'email' ? (
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t('emailSent.expiry', { minutes: otpPeriodMinutes })}
          </p>
        ) : null}

        {trustCheckbox}

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
          {t('verify')}
        </Button>

        {view === 'email' ? (
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            loading={sending}
            onClick={() => void sendEmailCode()}
          >
            {t('emailSent.resend')}
          </Button>
        ) : null}
      </form>

      <FootLink onClick={() => reset('choose')}>{t('tryAnother')}</FootLink>
    </AuthShell>
  );
}

function AltMethod({
  icon,
  label,
  sub,
  onClick,
  busy,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center gap-2.5 rounded-(--radius-btn) border border-(--el-button-border) px-3.5 py-3 text-left hover:bg-(--el-surface) disabled:opacity-60"
    >
      <span className="shrink-0 text-(--el-text-secondary)">{icon}</span>
      <span className="min-w-0">
        <span className="block font-sans text-sm text-(--el-text)">{label}</span>
        <span className="mt-0.5 block font-sans text-xs text-(--el-text-secondary)">{sub}</span>
      </span>
    </button>
  );
}

function FootLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <div className="border-t border-(--el-border) pt-5">
      <button
        type="button"
        onClick={onClick}
        className="font-sans text-sm text-(--el-link) underline underline-offset-2 hover:text-(--el-link-pressed) focus-visible:outline-none"
      >
        {children}
      </button>
    </div>
  );
}

/**
 * `zhu•••@motir.co` — enough for the reader to recognise their own inbox,
 * not enough to hand a shoulder-surfer the address. The challenge is reachable
 * with only a password, so the screen must not confirm the full address to
 * someone who has one and should not.
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  return `${local.slice(0, 3)}•••@${domain}`;
}
