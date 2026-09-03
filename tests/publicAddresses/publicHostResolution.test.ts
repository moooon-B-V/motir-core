import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Host resolution — Story MOTIR-3878 · Subtask MOTIR-4217.
//
// The producer end of the integration `motir-marketing`'s router consumes. Two
// properties are worth more than the rest and are asserted first in their
// sections: that each of the three shapes RESOLVES, and that everything else
// refuses IDENTICALLY. A resolver that refused everything would pass every
// denial test ever written.

const { db } = await import('@/lib/db');
const { publicAddressesService, PublicHostNotFoundError, normaliseHost } =
  await import('@/lib/services/publicAddressesService');
const { PublicAddressesUnavailableError } = await import('@/lib/publicAddresses/errors');
const { createTestWorkspace } = await import('../fixtures');

const BASE = 'motir.example';

interface Tenant {
  workspaceId: string;
  ownerId: string;
  projectId: string;
  identifier: string;
}

let host: Tenant;

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  host = await seedTenant('acme', 'ACME', 'public');
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('normaliseHost — refuses rather than repairs', () => {
  it('accepts a bare hostname and strips a port', () => {
    expect(normaliseHost('acme.motir.example')).toBe('acme.motir.example');
    expect(normaliseHost('ACME.Motir.Example')).toBe('acme.motir.example');
    expect(normaliseHost('acme.motir.example:443')).toBe('acme.motir.example');
  });

  it('refuses anything that is not a hostname', () => {
    // Salvaging a hostile value into "something nearby" is trusting it a
    // little — the argument `returnTarget.ts` makes at length, one surface over.
    for (const bad of [
      'https://acme.motir.example',
      'acme.motir.example/path',
      'acme.motir.example@evil.test',
      'acme motir example',
      '',
      '   ',
      'localhost',
      '-acme.motir.example',
      '..',
    ]) {
      expect(normaliseHost(bad), bad).toBeNull();
    }
  });
});

describe('the three shapes that RESOLVE', () => {
  it('a workspace subdomain lists that workspace’s public projects', async () => {
    await seedSubdomain(host, `acme.${BASE}`);
    const r = await publicAddressesService.resolveHost(`acme.${BASE}`);
    expect(r.kind).toBe('workspace');
    if (r.kind !== 'workspace') throw new Error('narrowing');
    expect(r.workspace.name).toBe('Acme');
    expect(r.projects.map((p) => p.identifier)).toEqual(['ACME']);
  });

  it('a retired subdomain reports where to redirect', async () => {
    // The ADR §8 promise made observable to a visitor rather than merely true
    // in the database.
    const live = await seedSubdomain(host, `old.${BASE}`);
    await adminDb.publicAddress.update({
      where: { id: live.id },
      data: { kind: 'workspace_subdomain_alias', status: 'alias' },
    });
    await seedSubdomain(host, `acme.${BASE}`);

    const r = await publicAddressesService.resolveHost(`old.${BASE}`);
    expect(r).toEqual({ kind: 'alias', redirectTo: `acme.${BASE}` });
  });

  it('an ISSUED customer domain names one project, and reports whether it is primary', async () => {
    const addr = await seedCustomDomain(host, 'roadmap.acme.test', 'issued');
    const before = await publicAddressesService.resolveHost('roadmap.acme.test');
    expect(before).toMatchObject({
      kind: 'project',
      project: { identifier: 'ACME' },
      primary: false,
    });

    await adminDb.project.update({
      where: { id: host.projectId },
      data: { primaryAddressId: addr.id },
    });
    const after = await publicAddressesService.resolveHost('roadmap.acme.test');
    expect(after).toMatchObject({ primary: true });
  });

  it('a port on the Host header does not change the answer', async () => {
    await seedSubdomain(host, `acme.${BASE}`);
    await expect(publicAddressesService.resolveHost(`acme.${BASE}:443`)).resolves.toMatchObject({
      kind: 'workspace',
    });
  });
});

describe('everything else refuses IDENTICALLY', () => {
  // ⚠️ The point is not that each refuses — it is that they refuse the SAME
  // way. A caller able to tell "no such tenant" from "a tenant exists but is
  // not serving yet" is a caller for whom walking hostnames is worth the
  // trouble.
  it('an unknown host', async () => {
    await expect(publicAddressesService.resolveHost(`nobody.${BASE}`)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('the BASE domain itself', async () => {
    await expect(publicAddressesService.resolveHost(BASE)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('motir.co, which is not a tenant address at all', async () => {
    await expect(publicAddressesService.resolveHost('motir.co')).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('a customer domain in EVERY non-issued status', async () => {
    // One row, walked through the six states that do not serve. A domain that
    // is merely half-configured must not advertise itself.
    const addr = await seedCustomDomain(host, 'pending.acme.test', 'unverified');
    for (const status of [
      'unverified',
      'verifying',
      'pending_certificate',
      'failed',
      'expired',
      'revoked',
    ] as const) {
      await adminDb.publicAddress.update({ where: { id: addr.id }, data: { status } });
      await expect(
        publicAddressesService.resolveHost('pending.acme.test'),
        status,
      ).rejects.toBeInstanceOf(PublicHostNotFoundError);
    }
  });

  it('a subdomain whose workspace holds NO public project', async () => {
    // The RLS public arm is what refuses this, not a check in the service —
    // the row is simply not visible to an unbound read.
    const priv = await seedTenant('priv', 'PRIV', 'limited');
    await seedSubdomain(priv, `priv.${BASE}`);
    await expect(publicAddressesService.resolveHost(`priv.${BASE}`)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('a customer domain whose project is not public', async () => {
    const priv = await seedTenant('priv2', 'PRIV2', 'private');
    await seedCustomDomain(priv, 'secret.acme.test', 'issued');
    await expect(publicAddressesService.resolveHost('secret.acme.test')).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('OFF-CLOUD, every host — the capability is absent, not hidden', async () => {
    await seedSubdomain(host, `acme.${BASE}`);
    delete process.env['MOTIR_CLOUD'];
    await expect(publicAddressesService.resolveHost(`acme.${BASE}`)).rejects.toBeInstanceOf(
      PublicAddressesUnavailableError,
    );
  });
});

describe('addressesForProject — the ADR §7 default rule', () => {
  it('no address at all → the motir.co URL is primary, and it is never empty', async () => {
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect(a.primary).toContain('/p/ACME');
    expect(a.alternates).toEqual([]);
  });

  it('a subdomain claimed → the subdomain PATH is primary, motir.co becomes an alternate', async () => {
    await seedSubdomain(host, `acme.${BASE}`);
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect(a.primary).toBe(`https://acme.${BASE}/p/ACME`);
    expect(a.alternates.some((u) => u.includes('/p/ACME'))).toBe(true);
    expect(a.alternates).not.toContain(a.primary);
  });

  it('a custom domain PROMOTED → it wins over the subdomain', async () => {
    await seedSubdomain(host, `acme.${BASE}`);
    const addr = await seedCustomDomain(host, 'roadmap.acme.test', 'issued');
    await adminDb.project.update({
      where: { id: host.projectId },
      data: { primaryAddressId: addr.id },
    });
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect(a.primary).toBe('https://roadmap.acme.test');
    // Both the subdomain path and the motir.co URL are alternates that redirect.
    expect(a.alternates).toContain(`https://acme.${BASE}/p/ACME`);
  });

  it('an ADDED-but-not-issued custom domain is neither primary nor an alternate', async () => {
    // It does not serve, so listing it would put a dead URL in a sitemap.
    await seedCustomDomain(host, 'pending.acme.test', 'pending_certificate');
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect([a.primary, ...a.alternates].some((u) => u.includes('pending.acme.test'))).toBe(false);
  });

  it('an ALIAS is never listed — it is a redirect, not an address', async () => {
    const live = await seedSubdomain(host, `old.${BASE}`);
    await adminDb.publicAddress.update({
      where: { id: live.id },
      data: { kind: 'workspace_subdomain_alias', status: 'alias' },
    });
    await seedSubdomain(host, `acme.${BASE}`);
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect([a.primary, ...a.alternates].some((u) => u.includes(`old.${BASE}`))).toBe(false);
  });

  it('another project’s custom domain never leaks into this project’s addresses', async () => {
    const other = await adminDb.project.create({
      data: {
        workspaceId: host.workspaceId,
        name: 'Other',
        slug: 'other',
        identifier: 'OTHER',
        accessLevel: 'public',
      },
    });
    await adminDb.publicAddress.create({
      data: {
        workspaceId: host.workspaceId,
        projectId: other.id,
        hostname: 'other.acme.test',
        kind: 'custom_domain',
        status: 'issued',
      },
    });
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect([a.primary, ...a.alternates].some((u) => u.includes('other.acme.test'))).toBe(false);
  });
});

describe('primaryHostsForProjects — the batched crawl read', () => {
  it('agrees with addressesForProject, project by project', async () => {
    // Two paths computing one rule is how they come apart. Asserted against
    // each other rather than against a restated expectation.
    await seedSubdomain(host, `acme.${BASE}`);
    const map = await publicAddressesService.primaryHostsForProjects([
      { id: host.projectId, workspaceId: host.workspaceId, identifier: 'ACME' },
    ]);
    const single = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect(map.get(host.projectId)).toBe(new URL(single.primary).host);
  });

  it('is empty for a project with no claimed address, so the caller falls back', async () => {
    const map = await publicAddressesService.primaryHostsForProjects([
      { id: host.projectId, workspaceId: host.workspaceId, identifier: 'ACME' },
    ]);
    expect(map.has(host.projectId)).toBe(false);
  });

  it('handles an empty input without touching the database', async () => {
    await expect(publicAddressesService.primaryHostsForProjects([])).resolves.toEqual(new Map());
  });
});

// ── fixtures ───────────────────────────────────────────────────────────────

function seedSubdomain(t: Tenant, hostname: string) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId: t.workspaceId,
      hostname,
      kind: 'workspace_subdomain',
      status: 'active',
    },
  });
}

function seedCustomDomain(
  t: Tenant,
  hostname: string,
  status: 'unverified' | 'issued' | 'pending_certificate',
) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      hostname,
      kind: 'custom_domain',
      status,
      verificationToken: `motir-verify-${hostname}`,
    },
  });
}

async function seedTenant(
  tag: string,
  identifier: string,
  accessLevel: 'public' | 'limited' | 'private',
): Promise<Tenant> {
  const { workspace, owner } = await createTestWorkspace({ name: tag === 'acme' ? 'Acme' : tag });
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Project ${identifier}`,
      slug: identifier.toLowerCase(),
      identifier,
      accessLevel,
    },
  });
  return {
    workspaceId: workspace.id,
    ownerId: owner.id,
    projectId: project.id,
    identifier,
  };
}
