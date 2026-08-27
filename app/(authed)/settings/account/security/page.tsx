import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { passkeyService } from '@/lib/services/passkeyService';
import { usersService } from '@/lib/services/usersService';
import {
  TWO_FACTOR_BACKUP_CODE_COUNT,
  TWO_FACTOR_OTP_PERIOD_MINUTES,
  TWO_FACTOR_TOTP_PERIOD_SECONDS,
  TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS,
} from '@/lib/auth/twoFactorConfig';
import { AccountSecurityPanes } from '../_components/AccountSecurityPanes';

// The Security pane of the account-settings area (Story 8.11 · Subtask
// MOTIR-1220) — the `Security › Two-factor authentication` surface, built to
// `design/settings/two-factor.mock.html` + its `design-notes.md` section.
//
// A server component (the gate + the initial reads); `AccountSecurityPanes` is
// the client owner below it, holding the two islands this pane renders —
// `TwoFactorManager` (enrolment, recovery codes, the disable flow) and
// `PasskeyManager` (Story 8.12 · MOTIR-3612). That split is the tokens pane's,
// one door over.
//
// ⚠️ THE STATE IS SHARED, and that is why there is an owner rather than two
// islands rendered side by side: the passkey COUNT decides whether `'passkey'` is
// in `TwoFactorStatusDTO.methods` (MOTIR-3611), which `TwoFactorManager` renders
// in two places while `PasskeyManager` is what changes it. See
// `AccountSecurityPanes`'s header.
//
// ⚠️ NO `loading.tsx`, and this page adds none — `app/(authed)` is a route group
// containing existence-deciding routes (CLAUDE.md). It does not stream: both
// reads are single-row and run in one `Promise.all`.
//
// ── Why the page passes CONSTANTS down ────────────────────────────────────
// The pane STATES numbers the server enforces — ten codes, six digits, a
// 30-second step, 30 days of device trust. They come from
// `lib/auth/twoFactorConfig.ts`, which exists precisely so a client component
// can read them without importing `lib/auth/index.ts` (that file pulls in
// `next/headers` and Prisma and cannot cross the boundary). Passing them as
// props rather than importing them in the island keeps the island's rendered
// copy and the server's behaviour the same value.
//
// ── `hasPassword` is a CAPABILITY, not a preference ───────────────────────
// Every 2FA management action is password-gated by Better-Auth, and that gate is
// CONDITIONAL (`allowPasswordless: true`, MOTIR-1217): a user with a credential
// account is asked, a Google-only user is not, because they have no password to
// be asked for. `usersService.getPasswordCapability` is the same read the
// Profile pane's change-vs-set-password branch already uses — so the step-up
// modal is shown or skipped from one source of truth rather than two.
export default async function AccountSecurityPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings.account.twoFactor');
  const [status, passwordCapability, trustedDevices, passkeys] = await Promise.all([
    twoFactorService.getStatus(session.user.id),
    usersService.getPasswordCapability(session.user.id),
    twoFactorService.listTrustedDevices(session.user.id),
    // ONE added promise, not a second round of awaits: the pane still pays for
    // one round trip's worth of latency rather than two (MOTIR-3612).
    passkeyService.listForUser(session.user.id),
  ]);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('title')}</h2>
        <p className="font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
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
    </div>
  );
}
