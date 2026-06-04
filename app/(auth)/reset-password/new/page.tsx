'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Lock, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AuthShell, FormAlert } from '../../_components/AuthShell';

/**
 * The "set a new password" landing page reached from the email link.
 *
 * Wiring: when the user clicks the reset link in their email, Better-Auth's
 * GET /api/auth/reset-password/:token validates the token and redirects to
 * `redirectTo` (set by the previous page to `${origin}/reset-password/new`)
 * with `?token=<token>` appended. On invalid/expired token it redirects
 * with `?error=INVALID_TOKEN`.
 *
 * The card's draft path was `/reset-password/[token]`, but Better-Auth
 * always uses a QUERY param for the token (see node_modules/better-auth/
 * .../password.mjs — `redirectCallback(callbackURL, { token })`), so a
 * dynamic segment can't capture it. This route is therefore a static
 * `/new` segment that reads `?token=` from search params. Decision noted
 * in the PR body.
 *
 * No mockup exists for this screen (card called this out as planner work).
 * Layout matches the established Clay frame: serif headline + single
 * Input + primary full-width button. Copy: "Set a new password" headline,
 * "Make it at least 8 characters" subhead.
 */
export default function NewPasswordPage() {
  return (
    <Suspense fallback={<NewPasswordShell />}>
      <NewPasswordForm />
    </Suspense>
  );
}

function NewPasswordShell() {
  return (
    <AuthShell
      headline="Set a new password"
      subhead="Pick something you haven't used before — at least 8 characters."
    >
      <div className="flex flex-col gap-5" aria-hidden />
    </AuthShell>
  );
}

function NewPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const callbackError = searchParams.get('error');

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pageError, setPageError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  // Invalid/expired token path — rendered as a clean error state with a
  // clear path forward (request a new link). This is what the user lands
  // on if they clicked an old email or a tampered URL.
  if (callbackError === 'INVALID_TOKEN' || !token) {
    return (
      <AuthShell
        headline="This link has expired"
        subhead="Reset links expire after 1 hour for security. Request a new one to continue."
      >
        <div className="flex flex-col gap-4">
          <Link
            href="/reset-password"
            className="inline-flex h-(--height-btn-lg) w-full items-center justify-center rounded-(--radius-btn) bg-(--el-accent) px-6 font-sans text-base font-medium text-(--el-accent-text) transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Request a new link
          </Link>
          <Link
            href="/sign-in"
            className="inline-flex h-(--height-btn-lg) w-full items-center justify-center rounded-(--radius-btn) border border-(--el-border-strong) bg-transparent px-6 font-sans text-base font-medium text-(--el-text) transition-colors hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (success) {
    return (
      <AuthShell headline="Password updated" subhead="You can now sign in with your new password.">
        <Link
          href="/sign-in"
          className="inline-flex h-(--height-btn-lg) w-full items-center justify-center rounded-(--radius-btn) bg-(--el-accent) px-6 font-sans text-base font-medium text-(--el-accent-text) transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Continue to sign in
        </Link>
      </AuthShell>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPageError('');
    setFieldError('');
    if (password.length < 8) {
      setFieldError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newPassword: password, token }),
      });
      if (res.ok) {
        setSuccess(true);
        // Hint the router so a future re-render doesn't get stuck on the
        // pending search params from the prior URL.
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      if (body.code === 'INVALID_TOKEN') {
        // Bounce to the expired-link state via the same query param the
        // callback uses, so the early-return branch above renders the
        // recovery UI.
        router.replace('/reset-password/new?error=INVALID_TOKEN');
        return;
      }
      setPageError(body.message ?? 'Something went wrong. Please try again.');
      setSubmitting(false);
    } catch {
      setPageError("We couldn't reach the server. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      headline="Set a new password"
      subhead="Pick something you haven't used before — at least 8 characters."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        {pageError ? <FormAlert>{pageError}</FormAlert> : null}
        <Input
          type={showPassword ? 'text' : 'password'}
          name="new-password"
          autoComplete="new-password"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          addonStart={<Lock className="h-5 w-5" aria-hidden />}
          addonEnd={
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="inline-flex h-6 w-6 items-center justify-center rounded-(--radius-xs) text-(--el-text-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden />
              ) : (
                <Eye className="h-4 w-4" aria-hidden />
              )}
            </button>
          }
          aria-label="New password"
          helperText={fieldError ? undefined : 'At least 8 characters.'}
          error={fieldError || undefined}
          required
          autoFocus
        />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
          {submitting ? 'Updating…' : 'Set new password'}
        </Button>
      </form>
    </AuthShell>
  );
}
