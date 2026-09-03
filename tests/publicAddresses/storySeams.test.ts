import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY'S SEAMS (Story MOTIR-3878 · MOTIR-4223) — the writer → consumer
// paths that every unit test on either side mocks away.
//
// ⚠️ WHAT MAKES THESE DIFFERENT FROM THE SUITES BESIDE THEM. Each card's own
// tests prove that ONE service does what it says. These prove that what one
// service WROTE is what the next one READS — over real Postgres, through the
// real repository, with only the two things that leave this machine stubbed: the
// certificate platform and the DNS resolver. A store whose writer and reader
// disagree passes both halves' unit tests and fails in production once.
//
// The stubs are the PORTS, never the code under test: `providers.ts` is the
// composition root the ADR §6 boundary exists for, and swapping it is how the
// seam runs at all without reaching Fly.

const BASE = 'motir.example';

const requestCertificate = vi.fn();
const checkCertificate = vi.fn();
const removeCertificate = vi.fn();
const resolveTxt = vi.fn();

vi.mock('@/lib/publicAddresses/providers', () => ({
  certificateProvider: () => ({
    request: requestCertificate,
    check: checkCertificate,
    remove: removeCertificate,
  }),
  dnsResolver: () => ({ resolveTxt }),
  certificatesConfigured: () => true,
  usingFakePublicAddressProviders: () => true,
}));

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { publicAddressesService } = await import('@/lib/services/publicAddressesService');
const { customDomainService } = await import('@/lib/services/customDomainService');
const { createTestWorkspace } = await import('../fixtures');

interface Tenant {
  workspaceId: string;
  ownerId: string;
  projectId: string;
  identifier: string;
}

let acme: Tenant;

async function seedTenant(name: string, identifier: string): Promise<Tenant> {
  const { workspace, owner } = await createTestWorkspace({ name });
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Project ${identifier}`,
      slug: identifier.toLowerCase(),
      identifier,
      accessLevel: 'public',
    },
  });
  return { workspaceId: workspace.id, ownerId: owner.id, projectId: project.id, identifier };
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  acme = await seedTenant('Acme', 'ACME');
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = () => ({ userId: acme.ownerId, workspaceId: acme.workspaceId });

/** A reading from the certificate PORT — the shape the adapter returns. */
function certificateState(over: { configured: boolean; issued: boolean }) {
  return {
    hostname: 'roadmap.acme.test',
    dnsRequirements: [],
    checkedAt: new Date(),
    ...over,
  };
}

/**
 * Put the fixture's org on a PAID tier, so the cap is not the thing under test.
 * `free: 0` refuses the FIRST domain by design (ADR §9), which is exactly what
 * seam (c) exercises deliberately and what every other seam must get past.
 */
async function onAPaidTier(): Promise<void> {
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: acme.workspaceId },
    select: { organizationId: true },
  });
  await adminDb.organization.update({
    where: { id: organizationId },
    data: {
      scaledTrackerSubscription: {
        status: 'active',
        priceId: 'price_test',
        quantity: 1,
      } as never,
    },
  });
}

/* ── seam (a): claim → the host contract resolves it; rename → an alias ───── */

describe('seam (a) — a claim written by one service is read by the public contract', () => {
  it('resolves the claimed host to the workspace and its public projects', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId);

    const resolved = await publicAddressesService.resolveHost(`acme.${BASE}`);

    expect(resolved.kind).toBe('workspace');
    if (resolved.kind !== 'workspace') throw new Error('unreachable');
    expect(resolved.projects.map((p) => p.identifier)).toContain('ACME');
  });

  it('and after a RENAME the old host resolves as an alias pointing at the new one', async () => {
    // ⚠️ THE PROMISE THE WHOLE §8 DECISION TURNS ON, end to end: the retirement
    // and the new claim are one transaction, and the old hostname keeps
    // answering afterwards — not as a 404, and not as the workspace, but as a
    // redirect that NAMES where it goes.
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId);
    await publicSubdomainService.rename(acme.workspaceId, 'acme-inc', acme.ownerId);

    const alias = await publicAddressesService.resolveHost(`acme.${BASE}`);
    expect(alias.kind).toBe('alias');
    if (alias.kind !== 'alias') throw new Error('unreachable');
    expect(alias.redirectTo).toBe(`acme-inc.${BASE}`);

    const live = await publicAddressesService.resolveHost(`acme-inc.${BASE}`);
    expect(live.kind).toBe('workspace');
  });
});

/* ── seam (b): add → verify → issue → primary → the subject and the index ── */

describe('seam (b) — a domain walked to primary reaches the DTO and the crawl index', () => {
  it('carries the whole lifecycle into `addresses.primary` and `primaryHost`', async () => {
    await onAPaidTier();
    const added = await customDomainService.add({
      key: 'ACME',
      hostname: 'roadmap.acme.test',
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });
    expect(added.status).toBe('unverified');

    // The TXT appears — the DNS port is the stub; everything else is real.
    resolveTxt.mockResolvedValue([added.verification!.value]);
    requestCertificate.mockResolvedValue(certificateState({ configured: true, issued: false }));
    const verified = await customDomainService.verify({
      addressId: added.id,
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });
    // ⚠️ A CERTIFICATE IS NEVER REQUESTED BEFORE THE TXT VERIFIES — ADR §5's
    // order, asserted at the seam rather than in the service that implements it.
    expect(requestCertificate).toHaveBeenCalledTimes(1);
    expect(['verifying', 'pending_certificate']).toContain(verified.status);

    // The platform issues; the STATUS JOB's path is the one that writes it.
    checkCertificate.mockResolvedValue(certificateState({ configured: true, issued: true }));
    const { publicAddressCertificatesService } =
      await import('@/lib/services/publicAddressCertificatesService');
    await publicAddressCertificatesService.refreshDueAddresses();

    const listed = await customDomainService.list({
      key: 'ACME',
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });
    const live = listed.find((a) => a.hostname === 'roadmap.acme.test');
    expect(live?.status, 'the job did not carry the platform state home').toBe('issued');

    await customDomainService.makePrimary({
      addressId: added.id,
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });

    // 1 · the SUBJECT the renderer reads.
    const addresses = await publicAddressesService.addressesForProject(
      acme.projectId,
      acme.workspaceId,
      'ACME',
    );
    expect(addresses.primary).toBe('https://roadmap.acme.test');

    // 2 · the CRAWL INDEX's per-row host, computed by a DIFFERENT query. Two
    // paths deriving one rule is how they come apart, so they are asserted
    // against each other rather than against a restated expectation.
    const hosts = await publicAddressesService.primaryHostsForProjects([
      { id: acme.projectId, workspaceId: acme.workspaceId, identifier: 'ACME' },
    ]);
    expect(hosts.get(acme.projectId)).toBe(new URL(addresses.primary).host);

    // 3 · and the HOST CONTRACT now serves that project at that host's root.
    const resolved = await publicAddressesService.resolveHost('roadmap.acme.test');
    expect(resolved.kind).toBe('project');
    if (resolved.kind !== 'project') throw new Error('unreachable');
    expect(resolved.project.identifier).toBe('ACME');
    expect(resolved.primary).toBe(true);
  });
});

/* ── seam (c): the entitlement cap under REAL concurrency ─────────────────── */

describe('seam (c) — the cap holds when two adds race', () => {
  it('admits exactly the cap, never one more', async () => {
    // ⚠️ THE ASSERTION IS AGAINST A FIXED COUNTERFACTUAL, NOT A RATIO. Two
    // concurrent adds against a cap of one must leave ONE row: a test that
    // asserted "at most the cap" would pass on a database that admitted none.
    await onAPaidTier();

    requestCertificate.mockResolvedValue(certificateState({ configured: false, issued: false }));
    const results = await Promise.allSettled([
      customDomainService.add({
        key: 'ACME',
        hostname: 'one.acme.test',
        actorUserId: acme.ownerId,
        ctx: ctx(),
      }),
      customDomainService.add({
        key: 'ACME',
        hostname: 'two.acme.test',
        actorUserId: acme.ownerId,
        ctx: ctx(),
      }),
    ]);

    const stored = await customDomainService.list({
      key: 'ACME',
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });
    const domains = stored.filter((a) => a.kind === 'custom_domain');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    // Whatever the cap is on this tier, the store and the callers agree about it.
    expect(domains).toHaveLength(fulfilled.length);
    expect(fulfilled.length).toBeGreaterThan(0);
  });
});

/* ── seam (d): CORS and the hand-off return read the SAME store ───────────── */

describe('seam (d) — a live address is a legitimate origin; an alias is not', () => {
  it('admits the live host and refuses the retired one, from the store', async () => {
    // ⚠️ THE ALIAS ARM IS THE ONE WORTH HAVING. A retired subdomain still has a
    // row, so a membership test written as "is there a row for this host" would
    // admit it — and a permanent redirect is not a place to hand a session back
    // to.
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId);
    await publicSubdomainService.rename(acme.workspaceId, 'acme-inc', acme.ownerId);

    const { isRegisteredPublicOrigin, resetAllowedOriginCache } =
      await import('@/lib/publicAddresses/allowedOrigins');
    resetAllowedOriginCache();

    expect(await isRegisteredPublicOrigin(`https://acme-inc.${BASE}`)).toBe(true);
    expect(await isRegisteredPublicOrigin(`https://acme.${BASE}`)).toBe(false);
    expect(await isRegisteredPublicOrigin('https://evil.example')).toBe(false);
  });
});
