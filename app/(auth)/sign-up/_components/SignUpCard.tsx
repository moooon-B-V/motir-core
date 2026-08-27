'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { signUp } from '@/lib/auth/client';
import { AuthShell, OrDivider, FormAlert } from '../../_components/AuthShell';
import { GoogleButton } from '../../_components/GoogleButton';
import { resolvePostAuthDestination } from '@/lib/navigation/landing';

/**
 * Sign-up. Two-step, following mockup 03 + the Clay pattern.
 *
 *   step 'identity' — Google button + Email + Continue.
 *                     Password is collected in a second step rather than
 *                     crammed on one screen (planner decision, not in the
 *                     card; flagged in the PR body).
 *   step 'password' — Password field with the 8-char helper, Continue
 *                     button that creates the account.
 *
 * The `name` field is NOT collected from the user. Better-Auth's user
 * schema requires a `name` column (NOT NULL); we derive it from the
 * email localpart at create-time and let the user edit it later in
 * profile settings. Rationale: per the Subtask card's AC, sign-up only
 * requires email + 8+ char password — and per notes.html mistake #26,
 * the mockup's name field is a layout-confirmation artifact, not a
 * finishing-line spec.
 *
 * Errors:
 *   - Email already taken → inline, with a link back to /sign-in.
 *     Mockup AC requires this copy.
 *   - Password too short  → inline on the field (8 chars min).
 *   - Other failures      → top-of-form FormAlert with a generic message.
 *
 * ⚠️ THIS IS THE ISLAND, NOT THE ROUTE (MOTIR-3372). `app/(auth)/sign-up/page.tsx`
 * is a server shell that resolves the session and bounces a reader who is already
 * signed in; only when the form is the right answer does it render this. Moved
 * here unchanged apart from the extraction.
 */
export function SignUpCard() {
  return (
    <Suspense fallback={<SignUpShell />}>
      <SignUpForm />
    </Suspense>
  );
}

function SignUpShell() {
  const t = useTranslations('auth');
  return (
    <AuthShell headline={t('welcomeToMotir')} subhead={t('signUpSubhead')}>
      <div className="flex flex-col gap-5" aria-hidden />
      {/* The notice renders in the Suspense fallback too, so it is present from
          the first paint rather than appearing when the form resolves. It is the
          one element on this card that must never be missable. */}
      <LegalNotice />
    </AuthShell>
  );
}

function SignUpForm() {
  const t = useTranslations('auth');
  const router = useRouter();
  const searchParams = useSearchParams();
  // The post-auth landing: `/home`, the SAME destination sign-in defaults to
  // (`sign-in/page.tsx`). Both credential flows land in one place, and that is
  // now the whole answer to "where does signing in put me" (MOTIR-2921).
  //
  // ⚠️ This line USED to read `/dashboard`, and the comment here defended it:
  // a brand-new account has nothing waiting on it, so Home would have greeted
  // its first visitor with a My-work empty state whose next action (`/ready`)
  // needs a project they do not have — while `/dashboard`'s projects-empty
  // branch offered the one thing that IS next, create your first project. That
  // reasoning was correct, and it named its own expiry: *"if Home ever learns
  // the no-project case, this is the line to revisit."*
  //
  // It has. MOTIR-2761 narrowed `/home` to the ACTIVE PROJECT and gave its
  // no-project branch the shipped `ProjectsEmptyState` — the very component
  // `/dashboard` renders there — so the create-first door is what a
  // project-less actor now sees on Home. `docs/decisions/home-scope.md` §2.2
  // writes down the discriminator (a route a reader is LANDED on gets the
  // create-first door) and §2.3 decides post-auth lands on `/home`
  // unconditionally, naming this line's split as the defect to close.
  //
  // An explicit `?next=` still WINS, exactly as on sign-in.
  const callbackURL = resolvePostAuthDestination({ next: searchParams.get('next') });

  const [step, setStep] = useState<'identity' | 'password'>('identity');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // pageError is seeded from `?error=` once during initial render (see the
  // matching note on sign-in/page.tsx). Avoids the set-state-in-effect lint.
  const [pageError, setPageError] = useState(() =>
    searchParams.get('error') ? t('googleSignUpIncomplete') : '',
  );
  const [emailExists, setEmailExists] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function onContinueIdentity(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPageError('');
    setEmailExists(false);
    if (!email.trim()) return;
    setStep('password');
  }

  async function onCreateAccount(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
        // Better-Auth's user schema requires a non-null `name`. We never
        // ask the user for one (see file-level docstring); derive a
        // sensible default from the email localpart that the user can
        // override later in profile settings.
        name: email.split('@')[0]!,
        callbackURL,
      });
      if (result?.error) {
        // Better-Auth surfaces these as { code, message }. We map the two
        // common ones to inline UI; everything else falls through to the
        // top-of-form alert.
        const code = result.error.code ?? '';
        // Better-Auth uses both `USER_ALREADY_EXISTS` and the more specific
        // `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`; match by message too so
        // an SDK rename doesn't silently degrade the error UI.
        if (
          code.startsWith('USER_ALREADY_EXISTS') ||
          /already exists/i.test(result.error.message ?? '')
        ) {
          setEmailExists(true);
          setStep('identity');
        } else if (code === 'PASSWORD_TOO_SHORT' || /password/i.test(result.error.message ?? '')) {
          setPasswordError(t('passwordTooShort'));
        } else {
          setPageError(t('somethingWentWrong'));
        }
        setSubmitting(false);
        return;
      }
      router.push(callbackURL);
    } catch {
      setPageError(t('somethingWentWrong'));
      setSubmitting(false);
    }
  }

  return (
    <AuthShell headline={t('welcomeToMotir')} subhead={t('signUpSubhead')}>
      {pageError ? <FormAlert>{pageError}</FormAlert> : null}

      {step === 'identity' ? (
        <form onSubmit={onContinueIdentity} className="flex flex-col gap-5" noValidate>
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
            error={emailExists ? t('accountExists') : undefined}
            helperText={emailExists ? undefined : t('emailHelper')}
            autoFocus
          />
          {emailExists ? (
            <p className="-mt-2 font-sans text-sm text-(--el-text)">
              <Link
                href={{ pathname: '/sign-in' }}
                className="font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:underline"
              >
                {t('signInInstead')}
              </Link>
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" className="w-full">
            {t('continue')}
          </Button>
          <FooterLink prompt={t('alreadyHaveAccount')} linkText={t('logIn')} href="/sign-in" />
        </form>
      ) : (
        <form onSubmit={onCreateAccount} className="flex flex-col gap-5" noValidate>
          {/* Identity recap — read-only, click "Edit" to flip back. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex h-(--height-input) w-full items-center gap-2 rounded-(--radius-input) bg-(--el-surface) px-(--spacing-input-x)">
              <Mail className="text-(--el-text-muted) h-5 w-5" aria-hidden />
              <span className="flex-1 truncate font-sans text-sm text-(--el-text)">{email}</span>
            </div>
            <button
              type="button"
              onClick={() => setStep('identity')}
              className="self-start font-sans text-xs text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:underline"
            >
              {t('edit')}
            </button>
          </div>

          <Input
            type={showPassword ? 'text' : 'password'}
            name="new-password"
            autoComplete="new-password"
            placeholder={t('createPassword')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            addonStart={<Lock className="h-5 w-5" aria-hidden />}
            addonEnd={
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
            }
            aria-label={t('password')}
            helperText={passwordError ? undefined : t('atLeast8')}
            error={passwordError || undefined}
            required
            autoFocus
          />

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
            {submitting ? t('creatingAccount') : t('createAccount')}
          </Button>

          <FooterLink prompt={t('alreadyHaveAccount')} linkText={t('logIn')} href="/sign-in" />
        </form>
      )}

      <LegalNotice />
    </AuthShell>
  );
}

/**
 * The agreement notice, at the card FOOT — outside the step branch, so BOTH
 * steps render it (Story 8.4 · Subtask MOTIR-1135 · design
 * `design/auth/legal-agreement.mock.html`, panels 1–3).
 *
 * ⚠️ THE PLACEMENT IS THE FIX, AND IT CLOSES A LIVE DEFECT. MOTIR-1134 put this
 * line inside the `step === 'password'` branch, and `Continue with Google` sits
 * on the step BEFORE it and creates an account outright — so **a person who
 * signed up with Google was never shown the Terms or the Privacy Policy at
 * all.** GDPR Art. 13 owes transparency AT COLLECTION, and for that path
 * collection is step 1. Measured rather than read: `/sign-up` served from
 * `next dev` and driven in Chromium found no notice anywhere in the identity
 * step's DOM. Keep it outside both branches.
 *
 * ⚠️ A PARAGRAPH, NOT A CHECKBOX — and this card is where that was decided.
 * MOTIR-1135's own body assumed a required tick-box; the design rejected it and
 * DRAWS the rejection (panel 4, all three states) so the decision stays
 * checkable:
 *
 *   * Consent is not the lawful basis. The account is Art. 6(1)(b), performance
 *     of a contract — a tick-box is EVIDENCE, not a legal requirement, and the
 *     evidence is the `legal_acceptance` row this form's submit now writes.
 *   * Linear, Vercel, Notion, GitHub and Stripe all state it passively at the
 *     submit control.
 *   * It would add a submit-blocked failure mode to the highest-value control in
 *     the product, in exchange for evidence we already keep.
 *
 * So it takes no focus of its own — it is a paragraph, and only its two links are
 * focusable — and it is LAST in the DOM, which is what keeps `autoFocus` on the
 * email field working for a reader who starts typing immediately.
 *
 * There is exactly ONE line and this is it: MOTIR-1134's `legal.signUpNotice`,
 * kept, moved, and with one word changed (*an account* → *a Motir account*),
 * which is what makes the same string read correctly on step 1 where the Google
 * button is the subject. Do not add a second.
 */
function LegalNotice() {
  const tLegal = useTranslations('legal');
  return (
    <p className="border-t border-(--el-border) pt-4 font-sans text-[13px] text-(--el-text-secondary)">
      {tLegal.rich('signUpNotice', {
        terms: (chunks) => (
          <Link href="/legal/terms" className="text-(--el-link) hover:underline">
            {chunks}
          </Link>
        ),
        privacy: (chunks) => (
          <Link href="/legal/privacy" className="text-(--el-link) hover:underline">
            {chunks}
          </Link>
        ),
      })}
    </p>
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
