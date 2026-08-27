import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ShieldCheck } from 'lucide-react';
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
import { AccountSecurityPanes } from '../../(authed)/settings/account/_components/AccountSecurityPanes';
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
  if (!requirement.required || requirement.compliant) redirect(destination);

  const t = await getTranslations('auth.twoFactorRequired');
  const [status, passwordCapability, trustedDevices, passkeys] = await allSettledOrThrow([
    twoFactorService.getStatus(session.user.id),
    usersService.getPasswordCapability(session.user.id),
    twoFactorService.listTrustedDevices(session.user.id),
    passkeyService.listForUser(session.user.id),
  ]);

  return (
    <section data-auth-wide className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        {/* ⚠️ NOT `--el-danger`, and the asset says so outright: nothing has
            gone wrong. `info` puts the hue in the tint BACKGROUND with strong
            ink, which is also what keeps it AA in both themes. */}
        <Pill severity="info" className="self-start">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          {t('requiredBy', { tier: requirement.mandatedBy!.name })}
        </Pill>
        <h1 className="font-serif text-3xl font-semibold leading-tight tracking-tight text-(--el-text)">
          {t('headline')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-base">
          {requirement.mandatedBy!.tier === 'organization'
            ? t('bodyOrganization', { tier: requirement.mandatedBy!.name })
            : t('bodyWorkspace', { tier: requirement.mandatedBy!.name })}
        </p>
      </header>

      <AccountSecurityPanes
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

      {/* ⚠️ THE WAY OUT IS NOT OPTIONAL. Every other route is closed to this
          person, so a screen with no exit is a trap: somebody on a borrowed
          laptop, or without their phone, must be able to leave rather than
          bounce between a redirect and a screen they cannot satisfy. The asset
          gives this its own panel for exactly that reason. */}
      <footer className="border-(--el-border) flex flex-col items-start gap-2 border-t pt-(--spacing-md)">
        <SignOutLink label={t('signOut')} />
        <span className="text-(--el-text-secondary) font-sans text-xs">{t('signOutNote')}</span>
      </footer>
    </section>
  );
}
