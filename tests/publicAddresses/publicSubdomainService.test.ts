import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The workspace-subdomain service — Story MOTIR-3878 · Subtask MOTIR-4215.
// Real Postgres throughout (the no-mocks rule); the only toggles are the
// `MOTIR_CLOUD` and `MOTIR_PUBLIC_TENANT_DOMAIN` env vars.

// ⚠️ THE CERTIFICATE PROVIDER IS MOCKED SO A RELEASE'S SILENCE IS ASSERTABLE
// (MOTIR-4454). This service imports nothing from that module today, which is
// exactly the property worth pinning: the nearest neighbour to `release` is
// `customDomainService.remove`, which DOES withdraw a certificate, and a
// subdomain is covered by the wildcard `*.<base>` so there is nothing to
// withdraw. If somebody later copies that shape in, the assertion fires instead
// of Fly answering a question about a hostname it never certificated.
const { certificateProviderSpy } = vi.hoisted(() => ({ certificateProviderSpy: vi.fn() }));
vi.mock('@/lib/publicAddresses/certificateProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  certificateProvider: certificateProviderSpy,
}));

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { publicAddressRepository } = await import('@/lib/repositories/publicAddressRepository');
const { publicHostnameReservationRepository } =
  await import('@/lib/repositories/publicHostnameReservationRepository');
const { publicAddressesService } = await import('@/lib/services/publicAddressesService');
const { hostnameReservationHash } = await import('@/lib/publicAddresses/hostnameReservation');
const { publicSiteOrigin, publicProjectPath } = await import('@/lib/publicProjects/urls');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { createTestWorkspace, createTestUser, createTestProject } = await import('../fixtures');
const {
  HostnameTakenError,
  NoSubdomainClaimedError,
  PublicAddressesUnavailableError,
  ReservedLabelError,
  SubdomainForbiddenError,
  SubdomainNotFoundError,
  SubdomainRenameCapReachedError,
  WorkspaceNotVisibleError,
} = await import('@/lib/publicAddresses/errors');
const { TenantDomainNotConfiguredError } = await import('@/lib/publicAddresses/tenantDomain');
const { MAX_SUBDOMAIN_RENAMES } = await import('@/lib/publicAddresses/reservedNames');

const BASE = 'motir.example';

interface Fixture {
  workspaceId: string;
  ownerId: string;
}

let fx: Fixture;

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
  fx = { workspaceId: workspace.id, ownerId: owner.id };
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('claim', () => {
  it('claims a label and composes the address from the configured base', async () => {
    const dto = await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    expect(dto).toMatchObject({
      label: 'acme',
      hostname: `acme.${BASE}`,
      url: `https://acme.${BASE}`,
      aliases: [],
      renamesLeft: MAX_SUBDOMAIN_RENAMES,
    });
  });

  it('reads back as null before a claim, and as the DTO after', async () => {
    expect(await publicSubdomainService.getForWorkspace(fx.workspaceId, fx.ownerId)).toBeNull();
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    expect(await publicSubdomainService.getForWorkspace(fx.workspaceId, fx.ownerId)).toMatchObject({
      hostname: `acme.${BASE}`,
    });
  });

  it('refuses a reserved label, and says WHICH rule refused it', async () => {
    const err = await publicSubdomainService
      .claim(fx.workspaceId, 'admin', fx.ownerId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReservedLabelError);
    expect((err as InstanceType<typeof ReservedLabelError>).refusal).toBe('reserved');
  });

  it('refuses an invalid label as GRAMMAR, distinctly from reserved', async () => {
    for (const [label, refusal] of [
      ['Acme', 'bad_grammar'],
      ['-acme', 'bad_grammar'],
      ['ac', 'too_short'],
      ['xn--abc', 'structurally_reserved'],
    ] as const) {
      const err = await publicSubdomainService
        .claim(fx.workspaceId, label, fx.ownerId)
        .catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(ReservedLabelError);
      expect((err as InstanceType<typeof ReservedLabelError>).refusal, label).toBe(refusal);
    }
  });

  it('refuses a second claim rather than silently renaming', async () => {
    // A claim is not a rename. Turning one into the other would spend a rename
    // from the cap without the customer asking for it.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme-two', fx.ownerId),
    ).rejects.toBeInstanceOf(HostnameTakenError);
    // And no alias was written — the refusal cost nothing.
    const rows = await adminDb.publicAddress.findMany({ where: { workspaceId: fx.workspaceId } });
    expect(rows).toHaveLength(1);
  });

  it('refuses a label another WORKSPACE already holds', async () => {
    const other = await createTestWorkspace({ name: 'Other' });
    await publicSubdomainService.claim(other.workspace.id, 'acme', other.owner.id);
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(HostnameTakenError);
  });
});

describe('rename', () => {
  it('retires the old label to an alias and claims the new one, in one go', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const dto = await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);

    expect(dto.hostname).toBe(`acme-inc.${BASE}`);
    expect(dto.aliases.map((a) => a.hostname)).toEqual([`acme.${BASE}`]);
    expect(dto.renamesLeft).toBe(MAX_SUBDOMAIN_RENAMES - 1);

    const rows = await adminDb.publicAddress.findMany({
      where: { workspaceId: fx.workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => [r.hostname, r.kind, r.status])).toEqual([
      [`acme.${BASE}`, 'workspace_subdomain_alias', 'alias'],
      [`acme-inc.${BASE}`, 'workspace_subdomain', 'active'],
    ]);
  });

  it('leaves the OLD hostname unclaimable by anyone, for ever', async () => {
    // The ADR §8 promise, proved from the other side: the alias row holds the
    // name against the whole namespace, including the workspace that used to
    // hold it.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);

    const other = await createTestWorkspace({ name: 'Squatter' });
    await expect(
      publicSubdomainService.claim(other.workspace.id, 'acme', other.owner.id),
    ).rejects.toBeInstanceOf(HostnameTakenError);
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(HostnameTakenError);
  });

  it('refuses a rename on a workspace that never claimed one', async () => {
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(NoSubdomainClaimedError);
  });

  it('refuses renaming to the name already held, rather than burning a rename', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(HostnameTakenError);
    const aliases = await adminDb.publicAddress.count({
      where: { workspaceId: fx.workspaceId, kind: 'workspace_subdomain_alias' },
    });
    expect(aliases, 'the refused rename must not have written an alias').toBe(0);
  });

  it('refuses the rename PAST the cap, and admits every one up to it', async () => {
    // Both directions. A cap that refuses the first rename would pass a test
    // asserting only that the sixth is refused.
    await publicSubdomainService.claim(fx.workspaceId, 'acme-0', fx.ownerId);
    for (let i = 1; i <= MAX_SUBDOMAIN_RENAMES; i += 1) {
      const dto = await publicSubdomainService.rename(fx.workspaceId, `acme-${i}`, fx.ownerId);
      expect(dto.renamesLeft, `after rename ${i}`).toBe(MAX_SUBDOMAIN_RENAMES - i);
    }
    const err = await publicSubdomainService
      .rename(fx.workspaceId, 'acme-last', fx.ownerId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubdomainRenameCapReachedError);
    expect((err as InstanceType<typeof SubdomainRenameCapReachedError>).cap).toBe(
      MAX_SUBDOMAIN_RENAMES,
    );
  });

  it('dates an alias by its RETIREMENT, not by when it was claimed', async () => {
    // The two are different dates and are often months apart. A pane showing
    // "retired on" would otherwise show the day the label was first taken.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const claimed = await adminDb.publicAddress.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    await adminDb.publicAddress.update({
      where: { id: claimed.id },
      data: { createdAt: new Date('2020-01-01T00:00:00Z') },
    });

    const dto = await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);
    expect(dto.aliases[0]!.retiredAt.startsWith('2020-01-01')).toBe(false);
  });
});

describe('authorisation — a WORKSPACE resource, not a project one', () => {
  it('lets an owner write and a member only read', async () => {
    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);

    await expect(
      publicSubdomainService.getForWorkspace(fx.workspaceId, member.id),
    ).resolves.toMatchObject({ hostname: `acme.${BASE}` });
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme-inc', member.id),
    ).rejects.toBeInstanceOf(SubdomainForbiddenError);
  });

  it('lets an ADMIN write — the role `WORKSPACE_ROLE` does not carry', async () => {
    // ⚠️ The regression this pins: `lib/workspaces/roles.ts`'s `WORKSPACE_ROLE`
    // is a narrower legacy constant with only `owner` / `member`, so a gate
    // written against it silently refuses every workspace admin. The gate is
    // written against `MemberRole`, the schema's enum, instead.
    const admin = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: admin.id, workspaceId: fx.workspaceId, role: 'admin' },
    });
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', admin.id),
    ).resolves.toMatchObject({ hostname: `acme.${BASE}` });
  });

  it('refuses a VIEWER the write', async () => {
    const viewer = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: viewer.id, workspaceId: fx.workspaceId, role: 'viewer' },
    });
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', viewer.id),
    ).rejects.toBeInstanceOf(SubdomainForbiddenError);
  });

  it('answers a NON-MEMBER with not-found on both read and write', async () => {
    // The no-existence-leak posture: a stranger must not be able to tell an
    // unclaimed workspace from one they cannot see.
    const stranger = await createTestUser();
    await expect(
      publicSubdomainService.getForWorkspace(fx.workspaceId, stranger.id),
    ).rejects.toBeInstanceOf(WorkspaceNotVisibleError);
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', stranger.id),
    ).rejects.toBeInstanceOf(WorkspaceNotVisibleError);
  });
});

describe('the gates', () => {
  it('is ABSENT off-cloud — every method, before any read', async () => {
    delete process.env['MOTIR_CLOUD'];
    await expect(
      publicSubdomainService.getForWorkspace(fx.workspaceId, fx.ownerId),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
  });

  it('refuses when no base domain is configured, rather than guessing one', async () => {
    // There is no default, and that is the opposite choice from
    // `motir-marketing`'s site origin. A guessed base would mint hostnames — in
    // the database, in DNS instructions a customer follows, in a certificate
    // request — under a domain nobody owns.
    delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(TenantDomainNotConfiguredError);
  });
});

describe('concurrency', () => {
  it('lets exactly ONE of two concurrent claims of the same label win', async () => {
    // TWO WORKSPACES, deliberately. Two claims in ONE workspace contend on the
    // workspace row lock; two in DIFFERENT workspaces lock two different rows,
    // so the row lock cannot see the collision at all and the GLOBAL hostname
    // unique is the only thing standing between them. That is the harder case
    // and the one worth pinning.
    const other = await createTestWorkspace({ name: 'Rival' });
    const results = await Promise.allSettled([
      publicSubdomainService.claim(fx.workspaceId, 'contended', fx.ownerId),
      publicSubdomainService.claim(other.workspace.id, 'contended', other.owner.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HostnameTakenError);

    const rows = await adminDb.publicAddress.findMany({
      where: { hostname: `contended.${BASE}` },
    });
    expect(rows).toHaveLength(1);
  });

  it('lets exactly ONE of two concurrent claims in the SAME workspace win', async () => {
    // Here the workspace row lock is the arbiter, and the second claim must see
    // the first one's row — which is what the re-read INSIDE the lock buys.
    const results = await Promise.allSettled([
      publicSubdomainService.claim(fx.workspaceId, 'first', fx.ownerId),
      publicSubdomainService.claim(fx.workspaceId, 'second', fx.ownerId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const live = await adminDb.publicAddress.count({
      where: { workspaceId: fx.workspaceId, kind: 'workspace_subdomain' },
    });
    expect(live, 'a workspace must never end up with two live subdomains').toBe(1);
  });
});

describe('the repository seam', () => {
  it('never leaves a workspace with two live subdomains after a rename', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);
    const live = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
      (tx) => publicAddressRepository.findLiveSubdomainForWorkspace(fx.workspaceId, tx),
    );
    expect(live?.hostname).toBe(`acme-inc.${BASE}`);
  });
});

// ── RELEASE (ADR §8 Amendment 2 · Story MOTIR-4451 · Subtask MOTIR-4454) ────
//
// Q7's never-released rule is about who may take a name NEXT, so a workspace may
// un-claim its own. What must hold is that the NAMES stay gone from the
// namespace while the ADDRESSES disappear — which is a claim about ORDER inside
// one transaction, and only a forced failure can assert it.

describe('release', () => {
  it('takes the live label AND every alias, and reserves the digest of each', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-ltd', fx.ownerId);

    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    expect(
      await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } }),
      'the live subdomain and BOTH aliases go — releasing only the live one would leave ' +
        'aliases 301ing to a host that no longer resolves',
    ).toBe(0);

    const reserved = await adminDb.publicHostnameReservation.findMany({
      where: { retiredFromWorkspaceId: fx.workspaceId },
    });
    expect(reserved.map((r) => r.hostnameHash).sort()).toEqual(
      [`acme.${BASE}`, `acme-inc.${BASE}`, `acme-ltd.${BASE}`].map(hostnameReservationHash).sort(),
    );
  });

  it('RESERVES BEFORE IT DELETES — a failing reserve leaves every address row standing', async () => {
    // THE criterion of this card, and it cannot be written as a happy path. A
    // release that commits the delete and loses the reserve hands the label back
    // to the global namespace — §8's exact prohibition — and is unrepairable,
    // because the row that knew the hostname is the one that was deleted.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);

    const boom = new Error('reserveMany exploded');
    const spy = vi
      .spyOn(publicHostnameReservationRepository, 'reserveMany')
      .mockRejectedValueOnce(boom);
    try {
      await expect(publicSubdomainService.release(fx.workspaceId, fx.ownerId)).rejects.toBe(boom);
    } finally {
      spy.mockRestore();
    }

    expect(
      await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } }),
      'the transaction must roll the delete back with the reserve',
    ).toBe(2);
    expect(
      await adminDb.publicHostnameReservation.count({
        where: { retiredFromWorkspaceId: fx.workspaceId },
      }),
    ).toBe(0);
  });

  it('leaves a CUSTOM DOMAIN on the same workspace untouched — still issued, still primary', async () => {
    // `reservesItsHostname` is what chooses the rows, and it excludes a customer
    // domain for a stated reason: that name is theirs, and holding it would be a
    // hostage. A hand-written kind list is the mistake this pins.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const project = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
    });
    const custom = await adminDb.publicAddress.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: project.id,
        kind: 'custom_domain',
        hostname: 'docs.acme.example',
        status: 'issued',
      },
    });
    await adminDb.project.update({
      where: { id: project.id },
      data: { primaryAddressId: custom.id },
    });

    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    const after = await adminDb.publicAddress.findUnique({ where: { id: custom.id } });
    expect(after?.status).toBe('issued');
    expect(
      (await adminDb.project.findUnique({ where: { id: project.id } }))?.primaryAddressId,
      'a promoted custom domain stays the canonical — release changes nothing for it',
    ).toBe(custom.id);
    expect(
      await adminDb.publicHostnameReservation.count({
        where: { hostnameHash: hostnameReservationHash('docs.acme.example') },
      }),
      'reserving a name we do not own is a hostage, not a protection',
    ).toBe(0);
  });

  it('lets a project whose primary WAS the subdomain fall back, with no manual sweep', async () => {
    // `project.primary_address_id` is ON DELETE SET NULL, so the fallback is the
    // database's. Asserted rather than implemented — a hand-run setPrimary(null)
    // would be a second copy of a constraint that already holds.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const project = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
    });
    const live = await adminDb.publicAddress.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, kind: 'workspace_subdomain' },
    });
    await adminDb.project.update({
      where: { id: project.id },
      data: { primaryAddressId: live.id },
    });

    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    const after = await adminDb.project.findUnique({ where: { id: project.id } });
    expect(after, 'the PROJECT must survive its primary address being deleted').not.toBeNull();
    expect(after?.primaryAddressId).toBeNull();
  });

  it('refuses to re-claim a released LIVE label, and a released ALIAS label', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);
    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    // The ALIAS case is the one a kind-filter mistake would let through.
    for (const label of ['acme-inc', 'acme']) {
      const other = await createTestWorkspace({ name: `Rival ${label}` });
      await expect(
        publicSubdomainService.claim(other.workspace.id, label, other.owner.id),
      ).rejects.toBeInstanceOf(HostnameTakenError);
    }
  });

  it('leaves a DIFFERENT label claimable, so the refusal is specific and not a lock', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);
    const other = await createTestWorkspace({ name: 'Rival' });
    await expect(
      publicSubdomainService.claim(other.workspace.id, 'acme-two', other.owner.id),
    ).resolves.toMatchObject({ hostname: `acme-two.${BASE}` });
  });

  it('makes NO certificate-provider call — the wildcard issued nothing to withdraw', async () => {
    // The obvious mistake is copying `customDomainService.remove`, whose
    // post-commit provider call is right for a customer domain and meaningless
    // for a label the wildcard `*.<base>` already covers (ADR §6).
    certificateProviderSpy.mockClear();
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);
    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);
    expect(certificateProviderSpy).not.toHaveBeenCalled();
  });

  it('answers NOT-FOUND when the workspace has never claimed one', async () => {
    // A DELETE names a resource, so this is 404 and NOT the rename path's 409 —
    // two typed errors rather than one mapped two ways.
    await expect(publicSubdomainService.release(fx.workspaceId, fx.ownerId)).rejects.toBeInstanceOf(
      SubdomainNotFoundError,
    );
  });

  it('is ADMIN-only, ABSENT off-cloud, and invisible to another workspace', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);

    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    await expect(publicSubdomainService.release(fx.workspaceId, member.id)).rejects.toBeInstanceOf(
      SubdomainForbiddenError,
    );

    const stranger = await createTestUser();
    await expect(
      publicSubdomainService.release(fx.workspaceId, stranger.id),
    ).rejects.toBeInstanceOf(WorkspaceNotVisibleError);

    delete process.env['MOTIR_CLOUD'];
    await expect(publicSubdomainService.release(fx.workspaceId, fx.ownerId)).rejects.toBeInstanceOf(
      PublicAddressesUnavailableError,
    );
    process.env['MOTIR_CLOUD'] = 'true';

    expect(
      await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } }),
      'four refused releases must have deleted nothing',
    ).toBe(1);
  });
});

describe('release and the rename cap (Amendment 2 — the cap counts names BURNT)', () => {
  it('does NOT reset the cap: a claim after a release starts from what is left', async () => {
    // The default an implementation falls into is the opposite — `renamesLeft`
    // was derived from alias ROWS, and a release deletes them — which would make
    // claim → rename ×5 → release an unbounded name burn.
    await publicSubdomainService.claim(fx.workspaceId, 'a-one', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'a-two', fx.ownerId);
    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    const dto = await publicSubdomainService.claim(fx.workspaceId, 'b-one', fx.ownerId);
    expect(
      dto.renamesLeft,
      'two names were burnt — the live label AND its alias — so two of the five are spent',
    ).toBe(MAX_SUBDOMAIN_RENAMES - 2);
    expect(await publicSubdomainService.getForWorkspace(fx.workspaceId, fx.ownerId)).toMatchObject({
      renamesLeft: MAX_SUBDOMAIN_RENAMES - 2,
    });
  });

  it('refuses the rename PAST the cap counting released names, not only live aliases', async () => {
    // Burn three by releasing (one label + two aliases), then two by renaming.
    await publicSubdomainService.claim(fx.workspaceId, 'c-one', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'c-two', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'c-three', fx.ownerId);
    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    await publicSubdomainService.claim(fx.workspaceId, 'd-one', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'd-two', fx.ownerId);
    const dto = await publicSubdomainService.rename(fx.workspaceId, 'd-three', fx.ownerId);
    expect(dto.renamesLeft).toBe(0);

    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'd-four', fx.ownerId),
    ).rejects.toBeInstanceOf(SubdomainRenameCapReachedError);
  });

  it('leaves the number UNCHANGED for a workspace that has never released', async () => {
    // The generalisation has to agree with the old rule everywhere the old rule
    // was defined, or it is a behaviour change wearing a bug fix.
    const dto = await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    expect(dto.renamesLeft).toBe(MAX_SUBDOMAIN_RENAMES);
    const renamed = await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);
    expect(renamed.renamesLeft).toBe(MAX_SUBDOMAIN_RENAMES - 1);
  });

  it('lets a workspace at the cap still RELEASE — the cap bounds coming back, not leaving', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'e-zero', fx.ownerId);
    for (const label of ['e-one', 'e-two', 'e-three', 'e-four', 'e-five']) {
      await publicSubdomainService.rename(fx.workspaceId, label, fx.ownerId);
    }
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'e-six', fx.ownerId),
    ).rejects.toBeInstanceOf(SubdomainRenameCapReachedError);

    await expect(
      publicSubdomainService.release(fx.workspaceId, fx.ownerId),
    ).resolves.toBeUndefined();
    expect(await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } })).toBe(0);
  });
});

describe('release and how the rest of the system then ADDRESSES the projects', () => {
  it('returns the projects to motir.co/p/<identifier>, asserted through the services', async () => {
    // Through `publicAddressesService`, never by reading rows: the point is that
    // the RESOLUTION agrees, and a row read would pass while the service did not.
    //
    // ⚠️ `accessLevel: 'public'` is load-bearing. `addressesForProject` reads the
    // address rows through the `db` SINGLETON, which is gated by the
    // `public_address_public_read` policy — so on a private project the read
    // returns EMPTY and the service answers the `motir.co` fallback. That is the
    // same value a correct release produces, so seeding a private project here
    // would make the "released" half pass for the wrong reason.
    const project = await adminDb.project.create({
      data: {
        workspaceId: fx.workspaceId,
        name: 'Public Project',
        slug: 'pub',
        identifier: 'PUB',
        accessLevel: 'public',
      },
    });
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);

    const claimed = await publicAddressesService.addressesForProject(
      project.id,
      fx.workspaceId,
      project.identifier,
    );
    expect(claimed.primary).toBe(`https://acme.${BASE}/${project.identifier}`);
    expect(
      claimed.alternates.some((u) => u.includes(publicProjectPath(project.identifier))),
      'while claimed, motir.co/p/<id> is only an ALTERNATE — it 301s to the subdomain',
    ).toBe(true);
    expect(
      await publicAddressesService.primaryHostsForProjects([
        { id: project.id, workspaceId: fx.workspaceId, identifier: project.identifier },
      ]),
    ).toEqual(new Map([[project.id, `acme.${BASE}`]]));

    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    const released = await publicAddressesService.addressesForProject(
      project.id,
      fx.workspaceId,
      project.identifier,
    );
    expect(
      released.primary,
      "§7's default-primary table takes its first row again once nothing is claimed",
    ).toBe(`${publicSiteOrigin()}${publicProjectPath(project.identifier)}`);
    expect(released.alternates).toEqual([]);
    expect(
      await publicAddressesService.primaryHostsForProjects([
        { id: project.id, workspaceId: fx.workspaceId, identifier: project.identifier },
      ]),
      'no host means the per-host sitemap filter matches this project on motir.co again',
    ).toEqual(new Map());
  });
});
