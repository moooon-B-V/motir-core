import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The workspace-subdomain service — Story MOTIR-3878 · Subtask MOTIR-4215.
// Real Postgres throughout (the no-mocks rule); the only toggles are the
// `MOTIR_CLOUD` and `MOTIR_PUBLIC_TENANT_DOMAIN` env vars.

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { publicAddressRepository } = await import('@/lib/repositories/publicAddressRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { createTestWorkspace, createTestUser } = await import('../fixtures');
const {
  HostnameTakenError,
  NoSubdomainClaimedError,
  PublicAddressesUnavailableError,
  ReservedLabelError,
  SubdomainForbiddenError,
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
