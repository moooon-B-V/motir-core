import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY-LEVEL RELEASE GATE — Story MOTIR-4451 · Subtask MOTIR-4456.
//
// ⚠️ WHAT MAKES THIS NOT A SECOND COPY OF `publicSubdomainService.test.ts`.
// That suite is MOTIR-4454's per-card floor and it exercises the SERVICE: it
// calls `publicSubdomainService.release()` directly, with the workspace context
// the service opens for itself. This file drives the same behaviour **through
// the ROUTE**, so what is under test is the assembly — the handler, the service,
// both repositories, the RLS binding a REQUEST establishes, and the address
// resolution — agreeing with each other. Several assertions read alike and none
// of them is redundant: a service can be correct while the route mis-maps its
// error, binds the wrong context, or leaves `GET` answering the old shape.
//
// Real Postgres throughout, per the repo convention: the transaction IS the
// thing under test, so a mocked repository standing in for it would assert the
// fixture rather than the code.
//
// We stub ONLY `getWorkspaceContext` — the session + active-workspace resolver
// the routes read, which the test environment cannot supply (no cookies). The
// mock is PARTIAL (`importOriginal`), so the real `withWorkspaceContext` — the
// RLS-binding transaction every service call below depends on — is preserved
// untouched. Same exception `tests/ready/ready-routes.test.ts` takes, for the
// same reason.

const ctxRef = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

// ⚠️ THE CERTIFICATE PROVIDER, SPIED SO ITS SILENCE IS ASSERTABLE. The nearest
// neighbour to `release` is `customDomainService.remove`, which withdraws a
// certificate; a workspace subdomain is covered by the wildcard `*.<base>`
// (ADR §6), so claiming one issues nothing and releasing one withdraws nothing.
const { certificateProviderSpy } = vi.hoisted(() => ({ certificateProviderSpy: vi.fn() }));
vi.mock('@/lib/publicAddresses/certificateProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  certificateProvider: certificateProviderSpy,
}));

const { db } = await import('@/lib/db');
const { GET, PUT, DELETE } =
  await import('@/app/api/workspaces/[workspaceId]/public-subdomain/route');
const { publicAddressesService } = await import('@/lib/services/publicAddressesService');
const { publicHostnameReservationRepository } =
  await import('@/lib/repositories/publicHostnameReservationRepository');
const { hostnameReservationHash } = await import('@/lib/publicAddresses/hostnameReservation');
const { publicSiteOrigin, publicProjectPath } = await import('@/lib/publicProjects/urls');
const { createTestWorkspace, createTestUser } = await import('../fixtures');

const BASE = 'motir.example';
const ORIGIN = 'https://app.motir.co';

interface Fixture {
  workspaceId: string;
  ownerId: string;
  projectId: string;
  identifier: string;
}

let fx: Fixture;

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
  // ⚠️ `accessLevel: 'public'`. `addressesForProject` reads the address rows
  // through the `db` SINGLETON, gated by `public_address_public_read` — on a
  // private project that read returns EMPTY and the service answers the
  // `motir.co` fallback, which is the same value a correct release produces. A
  // private fixture would make the released half pass for the wrong reason.
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Roadmap',
      slug: 'roadmap',
      identifier: 'ROADMAP',
      accessLevel: 'public',
    },
  });
  fx = {
    workspaceId: workspace.id,
    ownerId: owner.id,
    projectId: project.id,
    identifier: project.identifier,
  };
  ctxRef.current = { userId: owner.id, workspaceId: workspace.id };
  certificateProviderSpy.mockClear();
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
  ctxRef.current = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const params = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) });

function req(method: string, body?: unknown): Request {
  return new Request(`${ORIGIN}/api/workspaces/x/public-subdomain`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Claim through the ROUTE, then rename through it — the assembled setup. */
async function claimAndRename(...labels: readonly string[]): Promise<void> {
  for (const label of labels) {
    const res = await PUT(req('PUT', { label }), params(fx.workspaceId));
    expect([200, 201]).toContain(res.status);
  }
}

async function addressRows() {
  return adminDb.publicAddress.findMany({
    where: { workspaceId: fx.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
}

async function reservedHashes(): Promise<string[]> {
  const rows = await adminDb.publicHostnameReservation.findMany({
    where: { retiredFromWorkspaceId: fx.workspaceId },
  });
  return rows.map((r) => r.hostnameHash).sort();
}

describe('the release, driven through DELETE', () => {
  it('answers 204 with no body, takes the live label AND both aliases, and reserves each', async () => {
    await claimAndRename('acme', 'acme-inc', 'acme-ltd');
    expect(await addressRows()).toHaveLength(3);

    const res = await DELETE(req('DELETE'), params(fx.workspaceId));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    expect(
      await addressRows(),
      'releasing only the live label would leave aliases 301ing to a host that no longer resolves',
    ).toHaveLength(0);
    expect(await reservedHashes()).toEqual(
      [`acme.${BASE}`, `acme-inc.${BASE}`, `acme-ltd.${BASE}`].map(hostnameReservationHash).sort(),
    );
  });

  it('RESERVES BEFORE IT DELETES — a failing reserve leaves every row standing', async () => {
    // The assembled form of MOTIR-4454's ordering test: the failure is driven
    // from inside a real request, so it also proves the route does not swallow
    // it into a 2xx. A release that committed the delete and lost the reserve
    // would hand the label back to the global namespace — §8's exact prohibition
    // — and there is no repair, because the row that knew the hostname is gone.
    await claimAndRename('acme', 'acme-inc');
    const boom = new Error('reserveMany exploded');
    vi.spyOn(publicHostnameReservationRepository, 'reserveMany').mockRejectedValueOnce(boom);

    await expect(DELETE(req('DELETE'), params(fx.workspaceId))).rejects.toBe(boom);

    expect(await addressRows()).toHaveLength(2);
    expect(await reservedHashes()).toEqual([]);
  });

  it('leaves a CUSTOM DOMAIN untouched — still issued, and still the promoted primary', async () => {
    await claimAndRename('acme');
    const custom = await adminDb.publicAddress.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'custom_domain',
        hostname: 'roadmap.acme.example',
        status: 'issued',
      },
    });
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { primaryAddressId: custom.id },
    });

    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);

    const rows = await addressRows();
    expect(rows.map((r) => r.kind)).toEqual(['custom_domain']);
    expect(rows[0]?.status).toBe('issued');
    expect(
      (await adminDb.project.findUnique({ where: { id: fx.projectId } }))?.primaryAddressId,
      'a promoted custom domain stays the canonical — release changes nothing for it',
    ).toBe(custom.id);
    expect(
      await adminDb.publicHostnameReservation.count({
        where: { hostnameHash: hostnameReservationHash('roadmap.acme.example') },
      }),
      "reserving a name we do not own is a hostage, not a protection (`reservesItsHostname`'s own reason)",
    ).toBe(0);
  });

  it('makes NO certificate-provider call — the wildcard issued nothing to withdraw', async () => {
    await claimAndRename('acme', 'acme-inc');
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);
    expect(certificateProviderSpy).not.toHaveBeenCalled();
  });
});

describe('what the rest of the system then says — through the SERVICES, never row reads', () => {
  it('returns the projects to the motir.co path, and reports no host for them', async () => {
    // A row read would pass while the resolution disagreed, and the resolution
    // is the thing a visitor meets.
    await claimAndRename('acme');
    expect(
      (
        await publicAddressesService.addressesForProject(
          fx.projectId,
          fx.workspaceId,
          fx.identifier,
        )
      ).primary,
    ).toBe(`https://acme.${BASE}/${fx.identifier}`);

    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);

    const after = await publicAddressesService.addressesForProject(
      fx.projectId,
      fx.workspaceId,
      fx.identifier,
    );
    expect(after.primary, "ADR §7's default-primary table takes its first row again").toBe(
      `${publicSiteOrigin()}${publicProjectPath(fx.identifier)}`,
    );
    expect(after.alternates).toEqual([]);
    expect(
      await publicAddressesService.primaryHostsForProjects([
        { id: fx.projectId, workspaceId: fx.workspaceId, identifier: fx.identifier },
      ]),
      'no host means the per-host sitemap filter matches this project on motir.co again',
    ).toEqual(new Map());
  });
});

describe('the reservation doing its job, through PUT', () => {
  it('refuses a re-claim of the released LIVE label and of a released ALIAS label', async () => {
    // The ALIAS case is the one a kind-filter mistake would let through.
    await claimAndRename('acme', 'acme-inc');
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);

    for (const label of ['acme-inc', 'acme']) {
      const other = await createTestWorkspace({ name: `Rival ${label}` });
      ctxRef.current = { userId: other.owner.id, workspaceId: other.workspace.id };
      const res = await PUT(req('PUT', { label }), params(other.workspace.id));
      expect(res.status, `${label} must stay unclaimable for ever`).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'HOSTNAME_TAKEN' });
    }
  });

  it('leaves a DIFFERENT label claimable, so the refusal is specific and not a lock', async () => {
    await claimAndRename('acme');
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);
    const other = await createTestWorkspace({ name: 'Rival' });
    ctxRef.current = { userId: other.owner.id, workspaceId: other.workspace.id };
    expect((await PUT(req('PUT', { label: 'acme-two' }), params(other.workspace.id))).status).toBe(
      201,
    );
  });
});

describe('the route contract, and the two verbs it joins', () => {
  it('answers 404 when nothing is claimed — NOT the rename path 409', async () => {
    // Two typed errors, two statuses, one mapping each: a DELETE names a
    // resource, so absent is 404; a PUT that renames refuses a premise.
    const res = await DELETE(req('DELETE'), params(fx.workspaceId));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'SUBDOMAIN_NOT_FOUND' });
  });

  it('gives a member without address management the SAME refusal PUT gives', async () => {
    await claimAndRename('acme');
    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    ctxRef.current = { userId: member.id, workspaceId: fx.workspaceId };

    const del = await DELETE(req('DELETE'), params(fx.workspaceId));
    const put = await PUT(req('PUT', { label: 'acme-inc' }), params(fx.workspaceId));
    expect(del.status).toBe(403);
    expect(put.status).toBe(403);
    expect(await del.json()).toMatchObject({ code: 'SUBDOMAIN_FORBIDDEN' });
    expect(await addressRows(), 'a refused release deletes nothing').toHaveLength(1);
  });

  it('answers a NON-MEMBER with the no-existence-leak 404, and releases nothing', async () => {
    // RLS + the membership gate together: the whole path runs bound, so a member
    // of another workspace cannot reach this one's addresses at all.
    await claimAndRename('acme');
    const stranger = await createTestUser();
    ctxRef.current = { userId: stranger.id, workspaceId: fx.workspaceId };
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(404);
    expect(await addressRows()).toHaveLength(1);
  });

  it('leaves GET and PUT behaving exactly as before — this is the only place a regression shows', async () => {
    const claim = await PUT(req('PUT', { label: 'acme' }), params(fx.workspaceId));
    expect(claim.status).toBe(201);
    expect(await claim.json()).toMatchObject({ hostname: `acme.${BASE}`, aliases: [] });

    const rename = await PUT(req('PUT', { label: 'acme-inc' }), params(fx.workspaceId));
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({
      hostname: `acme-inc.${BASE}`,
      aliases: [{ hostname: `acme.${BASE}` }],
    });

    const read = await GET(req('GET'), params(fx.workspaceId));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ hostname: `acme-inc.${BASE}` });

    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);
    const afterRelease = await GET(req('GET'), params(fx.workspaceId));
    expect(afterRelease.status).toBe(200);
    expect(await afterRelease.json(), 'the pane reads back as unclaimed').toBeNull();
  });
});

describe('the rename cap after a release (ADR §8 Amendment 2)', () => {
  it('does NOT reset — a fresh claim starts from what is left, end to end', async () => {
    // Left to the default, `renamesLeft` is derived from alias ROWS and a release
    // deletes them, which would make claim → rename ×5 → release an unbounded
    // burn of names out of a shared namespace. Asserted through the route so the
    // number the PANE receives is the one under test.
    await claimAndRename('a-one', 'a-two');
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);

    const reclaim = await PUT(req('PUT', { label: 'b-one' }), params(fx.workspaceId));
    expect(reclaim.status).toBe(201);
    expect(
      await reclaim.json(),
      'two names were burnt — the live label AND its alias — so two of the five are spent',
    ).toMatchObject({ renamesLeft: 3 });
  });
});
