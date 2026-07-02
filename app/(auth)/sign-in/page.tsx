'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Mail, Lock, Eye, EyeOff, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { signIn } from '@/lib/auth/client';
import { AuthShell, OrDivider, FormAlert, IdeaCarried } from '../_components/AuthShell';
import { GoogleButton } from '../_components/GoogleButton';

// Where a visitor who arrived from the marketing hero lands after auth: the
// authed discovery chat, which reads the `motir_pending_idea` cookie (planted by
// the draft claim below) to seed its first turn. Kept as a literal here because
// the canonical constant lives in a `server-only` module (lib/onboarding/
// pendingIdea.ts) that a client component must not import.
const ONBOARDING_ENTRY_PATH = '/onboarding';

/**
 * Two-step sign-in (Clay pattern):
 *
 *   step 'email'    — Google button + email field + Continue. Renders
 *                     mockup 01.
 *   step 'password' — email read-only, password field, "Forgot password?"
 *                     link ABOVE the password field, Continue button.
 *                     Renders mockup 02.
 *
 * One route, internal state. The URL stays /sign-in throughout (per
 * Story-1.1 decision recorded in MOTIR.md). On wrong password, the
 * user stays on step 2 and sees an inline error (mockup 07).
 *
 * The "Forgot password?" position is ABOVE the password field — that's
 * the Clay pattern, not the more common below-field placement.
 */
export default function SignInPage() {
  // useSearchParams must be wrapped in Suspense for Next 16's static
  // pre-rendering — the suspense boundary lets the static shell stream
  // while the search params resolve client-side.
  return (
    <Suspense fallback={<SignInShell />}>
      <SignInForm />
    </Suspense>
  );
}

function SignInShell() {
  const t = useTranslations('auth');
  // The headline + subhead stay stable across both states, so the
  // streaming fallback renders the same shell as the loaded form.
  return (
    <AuthShell headline={t('welcomeBack')} subhead={t('signInSubhead')}>
      <div className="flex flex-col gap-5" aria-hidden />
    </AuthShell>
  );
}

function SignInForm() {
  const t = useTranslations('auth');
  const router = useRouter();
  const searchParams = useSearchParams();
  // A cross-origin idea draft handed off from the marketing hero (Subtask 7.22.2
  // / MOTIR-1458). When present, we claim it (planting the preserved-idea cookie)
  // and default the post-auth destination to onboarding so the idea seeds the
  // first chat turn. An explicit `next=` still wins if the caller set one.
  const draftId = searchParams.get('draft');
  const callbackURL = searchParams.get('next') ?? (draftId ? ONBOARDING_ENTRY_PATH : '/dashboard');
  const [carriedIdea, setCarriedIdea] = useState<string | null>(null);

  // Claim the draft ONCE on mount: POST swaps the opaque id for the idea text and
  // plants the `motir_pending_idea` cookie server-side. On any failure (missing /
  // expired / forged id, or a network error) we simply don't show the banner and
  // the page degrades to a normal login — no crash, no leak. The claim consumes
  // the draft, so the ref-guard also stops a re-claim on re-render.
  const claimedRef = useRef(false);
  useEffect(() => {
    if (!draftId || claimedRef.current) return;
    claimedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/idea-draft/${encodeURIComponent(draftId)}/claim`, {
          method: 'POST',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { idea?: string };
        if (!cancelled && data.idea) setCarriedIdea(data.idea);
      } catch {
        // Network error → normal login; the cookie simply isn't planted.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const [step, setStep] = useState<'email' | 'password'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // pageError is seeded from a `?error=` query param (Better-Auth bounces
  // back here on a denied/failed Google consent — mockup 06). We seed it
  // once during initial render via useState's lazy initializer, then let
  // the user dismiss/replace it through subsequent interactions. Pulling
  // it out of the URL into local state avoids the cascading-render trap
  // that useEffect+setState would create (react-hooks/set-state-in-effect).
  const [pageError, setPageError] = useState(() =>
    searchParams.get('error') ? t('googleSignInIncomplete') : '',
  );
  const [passwordError, setPasswordError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onContinueEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPageError('');
    if (!email.trim()) return;
    // We DON'T pre-check the email server-side here — that would enumerate
    // accounts. Always advance to the password step; the password submit
    // surfaces the unified "email or password is wrong" error if either
    // is invalid.
    setStep('password');
  }

  async function onSubmitPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPasswordError('');
    setPageError('');
    if (!password) return;
    setSubmitting(true);
    try {
      const result = await signIn.email({ email, password, callbackURL });
      if (result?.error) {
        // Unified error message — no enumeration. Mockup 07's exact copy.
        setPasswordError(t('wrongPassword'));
        setSubmitting(false);
        return;
      }
      router.push(callbackURL);
    } catch {
      setPasswordError(t('wrongPassword'));
      setSubmitting(false);
    }
  }

  return (
    <AuthShell headline={t('welcomeBack')} subhead={t('signInSubhead')}>
      {carriedIdea ? <IdeaCarried label={t('ideaCarriedLabel')}>{carriedIdea}</IdeaCarried> : null}
      {pageError ? <FormAlert>{pageError}</FormAlert> : null}

      {step === 'email' ? (
        <form onSubmit={onContinueEmail} className="flex flex-col gap-5" noValidate>
          {/* Google button first per the AC: tab order = Google → email → continue. */}
          <GoogleButton callbackURL={callbackURL} onError={setPageError} />
          <OrDivider />
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
            {submitting ? t('checking') : t('continue')}
          </Button>
          <FooterLink prompt={t('dontHaveAccount')} linkText={t('signUp')} href="/sign-up" />
        </form>
      ) : (
        <form onSubmit={onSubmitPassword} className="flex flex-col gap-5" noValidate>
          {/* Email — read-only display, click to edit (flips back to step 'email'). */}
          <div className="flex flex-col gap-1.5">
            <div
              className="flex h-(--height-input) w-full items-center gap-2 rounded-(--radius-input) bg-(--el-surface) px-(--spacing-input-x)"
              aria-label={t('signingInAs', { email })}
            >
              <Mail className="text-(--el-text-muted) h-5 w-5" aria-hidden />
              <span className="flex-1 truncate font-sans text-sm text-(--el-text)">{email}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setStep('email');
                setPassword('');
                setPasswordError('');
              }}
              className="self-start font-sans text-xs text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:underline"
            >
              {t('useDifferentEmail')}
            </button>
          </div>

          {/* Forgot password — ABOVE the field, per the Clay pattern + mockup 02. */}
          <Link
            href="/reset-password"
            className="self-start font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:underline"
          >
            {t('forgotPassword')}
          </Link>

          <Input
            type={showPassword ? 'text' : 'password'}
            name="password"
            autoComplete="current-password"
            placeholder={t('password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            addonStart={<Lock className="h-5 w-5" aria-hidden />}
            addonEnd={
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                className="inline-flex h-6 w-6 items-center justify-center rounded-(--radius-xs) text-(--el-text-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden />
                )}
              </button>
            }
            aria-label={t('password')}
            error={passwordError || undefined}
            required
            autoFocus
          />

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
            {submitting ? t('signingIn') : t('continue')}
          </Button>

          <FooterLink prompt={t('dontHaveAccount')} linkText={t('signUp')} href="/sign-up" />
        </form>
      )}

      {/* Plan with AI — the onboarding door (Subtask 7.22.1 / MOTIR-1457). The
          entry into the start-fresh AI planning flow from the login surface,
          the front-door role the relocated marketing hero used to hold. Routes
          to /onboarding: the onboarding layout gates auth (preserving
          `next=/onboarding`), then a cloud deployment begins discovery while a
          self-hosted one shows the deferred Connect-Motir-AI gate. */}
      <div className="flex flex-col gap-3 border-t border-(--el-border) pt-6">
        <p className="text-center font-sans text-sm text-(--el-text-muted)">
          {t('planWithAiLead')}
        </p>
        <Link
          href="/onboarding"
          className={`${buttonVariants({ variant: 'secondary', size: 'lg' })} w-full`}
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          {t('planWithAI')}
        </Link>
      </div>
    </AuthShell>
  );
}

function FooterLink({
  prompt,
  linkText,
  href,
}: {
  prompt: string;
  linkText: string;
  href: string;
}) {
  return (
    <p className="font-sans text-sm text-(--el-text)">
      {prompt}{' '}
      <Link
        href={href}
        className="font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:underline"
      >
        {linkText}
      </Link>
    </p>
  );
}
