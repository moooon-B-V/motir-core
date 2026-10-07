import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { createTestUser } from '../fixtures/userFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { directionInput, motirBuysInput, seedTags } from '../ideas/_helpers';

// The STAFF ideas routes (Story MOTIR-7662 · MOTIR-7675) over real Postgres, a
// real gate and real tokens: each route's success shape, every mapped error,
// the level per route, and both credentials admitted. The one stub is
// `getSession()`, the repo's standing exception.

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

// `requirePlatformStaff` (the session arm) is React-`cache()`d process-wide in
// vitest, so each case imports the routes from a fresh module graph.
beforeEach(async () => {
  vi.resetModules();
  currentSession = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

async function routes() {
  const [collection, one, retire, tags, runs] = await Promise.all([
    import('@/app/api/platform/ideas/route'),
    import('@/app/api/platform/ideas/[slug]/route'),
    import('@/app/api/platform/ideas/[slug]/retire/route'),
    import('@/app/api/platform/ideas/tags/route'),
    import('@/app/api/platform/ideas/runs/route'),
  ]);
  return { collection, one, retire, tags, runs };
}

let seq = 0;

/** A PAT whose owner holds `role` (null: a tenant user). */
async function tokenFor(role: PlatformRole | null): Promise<string> {
  const { owner, workspace } = await createTestWorkspace({ name: `Ideas routes ${++seq}` });
  if (role) await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: role } });
  const { token } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'motir-ideas',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  });
  return token;
}

function call(
  path: string,
  token: string | null,
  init: { method?: string; body?: unknown; rawBody?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined || init.rawBody !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return new Request(`http://localhost/api/platform/ideas${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}

const slugCtx = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function json(res: Response) {
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
}

describe('POST /api/platform/ideas', () => {
  it('adds a batch (201) with a staff token, and the list reads it back', async () => {
    await seedTags('smb');
    const token = await tokenFor('operator');
    const r = await routes();

    const added = await json(
      await r.collection.POST(
        call('', token, {
          method: 'POST',
          body: { ideas: [directionInput('one', { tags: ['smb'] }), motirBuysInput('two')] },
        }),
      ),
    );
    expect(added).toEqual({ status: 201, body: { slugs: ['one', 'two'] }, cache: 'no-store' });

    const list = await json(await r.collection.GET(call('?kind=direction', token)));
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { slug: string }) => i.slug)).toEqual(['one']);
    expect(list.body.items[0].status).toBe('active');
    expect(list.body.nextCursor).toBeNull();
  });

  it('maps a taken slug to 409, an unknown tag to 400 and a malformed body to 400 with paths', async () => {
    const token = await tokenFor('operator');
    const r = await routes();
    await r.collection.POST(
      call('', token, { method: 'POST', body: { ideas: [directionInput('taken')] } }),
    );

    const taken = await json(
      await r.collection.POST(
        call('', token, { method: 'POST', body: { ideas: [directionInput('taken')] } }),
      ),
    );
    expect(taken).toMatchObject({
      status: 409,
      body: { code: 'IDEA_SLUG_TAKEN', slugs: ['taken'] },
    });

    const unknownTag = await json(
      await r.collection.POST(
        call('', token, {
          method: 'POST',
          body: { ideas: [directionInput('fresh', { tags: ['nope'] })] },
        }),
      ),
    );
    expect(unknownTag).toMatchObject({
      status: 400,
      body: { code: 'UNKNOWN_TAG', tags: ['nope'] },
    });

    const malformed = await json(
      await r.collection.POST(
        call('', token, {
          method: 'POST',
          body: { ideas: [{ ...directionInput('Bad Slug'), category: 'astrology' }] },
        }),
      ),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('INVALID_REQUEST');
    expect(malformed.body.issues.map((i: { path: string }) => i.path).sort()).toEqual([
      'ideas.0.category',
      'ideas.0.slug',
    ]);

    const notJson = await json(
      await r.collection.POST(call('', token, { method: 'POST', rawBody: '{nope' })),
    );
    expect(notJson).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });

    const empty = await json(
      await r.collection.POST(call('', token, { method: 'POST', body: { ideas: [] } })),
    );
    expect(empty.status).toBe(400);
  });

  it('maps a kind-specific rule the service owns to 400 INVALID_IDEA_INPUT', async () => {
    const token = await tokenFor('operator');
    const r = await routes();
    const res = await json(
      await r.collection.POST(
        call('', token, {
          method: 'POST',
          body: { ideas: [directionInput('no-evidence', { evidence: [] })] },
        }),
      ),
    );
    expect(res).toMatchObject({ status: 400, body: { code: 'INVALID_IDEA_INPUT' } });
  });
});

describe('GET /api/platform/ideas', () => {
  it('refuses a bad filter (400) and a cursor it did not issue (400)', async () => {
    const token = await tokenFor('operator');
    const r = await routes();
    expect((await r.collection.GET(call('?category=astrology', token))).status).toBe(400);
    expect((await r.collection.GET(call('?limit=0', token))).status).toBe(400);
    const cursor = await json(await r.collection.GET(call('?cursor=bm9wZQ', token)));
    expect(cursor).toMatchObject({ status: 400, body: { code: 'INVALID_IDEA_INPUT' } });
  });

  it('pages with nextCursor', async () => {
    const token = await tokenFor('operator');
    const r = await routes();
    await r.collection.POST(
      call('', token, {
        method: 'POST',
        body: { ideas: [directionInput('p-1'), directionInput('p-2'), directionInput('p-3')] },
      }),
    );
    const first = await json(await r.collection.GET(call('?limit=2', token)));
    expect(first.body.items).toHaveLength(2);
    const second = await json(
      await r.collection.GET(call(`?limit=2&cursor=${first.body.nextCursor}`, token)),
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it('lets an unmapped error through as a 500, not a disguised 4xx', async () => {
    const token = await tokenFor('operator');
    const r = await routes();
    const { ideasAdminService } = await import('@/lib/services/ideasAdminService');
    vi.spyOn(ideasAdminService, 'listForStaff').mockRejectedValueOnce(new Error('db down'));
    await expect(r.collection.GET(call('', token))).rejects.toThrow('db down');
  });
});

describe('/api/platform/ideas/[slug]', () => {
  it('reads, patches, retires and (as superadmin) deletes', async () => {
    const operator = await tokenFor('operator');
    const superadmin = await tokenFor('superadmin');
    const r = await routes();
    await r.collection.POST(
      call('', operator, { method: 'POST', body: { ideas: [directionInput('life')] } }),
    );

    const read = await json(await r.one.GET(call('/life', operator), slugCtx('life')));
    expect(read).toMatchObject({ status: 200, body: { slug: 'life', status: 'active' } });

    const patched = await json(
      await r.one.PATCH(
        call('/life', operator, {
          method: 'PATCH',
          body: { pitch: 'A new pitch.', reviewed: true },
        }),
        slugCtx('life'),
      ),
    );
    expect(patched.body.pitch).toBe('A new pitch.');
    expect(patched.body.lastReviewedAt).not.toBeNull();

    const retired = await json(
      await r.retire.POST(
        call('/life/retire', operator, { method: 'POST', body: { reason: 'Superseded' } }),
        slugCtx('life'),
      ),
    );
    expect(retired.body).toMatchObject({ status: 'retired', retiredReason: 'Superseded' });

    const again = await json(
      await r.retire.POST(
        call('/life/retire', operator, { method: 'POST', body: { reason: 'Twice' } }),
        slugCtx('life'),
      ),
    );
    expect(again).toMatchObject({ status: 409, body: { code: 'IDEA_NOT_ACTIVE' } });

    // DELETE is superadmin: an operator gets the gate's 404 and nothing is deleted.
    const refused = await json(
      await r.one.DELETE(
        call('/life', operator, { method: 'DELETE', body: { reason: 'Spam' } }),
        slugCtx('life'),
      ),
    );
    expect(refused).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect(await adminDb.idea.count({ where: { slug: 'life' } })).toBe(1);

    const deleted = await json(
      await r.one.DELETE(
        call('/life', superadmin, { method: 'DELETE', body: { reason: 'Spam' } }),
        slugCtx('life'),
      ),
    );
    expect(deleted).toMatchObject({ status: 200, body: { deleted: 'life' } });
    expect(await adminDb.idea.count({ where: { slug: 'life' } })).toBe(0);
  });

  it('maps an unknown slug to 404 IDEA_NOT_FOUND and a blank reason to 400', async () => {
    const token = await tokenFor('superadmin');
    const r = await routes();
    expect((await json(await r.one.GET(call('/ghost', token), slugCtx('ghost')))).body).toEqual({
      code: 'IDEA_NOT_FOUND',
    });
    const patch = await r.one.PATCH(
      call('/ghost', token, { method: 'PATCH', body: { pitch: 'x' } }),
      slugCtx('ghost'),
    );
    expect(patch.status).toBe(404);
    const retire = await r.retire.POST(
      call('/ghost/retire', token, { method: 'POST', body: { reason: 'x' } }),
      slugCtx('ghost'),
    );
    expect(retire.status).toBe(404);
    const blank = await json(
      await r.one.DELETE(
        call('/ghost', token, { method: 'DELETE', body: { reason: '   ' } }),
        slugCtx('ghost'),
      ),
    );
    expect(blank).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
  });
});

describe('/api/platform/ideas/tags and /runs', () => {
  it('adds a tag (201), refuses a duplicate (409) and lists the vocabulary', async () => {
    const token = await tokenFor('operator');
    const r = await routes();
    const body = { slug: 'smb', label: 'Small businesses', description: 'Below enterprise size.' };
    expect((await r.tags.POST(call('/tags', token, { method: 'POST', body }))).status).toBe(201);
    const dup = await json(await r.tags.POST(call('/tags', token, { method: 'POST', body })));
    expect(dup).toMatchObject({ status: 409, body: { code: 'IDEA_TAG_TAKEN', slug: 'smb' } });
    const missing = await r.tags.POST(
      call('/tags', token, { method: 'POST', body: { slug: 'x', label: 'X' } }),
    );
    expect(missing.status).toBe(400);
    const list = await json(await r.tags.GET(call('/tags', token)));
    expect(list.body).toEqual([
      { slug: 'smb', label: 'Small businesses', description: 'Below enterprise size.', count: 0 },
    ]);
  });

  it('records a research run (201) and lists recent runs', async () => {
    const token = await tokenFor('operator');
    const r = await routes();
    const run = { areasCovered: ['pets'], addedCount: 2, retiredCount: 0, reportMd: '# Run' };
    expect((await r.runs.POST(call('/runs', token, { method: 'POST', body: run }))).status).toBe(
      201,
    );
    const list = await json(await r.runs.GET(call('/runs?limit=5', token)));
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ areasCovered: ['pets'], addedCount: 2 });
    expect((await r.runs.GET(call('/runs?limit=999', token))).status).toBe(400);
    expect(
      (
        await r.runs.POST(
          call('/runs', token, { method: 'POST', body: { ...run, addedCount: -1 } }),
        )
      ).status,
    ).toBe(400);
  });
});

describe('who is admitted', () => {
  it('refuses every route with 404 for a non-staff token, a support token and no credential', async () => {
    const tenant = await tokenFor(null);
    const support = await tokenFor('support');
    const r = await routes();
    for (const token of [tenant, support, null]) {
      const answers = [
        await r.collection.GET(call('', token)),
        await r.collection.POST(call('', token, { method: 'POST', body: { ideas: [] } })),
        await r.one.GET(call('/x', token), slugCtx('x')),
        await r.one.PATCH(call('/x', token, { method: 'PATCH', body: {} }), slugCtx('x')),
        await r.one.DELETE(call('/x', token, { method: 'DELETE', body: {} }), slugCtx('x')),
        await r.retire.POST(call('/x/retire', token, { method: 'POST', body: {} }), slugCtx('x')),
        await r.tags.GET(call('/tags', token)),
        await r.tags.POST(call('/tags', token, { method: 'POST', body: {} })),
        await r.runs.GET(call('/runs', token)),
        await r.runs.POST(call('/runs', token, { method: 'POST', body: {} })),
      ];
      for (const res of answers) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
      }
    }
  });

  it('admits a staff console session, and records it as the credential', async () => {
    const staff = await createTestUser({ email: 'ops+ideas-routes-session@moooon.net' });
    await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'operator' } });
    currentSession = { user: { id: staff.id } };
    const r = await routes();

    const res = await r.collection.POST(
      call('', null, { method: 'POST', body: { ideas: [directionInput('by-session')] } }),
    );
    expect(res.status).toBe(201);
    const [row] = await adminDb.platformAuditLog.findMany({ where: { action: 'idea.add' } });
    expect(row!.actorUserId).toBe(staff.id);
    expect((row!.metadata as { credential: unknown }).credential).toEqual({ kind: 'session' });
  });
});
