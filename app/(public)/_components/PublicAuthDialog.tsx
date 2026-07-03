'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { signIn, signUp } from '@/lib/auth/client';
import { OrDivider, FormAlert } from '@/app/(auth)/_components/AuthShell';
import { GoogleButton } from '@/app/(auth)/_components/GoogleButton';

// In-place (modal) sign-in / sign-up for the public project page (MOTIR-1558;
// design gate MOTIR-1557 · design/public-projects/public-signin-modal.mock.html).
//
// The public topbar's "Sign in" / "Start free" CTAs used to be full-page <Link>s
// to /sign-in · /sign-up carrying ?next=. This authenticates IN PLACE instead —
// the visitor never leaves the public page. The two CTAs now OPEN the shipped
// `Modal`, which hosts the REAL two-step auth content mirrored 1:1 from the
// shipped app/(auth)/sign-in + sign-up pages (Google button, OrDivider,
// FormAlert, the email→password / identity→create-password state machine, the
// unified wrong-password / USER_ALREADY_EXISTS / PASSWORD_TOO_SHORT handling).
//
// Scope (design decisions, honoured): auth only — NO "Plan with AI" onboarding
// door, NO IdeaCarried banner (those stay page-only). The full-page /sign-in +
// /sign-up routes remain for deep links / onboarding / OAuth error bounce-back;
// this modal is ADDITIVE.
//
// Success (email/password): close the modal + router.refresh(). PublicTopBar is
// server-rendered, so the refresh re-reads the session and swaps the CTAs for the
// account menu — the server-surface branch of the page-state contract. We never
// router.push for the email path: staying on the page is the whole point.
//
// Google: signIn.social inherently redirects to Google consent; callbackURL is
// this public page so the visitor lands back here after OAuth.

type Mode = 'sign-in' | 'sign-up';

export function PublicAuthDialog({ callbackPath }: { callbackPath: string }) {
  const tPub = useTranslations('publicProjects');
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('sign-in');
  // Bump on each open so the inner form reseeds (fresh step/fields/errors).
  const [openCount, setOpenCount] = useState(0);

  function launch(next: Mode) {
    setMode(next);
    setOpenCount((c) => c + 1);
    setOpen(true);
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => launch('sign-in')}>
        {tPub('signIn')}
      </Button>
      <Button variant="primary" size="sm" onClick={() => launch('sign-up')}>
        {tPub('startFree')}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        size="md"
        srTitle={mode === 'sign-in' ? tPub('signIn') : tPub('startFree')}
      >
        {open ? (
          <AuthForm
            key={openCount}
            initialMode={mode}
            callbackURL={callbackPath}
            onSyncMode={setMode}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </Modal>
    </>
  );
}

function AuthForm({
  initialMode,
  callbackURL,
  onSyncMode,
  onClose,
}: {
  initialMode: Mode;
  callbackURL: string;
  // Keeps the dialog's accessible name (srTitle) in step with an in-place mode
  // switch triggered by the cross-links.
  onSyncMode: (mode: Mode) => void;
  onClose: () => void;
}) {
  const t = useTranslations('auth');
  const router = useRouter();

  const [mode, setMode] = useState<Mode>(initialMode);
  // 'email' (sign-in) / 'identity' (sign-up) is the first step; the second step
  // is 'password' in both.
  const [step, setStep] = useState<'first' | 'password'>('first');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pageError, setPageError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [emailExists, setEmailExists] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isSignIn = mode === 'sign-in';

  function switchMode() {
    const next: Mode = isSignIn ? 'sign-up' : 'sign-in';
    setMode(next);
    onSyncMode(next);
    setStep('first');
    setPassword('');
    setPasswordError('');
    setPageError('');
    setEmailExists(false);
  }

  function backToFirst() {
    setStep('first');
    setPassword('');
    setPasswordError('');
  }

  function onContinueFirst(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPageError('');
    setEmailExists(false);
    if (!email.trim()) return;
    // We never pre-check the email (that would enumerate accounts); always
    // advance — the password submit surfaces the unified error.
    setStep('password');
  }

  async function onSubmitSignIn() {
    setPasswordError('');
    setPageError('');
    if (!password) return;
    setSubmitting(true);
    try {
      const result = await signIn.email({ email, password, callbackURL });
      if (result?.error) {
        setPasswordError(t('wrongPassword'));
        setSubmitting(false);
        return;
      }
      // Success: stay on the public page. Close + refresh so the server-rendered
      // topbar re-reads the session and swaps the CTAs for the account menu.
      onClose();
      router.refresh();
    } catch {
      setPasswordError(t('wrongPassword'));
      setSubmitting(false);
    }
  }

  async function onSubmitSignUp() {
    setPasswordError('');
    setPageError('');
    setEmailExists(false);
    if (password.length < 8) {
      setPasswordError(t('passwordTooShort'));
      return;
    }
    setSubmitting(true);
    try {
      const result = await signUp.email({
        email,
        password,
        // Better-Auth requires a non-null `name`; derive it from the localpart
        // (the user edits it later in profile settings), mirroring the page.
        name: email.split('@')[0]!,
        callbackURL,
      });
      if (result?.error) {
        const code = result.error.code ?? '';
        if (
          code.startsWith('USER_ALREADY_EXISTS') ||
          /already exists/i.test(result.error.message ?? '')
        ) {
          setEmailExists(true);
          setStep('first');
        } else if (code === 'PASSWORD_TOO_SHORT' || /password/i.test(result.error.message ?? '')) {
          setPasswordError(t('passwordTooShort'));
        } else {
          setPageError(t('somethingWentWrong'));
        }
        setSubmitting(false);
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setPageError(t('somethingWentWrong'));
      setSubmitting(false);
    }
  }

  const passwordToggle = (
    <button
      type="button"
      onClick={() => setShowPassword((s) => !s)}
      aria-label={showPassword ? t('hidePassword') : t('showPassword')}
      className="inline-flex h-6 w-6 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      {showPassword ? (
        <EyeOff className="h-4 w-4" aria-hidden />
      ) : (
        <Eye className="h-4 w-4" aria-hidden />
      )}
    </button>
  );

  return (
    <Modal.Body className="gap-6">
      <header className="flex flex-col gap-2 pr-6">
        <h2 className="font-serif text-2xl font-semibold leading-tight tracking-tight text-(--el-text) sm:text-3xl">
          {isSignIn ? t('welcomeBack') : t('welcomeToMotir')}
        </h2>
        <p className="font-sans text-sm text-(--el-text-muted)">
          {isSignIn ? t('signInSubhead') : t('signUpSubhead')}
        </p>
      </header>

      {pageError ? <FormAlert>{pageError}</FormAlert> : null}

      {step === 'first' ? (
        <form onSubmit={onContinueFirst} className="flex flex-col gap-5" noValidate>
          {/* Google first — tab order Google → email → Continue. */}
          <GoogleButton callbackURL={callbackURL} onError={setPageError} />
          <OrDivider />
          <Input
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            placeholder={t('emailAddress')}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailExists) setEmailExists(false);
            }}
            addonStart={<Mail className="h-5 w-5" aria-hidden />}
            aria-label={t('emailAddress')}
            required
            autoFocus
            error={!isSignIn && emailExists ? t('accountExists') : undefined}
            helperText={isSignIn || emailExists ? undefined : t('emailHelper')}
          />
          {!isSignIn && emailExists ? (
            <p className="-mt-2 font-sans text-sm text-(--el-text)">
              <button
                type="button"
                onClick={switchMode}
                className="font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:underline focus-visible:outline-none"
              >
                {t('signInInstead')}
              </button>
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" className="w-full">
            {t('continue')}
          </Button>
          <CrossLink
            prompt={isSignIn ? t('dontHaveAccount') : t('alreadyHaveAccount')}
            linkText={isSignIn ? t('signUp') : t('logIn')}
            onClick={switchMode}
          />
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (isSignIn ? onSubmitSignIn() : onSubmitSignUp());
          }}
          className="flex flex-col gap-5"
          noValidate
        >
          {/* Email recap — read-only, click to edit (back to first step). */}
          <div className="flex flex-col gap-1.5">
            <div
              className="flex h-(--height-input) w-full items-center gap-2 rounded-(--radius-input) bg-(--el-surface) px-(--spacing-input-x)"
              aria-label={t('signingInAs', { email })}
            >
              <Mail className="h-5 w-5 text-(--el-text-muted)" aria-hidden />
              <span className="flex-1 truncate font-sans text-sm text-(--el-text)">{email}</span>
            </div>
            <button
              type="button"
              onClick={backToFirst}
              className="self-start font-sans text-xs text-(--el-link) hover:text-(--el-link-pressed) focus-visible:underline focus-visible:outline-none"
            >
              {isSignIn ? t('useDifferentEmail') : t('edit')}
            </button>
          </div>

          {/* Forgot password — ABOVE the field (the Clay pattern), a real link to
              the full-page reset route. Sign-in only. */}
          {isSignIn ? (
            <Link
              href="/reset-password"
              className="self-start font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:underline focus-visible:outline-none"
            >
              {t('forgotPassword')}
            </Link>
          ) : null}

          <Input
            type={showPassword ? 'text' : 'password'}
            name={isSignIn ? 'password' : 'new-password'}
            autoComplete={isSignIn ? 'current-password' : 'new-password'}
            placeholder={isSignIn ? t('password') : t('createPassword')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            addonStart={<Lock className="h-5 w-5" aria-hidden />}
            addonEnd={passwordToggle}
            aria-label={t('password')}
            error={passwordError || undefined}
            helperText={isSignIn || passwordError ? undefined : t('atLeast8')}
            required
            autoFocus
          />

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
            {isSignIn
              ? submitting
                ? t('signingIn')
                : t('continue')
              : submitting
                ? t('creatingAccount')
                : t('createAccount')}
          </Button>

          <CrossLink
            prompt={isSignIn ? t('dontHaveAccount') : t('alreadyHaveAccount')}
            linkText={isSignIn ? t('signUp') : t('logIn')}
            onClick={switchMode}
          />
        </form>
      )}
    </Modal.Body>
  );
}

// The "Don't have an account? Sign up" / "Already have an account? Log in"
// cross-link — a button that swaps the modal content IN PLACE (no navigation).
function CrossLink({
  prompt,
  linkText,
  onClick,
}: {
  prompt: string;
  linkText: string;
  onClick: () => void;
}) {
  return (
    <p className="font-sans text-sm text-(--el-text)">
      {prompt}{' '}
      <button
        type="button"
        onClick={onClick}
        className="font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:underline focus-visible:outline-none"
      >
        {linkText}
      </button>
    </p>
  );
}
