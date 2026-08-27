import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { getSession } from '@/lib/auth';
import { safeNextPath } from '@/lib/auth/twoFactorGate';
import {
  TWO_FACTOR_BACKUP_CODE_COUNT,
  TWO_FACTOR_OTP_PERIOD_MINUTES,
  TWO_FACTOR_TOTP_PERIOD_SECONDS,
  TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS,
} from '@/lib/auth/twoFactorConfig';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { passkeyService } from '@/lib/services/passkeyService';
import { usersService } from '@/lib/services/usersService';
import { Pill } from '@/components/ui/Pill';
import { HeldEnrolment } from './_components/HeldEnrolment';
import { SignOutLink } from './_components/SignOutLink';

// The FORCED-ENROLMENT SCREEN (Story MOTIR-1215 · Subtask MOTIR-3648), built to
// `design/auth/two-factor-required.mock.html` — the asset MOTIR-3643 produces.
//
// ⚠️ IT LIVES IN THE `(auth)` GROUP ALTHOUGH THE VISITOR IS SIGNED IN, and that
// is the design decision rather than a filing convenience. `app/(auth)/layout.tsx`
// is a pure frame — the `--el-auth-wash` page, the centred card, the brand
// lockup — and reads NO session, which is exactly why this page can live under
// it without being caught by the gate that sent people here. `/device` is the
// shipped precedent for a signed-in screen in this group.
//
// The framing is also the posture: the person IS signed in but must not be able
// to reach anything, so rendering the app shell — nav, project switcher, palette
// all present but inert — would advertise everything they cannot reach AND mean
// the shell's data was loaded for somebody being held out.
//
// ⚠️ THE GATE CANNOT PROTECT THIS PAGE, SO THE PAGE PROTECTS ITSELF. Two of its
// three gates exist for that reason: an anonymous visitor is bounced to
// `/sign-in` (the group's layout will not do it), and a COMPLIANT visitor is
// sent on to their destination — somebody who types the URL, or who enrols in
// another tab, must not sit on a dead screen.
//
// ⚠️ IT HAS TWO STATES, NOT ONE, AND THE SECOND IS THE ONE EASIEST TO FORGET.
// HELD is the obvious half. SATISFIED — the asset's panel 6, "the return to the
// route they actually asked for" — is what makes the first half survivable: this
// is a Server Component, so it asks `resolveRequirement` once at render, and the
// panes below are a client island that deliberately never `router.refresh()`es.
// Without the satisfied branch AND `HeldEnrolment`'s refresh, a person enrols
// successfully and the screen does not move. They are stuck on a held page, now
// compliant, with no way forward but retyping a URL. The story's verification
// recipe asks for the opposite in step 3: "You land back on the work item you
// asked for."
//
// ⚠️ AND IT DOES NOT WHISK THEM AWAY. A compliant visitor who typed the URL, or
// who just enrolled, gets a screen with a Continue on it — not an instant
// redirect. Recovery codes are offered by the panes below, and a redirect fired
// the moment a credential lands takes the person past them. `required: false` IS
// still an instant redirect: nobody is asking that person anything, so there is
// nothing to show them.
//
// ⚠️ IT MOUNTS THE SHIPPED ENROLMENT SURFACE; IT DOES NOT REBUILD IT.
// `AccountSecurityPanes` is the state OWNER that `settings/account/security`
// renders, holding `TwoFactorManager` and `PasskeyManager` as controlled islands
// with one derivation between them (MOTIR-3612). Mounting the OWNER rather than
// its two children is what keeps that derivation intact — mounting the children
// directly would mean re-deriving `methods` from the passkey list here, which is
// the drift its own header warns about. Both are `'use client'`, import no
// `server-only` module and take everything as props, so they are portable as
// they stand: nothing had to move for this card.

export default async function TwoFactorRequiredPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { next } = await searchParams;
  // ⚠️ VALIDATED, ALWAYS. The value reached the gate from `x-current-path`, a
  // forgeable request header, and then rode a query string a person can edit.
  // An unvalidated redirect target is an open redirect.
  const destination = safeNextPath(next);

  const requirement = await twoFactorPolicyService.resolveRequirement(session.user.id);
  // Nobody is asking this person anything — there is no screen to show them.
  if (!requirement.required) redirect(destination);

  const t = await getTranslations('auth.twoFactorRequired');
  const [status, passwordCapability, trustedDevices, passkeys] = await allSettledOrThrow([
    twoFactorService.getStatus(session.user.id),
    usersService.getPasswordCapability(session.user.id),
    twoFactorService.listTrustedDevices(session.user.id),
    passkeyService.listForUser(session.user.id),
  ]);

  const satisfied = requirement.compliant;

  return (
    <section data-auth-wide className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        {/* ⚠️ NOT `--el-danger` on EITHER branch, and the asset says so outright:
            nothing has gone wrong. Both put the hue in the tint BACKGROUND with
            strong ink, which is also what keeps them AA in both themes. */}
        <Pill severity={satisfied ? 'success' : 'info'} className="self-start">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          {satisfied ? t('satisfiedChip') : t('requiredBy', { tier: requirement.mandatedBy!.name })}
        </Pill>
        <h1 className="font-serif text-3xl font-semibold leading-tight tracking-tight text-(--el-text)">
          {satisfied ? t('satisfiedHeadline') : t('headline')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-base">
          {satisfied
            ? t('satisfiedBody')
            : requirement.mandatedBy!.tier === 'organization'
              ? t('bodyOrganization', { tier: requirement.mandatedBy!.name })
              : t('bodyWorkspace', { tier: requirement.mandatedBy!.name })}
        </p>

        {/* ⚠️ THE RETURN, and the whole reason the path was carried from the
            edge (MOTIR-3652) and validated at the gate (`safeNextPath`). A
            person who clicked a work-item link goes back to THAT work item —
            landing them on a generic dashboard is the failure the design notes
            name outright. A LINK, not a router push, so it is the browser's
            navigation and works with a middle click. */}
        {satisfied ? (
          <Link
            href={destination}
            className="bg-(--el-accent) text-(--el-accent-text) hover:bg-(--el-accent-pressed) focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-background mt-2 inline-flex h-(--height-btn-md) items-center justify-center gap-2 self-start rounded-(--radius-btn) px-(--spacing-btn-x) font-sans text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          >
            {t('continueTo', { destination })}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}
      </header>

      <HeldEnrolment
        initialStatus={status}
        initialPasskeys={passkeys}
        email={session.user.email}
        hasPassword={passwordCapability.hasPassword}
        initialTrustedDevices={trustedDevices}
        backupCodeCount={TWO_FACTOR_BACKUP_CODE_COUNT}
        otpPeriodMinutes={TWO_FACTOR_OTP_PERIOD_MINUTES}
        totpPeriodSeconds={TWO_FACTOR_TOTP_PERIOD_SECONDS}
        trustDeviceDays={Math.round(TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS / 86_400)}
      />

      {/* ⚠️ THE WAY OUT IS NOT OPTIONAL — on every HELD panel, which is what the
          asset requires and what this condition says. Every other route is
          closed to a held person, so a screen with no exit is a trap: somebody
          on a borrowed laptop, or without their phone, must be able to leave
          rather than bounce between a redirect and a screen they cannot
          satisfy. Once they are SATISFIED it is no longer an exit but an
          ordinary sign-out, and it would sit under a Continue competing with
          it — so it goes, and the whole product is open to them again. */}
      {satisfied ? null : (
        <footer className="border-(--el-border) flex flex-col items-start gap-2 border-t pt-(--spacing-md)">
          <SignOutLink label={t('signOut')} />
          <span className="text-(--el-text-secondary) font-sans text-xs">{t('signOutNote')}</span>
        </footer>
      )}
    </section>
  );
}
