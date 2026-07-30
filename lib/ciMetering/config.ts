// The meter's configuration seam (Story MOTIR-1775 · MOTIR-1896) — WHICH GitHub
// org Motir pays the Actions bill for, and the credential the monthly
// reconciliation reads with.
//
// `docs/decisions/ci-minutes-allowance.md` §5.1 fixes the gate: a completed
// workflow run is metered **if and only if its repository's owner login is
// Motir's provisioning org** (`GITHUB_FALLBACK_ORG`, provisioned by MOTIR-1779).
// That login is the right key because it is exactly what GitHub bills on —
// private-repo Actions minutes bill to the repository owner, so "does Motir pay
// for this run?" and "is the owner Motir's org?" are the SAME question. A
// project column (`Project.repoSetOwnership`) is a good reporting signal but the
// wrong gate: it is SET-level, so it cannot express a set holding both a created
// row and a connect-existing row, and it would drift on any path that moves a
// repo without updating it. The owner cannot drift — it IS the billing fact.
//
// ⚠️ UNSET is a first-class, correct state, not a misconfiguration to throw on.
// MOTIR-1779 (provision the org + its credential) is a `manual` subtask that has
// not run yet, and a self-hosted build never has one at all (§8.5: off-cloud
// there is no meter, no pool, no overage and no refusal). With no org
// configured, NOTHING is Motir-owned, so the gate correctly meters nothing and
// the whole path is inert — which is also exactly what it must do the moment a
// repo is transferred away (§5.5).

import { isCloudBilling } from '@/lib/billing/availability';

/**
 * Motir's provisioning GitHub org login (MOTIR-1779; working login
 * `motir-projects`), or null when unset. Compared case-INSENSITIVELY by
 * `isMotirOwnedRepo` — GitHub logins are case-insensitive, and a webhook payload
 * echoes the owner's stored casing, which an operator's env value need not match.
 */
export function provisioningOrgLogin(): string | null {
  const raw = process.env['GITHUB_FALLBACK_ORG'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The §5.1 gate: does GitHub bill MOTIR for this repository's Actions minutes?
 *
 * `ownerLogin` MUST come from the RUN's own payload, never from the stored
 * `GithubRepo` mirror — §5.5. The mirror may still hold the pre-transfer owner
 * until a webhook reconciles it, so reading it would keep metering a repo the
 * user has already taken over (MOTIR-711 / 9.3.7). Taking the owner from the run
 * makes the transfer edge fall out with NO special handling: the owner changes
 * at the transfer itself, so a run completing afterwards simply fails the gate.
 */
export function isMotirOwnedRepo(ownerLogin: string | null | undefined): boolean {
  const org = provisioningOrgLogin();
  if (!org || typeof ownerLogin !== 'string') return false;
  return ownerLogin.trim().toLowerCase() === org.toLowerCase();
}

/**
 * Is the meter active at all? Off-cloud (`MOTIR_CLOUD` unset/false) it is inert
 * by §8.5 — a self-hoster's Actions bill is their own and Motir never hosts
 * their repos — and with no provisioning org configured there is nothing that
 * could pass §5.1's gate.
 */
export function isCiMeteringEnabled(): boolean {
  return isCloudBilling() && provisioningOrgLogin() !== null;
}

/**
 * The credential the MONTHLY RECONCILIATION reads GitHub's enhanced-billing
 * usage endpoint with (§5.8), or null when unset.
 *
 * Deliberately SEPARATE from the App installation token the meter itself uses:
 * `GET /organizations/{org}/settings/billing/usage` is an ORG-level billing read
 * that an installation token cannot perform. MOTIR-1779 owns provisioning it
 * alongside the org. Unset → the reconciliation job no-ops with a logged reason
 * rather than failing; the webhook meter is the operational path and does not
 * depend on this at all.
 */
export function billingUsageToken(): string | null {
  const raw = process.env['GITHUB_BILLING_TOKEN'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The tolerance the meter's own sum is allowed to drift from GitHub's billing
 * report before the reconciliation logs it as a discrepancy (§5.8 asks this card
 * to STATE one). 5% of the reported minutes, floored at 5 Linux-equivalent
 * minutes so a tiny month does not alarm on rounding alone.
 *
 * Why 5%: the meter sums `ceil()` per JOB from the jobs API while GitHub's
 * report aggregates per SKU/repo/day, so small divergence is expected from
 * rounding and day-boundary placement alone — but a systematic error (a missed
 * webhook, an unpriced runner, a re-run counted once) moves it well past this.
 * Drift is LOGGED, never silently trusted in either direction: the webhook path
 * is the operational meter, the billing report is the audit.
 */
export const RECONCILIATION_TOLERANCE_FRACTION = 0.05;
export const RECONCILIATION_TOLERANCE_FLOOR_MINUTES = 5;
