import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// `organizationsService.listMembers`' picker narrowing (MOTIR-6313): the transfer
// dialog reads the roster's own paged read with `excludeOwner` and a name/email
// `q`. Both must narrow the page AND its total, or the pager lies. Real Postgres;
// the one boundary mock is the seat-sync enqueue membership writes fire.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { organizationsService } = await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

async function makeOrg() {
  const owner = await createTestUser({ name: 'Olive Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  const mara = await createTestUser({
    name: 'Mara Chen',
    email: `mara.chen+${Date.now()}@example.com`,
  });
  const dev = await createTestUser({ name: 'Dev Patel' });
  const sam = await createTestUser({ name: 'Sam Okafor' });
  for (const [u, role] of [
    [mara, 'admin'],
    [dev, 'member'],
    [sam, 'member'],
  ] as const) {
    await organizationsService.addMember({
      organizationId,
      userId: u.id,
      role,
      actorUserId: owner.id,
    });
  }
  return { organizationId, owner, mara, dev, sam };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('listMembers — the transfer picker narrowing', () => {
  it('leaves the Owner off the page AND out of the total with excludeOwner', async () => {
    const { organizationId, owner } = await makeOrg();
    const all = await organizationsService.listMembers({ organizationId, actorUserId: owner.id });
    expect(all.total).toBe(4);

    const picker = await organizationsService.listMembers({
      organizationId,
      actorUserId: owner.id,
      excludeOwner: true,
    });
    expect(picker.total).toBe(3);
    expect(picker.members.map((m) => m.userId)).not.toContain(owner.id);
    expect(picker.members.every((m) => m.role !== 'owner')).toBe(true);
  });

  it('matches name or email case-insensitively, and the total follows the match', async () => {
    const { organizationId, owner, mara } = await makeOrg();
    const byName = await organizationsService.listMembers({
      organizationId,
      actorUserId: owner.id,
      excludeOwner: true,
      q: 'mARa',
    });
    expect(byName.members.map((m) => m.userId)).toEqual([mara.id]);
    expect(byName.total).toBe(1);

    const byEmail = await organizationsService.listMembers({
      organizationId,
      actorUserId: owner.id,
      excludeOwner: true,
      q: 'MARA.CHEN',
    });
    expect(byEmail.members.map((m) => m.userId)).toEqual([mara.id]);
  });

  it('pages the narrowed set by cursor', async () => {
    const { organizationId, owner } = await makeOrg();
    const first = await organizationsService.listMembers({
      organizationId,
      actorUserId: owner.id,
      excludeOwner: true,
      limit: 2,
    });
    expect(first.members).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await organizationsService.listMembers({
      organizationId,
      actorUserId: owner.id,
      excludeOwner: true,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.members).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(3);
  });

  it('a blank q is no filter', async () => {
    const { organizationId, owner } = await makeOrg();
    const page = await organizationsService.listMembers({
      organizationId,
      actorUserId: owner.id,
      q: '   ',
    });
    expect(page.total).toBe(4);
  });
});
