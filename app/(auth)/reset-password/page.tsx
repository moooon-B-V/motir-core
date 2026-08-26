'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AuthShell, FormAlert } from '../_components/AuthShell';

/**
 * /reset-password — single route, two states (mockups 04 → 05):
 *
 *   state 'request'      — email field + "Send reset link" + "Back to sign in"
 *   state 'confirmation' — "Check your inbox" headline, "Back to sign in",
 *                          "Didn't get it?" prompt to flip back
 *
 * Anti-enumeration: we ALWAYS show the confirmation screen, even if the
 * email doesn't exist. Better-Auth's /request-password-reset returns
 * { status: true } regardless (Subtask 1.1.6), so this UI matches.
 *
 * The `redirectTo` we pass is the canonical tokenized landing page —
 * Better-Auth bounces /api/auth/reset-password/:token through to that
 * URL with ?token=<token> appended.
 *
 * Rate limiting (3/hour per IP) lives in lib/auth/index.ts. If we hit
 * the limit, Better-Auth returns 429; we surface a clear inline alert
 * rather than silently flipping to the confirmation screen.
 *
 * ⚠️ THE SAME EXCEPTION NOW APPLIES TO A MAIL OUTAGE (Bug MOTIR-3583). The
 * confirmation screen is a PROMISE that a message is on its way, and until this
 * branch existed it was shown even when the send could not be QUEUED — so the
 * reader waited on an inbox nothing would ever arrive in, and the "try another
 * email" retry failed the identical silent way. `sendResetPassword` is strict
 * now and the catch-all auth route answers 503 when the enqueue failed
 * (`lib/auth/authMail.ts`), so a 503 shows the alert instead of the promise.
 *
 * ⚠️ AND IT IS A KNOWN, BOUNDED COST TO ANTI-ENUMERATION — stated here rather
 * than discovered later. Better-Auth only calls the send hook when the account
 * EXISTS, so during a mail outage an unknown address still gets the
 * confirmation screen while a known one gets the alert. That window opens only
 * while the queue is down, is not something an attacker can provoke, and the
 * alternative is a permanent silent dead end for the real user in exactly the
 * conditions where they cannot reach support either. Every other status is
 * still folded into the confirmation screen, which is what keeps the ordinary
 * case indistinguishable.
 */
export default function ResetPasswordPage() {
  const t = useTranslations('auth');
  const [state, setState] = useState<'request' | 'confirmation'>('request');
  const [email, setEmail] = useState('');
  const [pageError, setPageError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPageError('');
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      const redirectTo = `${window.location.origin}/reset-password/new`;
      const res = await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, redirectTo }),
      });
      if (res.status === 429) {
        setPageError(t('tooManyRequests'));
        setSubmitting(false);
        return;
      }
      // 503 == "the email could not be queued" (MOTIR-3583). The ONLY other
      // status we branch on, and for the same reason as the 429: showing the
      // confirmation screen here would promise a delivery that cannot happen.
      if (res.status === 503) {
        setPageError(t('couldntSendResetLink'));
        setSubmitting(false);
        return;
      }
      // We deliberately don't read or branch on res.ok any further —
      // anti-enumeration: any other result shows the same confirmation screen.
      setState('confirmation');
      setSubmitting(false);
    } catch {
      setPageError(t('couldntReachServer'));
      setSubmitting(false);
    }
  }

  if (state === 'confirmation') {
    return (
      <AuthShell headline={t('checkInbox')} subhead={t('checkInboxSubhead')}>
        <div className="flex flex-col gap-4">
          <Link
            href="/sign-in"
            className="inline-flex h-(--height-btn-lg) w-full items-center justify-center rounded-(--radius-btn) border border-(--el-border-strong) bg-transparent px-6 font-sans text-base font-medium text-(--el-text) transition-colors hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t('backToSignIn')}
          </Link>
          <p className="text-(--el-text-muted) font-sans text-sm">
            {t('didntGetIt')}{' '}
            <button
              type="button"
              onClick={() => setState('request')}
              className="font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:underline"
            >
              {t('checkSpam')}
            </button>
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell headline={t('resetYourPassword')} subhead={t('resetSubhead')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        {pageError ? <FormAlert>{pageError}</FormAlert> : null}
        <Input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder={t('emailAddress')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          addonStart={<Mail className="h-5 w-5" aria-hidden />}
          aria-label={t('emailAddress')}
          required
          autoFocus
        />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
          {submitting ? t('sending') : t('sendResetLink')}
        </Button>
        <Link
          href="/sign-in"
          className="inline-flex h-(--height-btn-lg) w-full items-center justify-center rounded-(--radius-btn) border border-(--el-border-strong) bg-transparent px-6 font-sans text-base font-medium text-(--el-text) transition-colors hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {t('backToSignIn')}
        </Link>
      </form>
    </AuthShell>
  );
}
