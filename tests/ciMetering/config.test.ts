import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  billingUsageToken,
  isCiMeteringEnabled,
  isMotirOwnedRepo,
  provisioningOrgLogin,
} from '@/lib/ciMetering/config';

// The meter's gate + configuration (Story MOTIR-1775 · MOTIR-1896) —
// `docs/decisions/ci-minutes-allowance.md` §5.1 (who GitHub bills) and §8.5
// (self-host is inert).

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('provisioningOrgLogin', () => {
  it('reads the configured org login', () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    expect(provisioningOrgLogin()).toBe('motir-projects');
  });

  it('treats unset and blank as UNCONFIGURED — a normal state, not an error', () => {
    // MOTIR-1779 (provision the org) has not run yet, and a self-host build never
    // has one. Throwing here would make the ordinary case an exception.
    vi.stubEnv('GITHUB_FALLBACK_ORG', undefined);
    expect(provisioningOrgLogin()).toBeNull();
    vi.stubEnv('GITHUB_FALLBACK_ORG', '   ');
    expect(provisioningOrgLogin()).toBeNull();
  });
});

describe('isMotirOwnedRepo — the §5.1 gate', () => {
  it('matches Motir’s provisioning org', () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    expect(isMotirOwnedRepo('motir-projects')).toBe(true);
  });

  it('matches case-insensitively, as GitHub logins are', () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'Motir-Projects');
    expect(isMotirOwnedRepo('motir-projects')).toBe(true);
    expect(isMotirOwnedRepo('MOTIR-PROJECTS')).toBe(true);
  });

  it('REJECTS a repo in someone else’s account — Motir never bought that compute', () => {
    // The connect-existing case (§5.4): GitHub bills the user directly, so
    // metering it would charge for compute Motir was never billed for.
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    expect(isMotirOwnedRepo('some-user')).toBe(false);
    expect(isMotirOwnedRepo('motir-projects-fork')).toBe(false);
  });

  it('rejects everything when no org is configured', () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', undefined);
    expect(isMotirOwnedRepo('motir-projects')).toBe(false);
  });

  it('rejects a missing owner rather than throwing', () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    expect(isMotirOwnedRepo(null)).toBe(false);
    expect(isMotirOwnedRepo(undefined)).toBe(false);
  });
});

describe('isCiMeteringEnabled', () => {
  it('is ON only on cloud WITH a provisioning org', () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    expect(isCiMeteringEnabled()).toBe(true);
  });

  it('is OFF self-hosted, even with an org configured (§8.5)', () => {
    // A self-hoster's Actions bill is their own, and Motir never hosts their repos.
    vi.stubEnv('MOTIR_CLOUD', 'false');
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    expect(isCiMeteringEnabled()).toBe(false);
  });

  it('is OFF on cloud with no provisioning org — nothing could pass the gate', () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', undefined);
    expect(isCiMeteringEnabled()).toBe(false);
  });
});

describe('billingUsageToken', () => {
  it('reads the org-billing credential when set', () => {
    vi.stubEnv('GITHUB_BILLING_TOKEN', 'ghp_audit');
    expect(billingUsageToken()).toBe('ghp_audit');
  });

  it('is null when unset — the operational meter does not depend on it', () => {
    vi.stubEnv('GITHUB_BILLING_TOKEN', undefined);
    expect(billingUsageToken()).toBeNull();
    vi.stubEnv('GITHUB_BILLING_TOKEN', '  ');
    expect(billingUsageToken()).toBeNull();
  });
});
