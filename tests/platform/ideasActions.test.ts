import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import type { PlatformRole } from '@/generated/prisma/client';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  directionInput,
  ideaAuditRows,
  motirBuysInput,
  seedTags,
  staffActor,
} from '../ideas/_helpers';

/**
 * The console's IDEA Server Actions through the REAL staff gate (Story
 * MOTIR-7664 · MOTIR-7681). The only stub on the identity path is
 * `getSession()` (the standing exception: vitest has no cookies), so
 * `requirePlatformStaff` reads the real `platformRole` column and the service
 * writes real rows with their real audit entries.
 *
 * What each case pins is a row of the action's result contract — `ok`,
 * `invalid` with the refused fields, `not_active`, `not_found`,
 * `not_permitted` — and, for every refusal, that nothing was written.
 */

let currentSession: { user: { id: string; email: string; name: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { updateIdeaAction, retireIdeaAction, deleteIdeaAction } =
  await import('@/app/(admin)/admin/ideas/actions');

beforeEach(async () => {
  currentSession = null;
  vi.mocked(revalidatePath).mockClear();
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

async function signInAs(role: PlatformRole) {
  const actor = await staffActor(role, { kind: 'session' }, `${role}-console`);
  currentSession = { user: { id: actor.userId, email: actor.email, name: role } };
  return actor;
}

async function seed() {
  await seedTags('smb', 'consumer');
  const seeder = await staffActor('operator', { kind: 'session' }, 'seeder');
  await ideasAdminService.addIdeas(seeder, [
    directionInput('stop-returns', { tags: ['smb'] }),
    motirBuysInput('contract-review'),
  ]);
}

const idea = (slug: string) =>
  adminDb.idea.findUnique({ where: { slug }, include: { evidence: true, tags: true } });

describe('updateIdeaAction', () => {
  it('saves an operator’s edit, evidence and tags included, and answers the stored idea', async () => {
    await seed();
    const operator = await signInAs('operator');
    const before = (await ideaAuditRows()).length;

    const result = await updateIdeaAction('stop-returns', {
      pitch: 'A sharper pitch.',
      tags: ['smb', 'consumer'],
      evidence: [
        {
          claim: 'Returns cost 20%.',
          sourceName: 'A report',
          url: 'https://example.com/a',
          sourceDate: '2026-02-01',
        },
        {
          claim: 'A second claim.',
          sourceName: 'B',
          url: 'https://example.com/b',
          sourceDate: null,
        },
      ],
      reviewed: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.idea.pitch).toBe('A sharper pitch.');
    expect(result.idea.evidence).toHaveLength(2);
    expect(result.idea.tags.map((t) => t.slug).sort()).toEqual(['consumer', 'smb']);
    expect(result.idea.lastReviewedAt).not.toBeNull();
    expect((await idea('stop-returns'))!.pitch).toBe('A sharper pitch.');

    const rows = await ideaAuditRows();
    expect(rows).toHaveLength(before + 1);
    const row = rows.at(-1)!;
    expect(row.action).toBe('idea.update');
    expect(row.actorUserId).toBe(operator.userId);
    expect(row.reason).toBe('Edited in the operator console');
    expect(row.metadata).toMatchObject({ credential: { kind: 'session' } });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/ideas');
    expect(revalidatePath).toHaveBeenCalledWith('/admin/ideas/stop-returns');
  });

  it('refuses an invalid field in place, naming it, and saves nothing', async () => {
    await seed();
    await signInAs('operator');
    const before = (await ideaAuditRows()).length;

    const shape = await updateIdeaAction('stop-returns', {
      evidence: [{ claim: 'x', sourceName: 'y', url: 'http://plain.example', sourceDate: null }],
    });
    expect(shape).toEqual({ ok: false, code: 'invalid', issues: [{ field: 'evidence[0].url' }] });

    // A rule only the service knows: a direction needs one evidence row.
    const rule = await updateIdeaAction('stop-returns', { evidence: [] });
    expect(rule).toEqual({ ok: false, code: 'invalid', issues: [{ field: 'evidence' }] });

    const blank = await updateIdeaAction('stop-returns', { title: '   ' });
    expect(blank).toEqual({ ok: false, code: 'invalid', issues: [{ field: 'title' }] });

    expect((await idea('stop-returns'))!.evidence).toHaveLength(1);
    expect(await ideaAuditRows()).toHaveLength(before);
  });

  it('names an unknown tag on the Tags field', async () => {
    await seed();
    await signInAs('operator');
    const result = await updateIdeaAction('stop-returns', { tags: ['smb', 'gone-tag'] });
    expect(result).toEqual({
      ok: false,
      code: 'invalid',
      issues: [{ field: 'tags', tag: 'gone-tag' }],
    });
  });

  it('answers not_found for a slug the store does not hold', async () => {
    await seed();
    await signInAs('superadmin');
    expect(await updateIdeaAction('missing', { title: 'x' })).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('is not_permitted for support, for a tenant user and for nobody, and writes nothing', async () => {
    await seed();
    const before = (await ideaAuditRows()).length;
    expect(await updateIdeaAction('stop-returns', { title: 'x' })).toEqual({
      ok: false,
      code: 'not_permitted',
    });
    await signInAs('support');
    expect(await updateIdeaAction('stop-returns', { title: 'x' })).toEqual({
      ok: false,
      code: 'not_permitted',
    });
    const owner = await createTestUser({ email: 'owner@customer.test' });
    currentSession = { user: { id: owner.id, email: owner.email, name: 'owner' } };
    expect(await updateIdeaAction('stop-returns', { title: 'x' })).toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect((await idea('stop-returns'))!.title).toBe('Direction stop-returns');
    expect(await ideaAuditRows()).toHaveLength(before);
  });

  it('answers failed, not a throw, when the service breaks unexpectedly', async () => {
    await seed();
    await signInAs('operator');
    const spy = vi.spyOn(ideasAdminService, 'updateIdea').mockRejectedValueOnce(new Error('boom'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await updateIdeaAction('stop-returns', { title: 'x' })).toEqual({
      ok: false,
      code: 'failed',
    });
    spy.mockRestore();
    logged.mockRestore();
  });
});

describe('retireIdeaAction', () => {
  it('retires with the stated reason and one audit row naming the operator and the session', async () => {
    await seed();
    const operator = await signInAs('operator');
    const result = await retireIdeaAction('stop-returns', '  A competitor shipped it  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.idea.status).toBe('retired');
    expect(result.idea.retiredReason).toBe('A competitor shipped it');

    const row = (await ideaAuditRows()).at(-1)!;
    expect(row.action).toBe('idea.retire');
    expect(row.actorUserId).toBe(operator.userId);
    expect(row.reason).toBe('A competitor shipped it');
    expect(row.metadata).toMatchObject({ credential: { kind: 'session' } });

    // And the detail can say who.
    const who = await adminDb.user.findUniqueOrThrow({ where: { id: operator.userId } });
    expect(await ideasAdminService.retiredBy(operator, result.idea)).toBe(who.name || who.email);
  });

  it('requires a reason', async () => {
    await seed();
    await signInAs('operator');
    expect(await retireIdeaAction('stop-returns', '   ')).toEqual({
      ok: false,
      code: 'invalid',
      issues: [{ field: 'reason' }],
    });
    expect((await idea('stop-returns'))!.status).toBe('active');
  });

  it('answers not_active for an idea already retired, and keeps the first reason', async () => {
    await seed();
    await signInAs('operator');
    expect((await retireIdeaAction('stop-returns', 'First')).ok).toBe(true);
    expect(await retireIdeaAction('stop-returns', 'Second')).toEqual({
      ok: false,
      code: 'not_active',
    });
    expect((await idea('stop-returns'))!.retiredReason).toBe('First');
  });

  it('is not_permitted for support', async () => {
    await seed();
    await signInAs('support');
    expect(await retireIdeaAction('stop-returns', 'Because')).toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect((await idea('stop-returns'))!.status).toBe('active');
  });
});

describe('deleteIdeaAction', () => {
  it('deletes for a superadmin, with one audit row that keeps the slug', async () => {
    await seed();
    const superadmin = await signInAs('superadmin');
    expect(await deleteIdeaAction('contract-review', 'Added by mistake')).toEqual({ ok: true });
    expect(await idea('contract-review')).toBeNull();
    const row = (await ideaAuditRows()).at(-1)!;
    expect(row.action).toBe('idea.delete');
    expect(row.actorUserId).toBe(superadmin.userId);
    expect(row.reason).toBe('Added by mistake');
    expect(row.metadata).toMatchObject({
      credential: { kind: 'session' },
      slug: 'contract-review',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/ideas');
  });

  it('is not_permitted for an operator and for support, and deletes nothing', async () => {
    await seed();
    for (const role of ['operator', 'support'] as const) {
      await signInAs(role);
      expect(await deleteIdeaAction('contract-review', 'Because')).toEqual({
        ok: false,
        code: 'not_permitted',
      });
    }
    expect(await idea('contract-review')).not.toBeNull();
  });

  it('requires a reason, and answers not_found for a missing slug', async () => {
    await seed();
    await signInAs('superadmin');
    expect(await deleteIdeaAction('contract-review', '')).toEqual({
      ok: false,
      code: 'invalid',
      issues: [{ field: 'reason' }],
    });
    expect(await deleteIdeaAction('missing', 'Because')).toEqual({ ok: false, code: 'not_found' });
    expect(await idea('contract-review')).not.toBeNull();
  });
});
