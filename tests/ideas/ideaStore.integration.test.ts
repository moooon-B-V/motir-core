import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdeaNotFoundError } from '@/lib/ideas/errors';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { ideasPublicService } from '@/lib/services/ideasPublicService';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { stripSourceComments } from '../helpers/stripSourceComments';
import { applyIdeaSeed, directionInput, ideaAuditRows, seedTags, staffActor } from './_helpers';

// THE IDEA STORE, ASSEMBLED (Story MOTIR-7662 · MOTIR-7677) — what only the
// pieces together can show, against real Postgres: a staff write becoming
// visible (or invisible) on the public side, a delete leaving its audit row, the
// audit chain verifying after a mixed run of writes, every staff route admitting
// a staff token (enumerated from the tree), the seeded data, and the layering of
// the story's own files. The token boundary's other half — nothing OUTSIDE the
// ideas routes accepts a token — is `tests/platform/platformTokenBoundary.test.ts`.

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const ROOT = process.cwd();

beforeEach(async () => {
  vi.resetModules();
  currentSession = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('write → public read', () => {
  it('serves every field the staff side wrote, evidence in order and tags with labels', async () => {
    await seedTags('smb', 'consumer');
    const actor = await staffActor('operator', { kind: 'token', apiTokenId: 'tok_seam' });
    await ideasAdminService.addIdeas(actor, [
      directionInput('seam', {
        title: 'The seam',
        pitch: 'A pitch.',
        category: 'logistics',
        capabilities: ['First', 'Second'],
        whyNow: 'Because now.',
        tags: ['consumer', 'smb'],
        evidence: [
          {
            claim: 'One',
            sourceName: 'A, May 2026',
            url: 'https://a.example',
            sourceDate: '2026-05-01',
          },
          { claim: 'Two', sourceName: 'B', url: 'https://b.example', sourceDate: null },
        ],
      }),
    ]);

    const idea = await ideasPublicService.getBySlug('seam');
    expect(idea).toMatchObject({
      slug: 'seam',
      title: 'The seam',
      pitch: 'A pitch.',
      kind: 'direction',
      category: { slug: 'logistics', label: expect.any(String) },
      capabilities: ['First', 'Second'],
      gap: 'Nobody serves it yet.',
      whyNow: 'Because now.',
      whyMotir: null,
      whoElse: null,
      lastReviewedAt: null,
    });
    // `claimFallback` / `labelFallback` are MOTIR-7775's additive fields; with
    // no locale asked for, nothing is a fallback.
    expect(idea.evidence).toEqual([
      {
        claim: 'One',
        sourceName: 'A, May 2026',
        url: 'https://a.example',
        sourceDate: '2026-05-01',
        claimFallback: false,
      },
      {
        claim: 'Two',
        sourceName: 'B',
        url: 'https://b.example',
        sourceDate: null,
        claimFallback: false,
      },
    ]);
    expect(idea.tags).toEqual(
      expect.arrayContaining([
        { slug: 'smb', label: 'SMB', labelFallback: false },
        { slug: 'consumer', label: 'CONSUMER', labelFallback: false },
      ]),
    );
    expect((await ideasPublicService.listActive({ category: 'logistics' })).items).toHaveLength(1);
  });
});

describe('retire → gone from every public read', () => {
  it('hides a seeded idea from the list, the counts, the tags and the slug read; staff keep it', async () => {
    await applyIdeaSeed();
    const slug = 'a-care-team-app-for-families';
    const before = await ideasPublicService.listActive();
    const tagsBefore = await ideasPublicService.listTags();
    expect(before.items.map((i) => i.slug)).toContain(slug);
    expect(before.categories.find((c) => c.slug === 'family_care')?.count).toBe(1);

    const actor = await staffActor('operator');
    await ideasAdminService.retireIdea(actor, slug, 'A funded company now serves families');

    const after = await ideasPublicService.listActive();
    expect(after.total).toBe(before.total - 1);
    expect(after.items.map((i) => i.slug)).not.toContain(slug);
    expect(after.categories.find((c) => c.slug === 'family_care')).toBeUndefined();
    // `caregiving` is carried by this idea alone, so it leaves the public facet.
    expect(tagsBefore.map((t) => t.slug)).toContain('caregiving');
    const tagsAfter = await ideasPublicService.listTags();
    expect(tagsAfter.map((t) => t.slug)).not.toContain('caregiving');
    expect(tagsAfter.find((t) => t.slug === 'healthcare')?.count).toBe(
      tagsBefore.find((t) => t.slug === 'healthcare')!.count - 1,
    );
    await expect(ideasPublicService.getBySlug(slug)).rejects.toBeInstanceOf(IdeaNotFoundError);

    const staff = await ideasAdminService.getForStaff(actor, slug);
    expect(staff).toMatchObject({
      status: 'retired',
      retiredReason: 'A funded company now serves families',
    });
  });
});

describe('delete', () => {
  it('removes the idea, cascades evidence and assignments, and keeps its audit row', async () => {
    await applyIdeaSeed();
    const slug = 'the-ai-transparency-kit';
    const { id } = await adminDb.idea.findUniqueOrThrow({ where: { slug } });
    const superadmin = await staffActor('superadmin');

    await ideasAdminService.deleteIdea(superadmin, slug, 'Duplicate of a newer entry');

    expect(await adminDb.idea.count({ where: { id } })).toBe(0);
    expect(await adminDb.ideaEvidence.count({ where: { ideaId: id } })).toBe(0);
    expect(await adminDb.ideaTagAssignment.count({ where: { ideaId: id } })).toBe(0);
    const [row] = (await ideaAuditRows()).filter((r) => r.action === 'idea.delete');
    expect(row).toMatchObject({ targetId: id, targetLabel: slug, actorUserId: superadmin.userId });
    expect(row!.metadata).toMatchObject({ slug, title: 'The AI transparency kit' });
  });
});

describe('the audit chain', () => {
  it('verifies after a mixed run of writes, each row naming the credential used', async () => {
    await seedTags('smb');
    const byToken = await staffActor('operator', { kind: 'token', apiTokenId: 'tok_chain' }, 'tok');
    const bySession = await staffActor('superadmin', { kind: 'session' }, 'ses');
    await ideasAdminService.addIdeas(byToken, [directionInput('c-1'), directionInput('c-2')]);
    await ideasAdminService.updateIdea(bySession, 'c-1', { pitch: 'Edited.', reviewed: true });
    await ideasAdminService.retireIdea(byToken, 'c-2', 'Superseded');
    await ideasAdminService.addTag(bySession, {
      slug: 'b2b',
      label: 'B2B',
      description: 'Sold to businesses.',
    });
    await ideasAdminService.recordResearchRun(byToken, {
      areasCovered: ['logistics'],
      addedCount: 2,
      retiredCount: 1,
      reportMd: '# Run',
    });
    await ideasAdminService.deleteIdea(bySession, 'c-2', 'Cleanup');

    const rows = await ideaAuditRows();
    expect(rows.map((r) => r.action)).toEqual([
      'idea.add',
      'idea.add',
      'idea.update',
      'idea.retire',
      'idea.tag_add',
      'idea.research_run',
      'idea.delete',
    ]);
    for (const row of rows) {
      const expected =
        row.actorUserId === byToken.userId
          ? { kind: 'token', apiTokenId: 'tok_chain' }
          : { kind: 'session' };
      expect((row.metadata as { credential: unknown }).credential, row.action).toEqual(expected);
    }

    currentSession = { user: { id: bySession.userId } };
    const { platformAuditService } = await import('@/lib/services/platformAuditService');
    const verdict = await platformAuditService.verifyChain(bySession);
    expect(verdict).toMatchObject({ status: 'ok', checkedCount: rows.length + 1 });
  });
});

describe('every staff ideas route admits a staff token', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name === 'route.ts') out.push(full);
    }
    return out;
  }

  it('answers something other than the gate refusal on every exported verb (tree-enumerated)', async () => {
    const { owner, workspace } = await createTestWorkspace({ name: 'Ideas integration' });
    await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: 'superadmin' } });
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'motir-ideas',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    const files = walk(path.join(ROOT, 'app/api/platform/ideas'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    let probed = 0;
    for (const file of files) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const handler = mod[method];
        if (typeof handler !== 'function') continue;
        const req = new Request('http://localhost/api/platform/ideas/probe', {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: method === 'GET' ? undefined : '{}',
        });
        const res = (await handler(req, {
          params: Promise.resolve({ slug: 'probe' }),
        })) as Response;
        const body = (await res.json()) as { code?: string };
        const where = `${method} ${path.relative(ROOT, file)}`;
        expect(body.code, where).not.toBe('NOT_FOUND');
        probed += 1;
      }
    }
    // 10 verbs from MOTIR-7675, plus `PATCH tags/[slug]` (MOTIR-7774).
    expect(probed).toBe(11);
  });
});

describe('layering of the story’s own files', () => {
  const SOURCES = [
    'app/api/platform/ideas',
    'app/api/public/ideas',
    'lib/ideas',
    'lib/platform/ideasGate.ts',
    'lib/services/ideasAdminService.ts',
    'lib/services/ideasPublicService.ts',
    'lib/repositories/ideaRepository.ts',
    'lib/repositories/ideaPublicRepository.ts',
    'lib/repositories/ideaTagRepository.ts',
    'lib/repositories/ideaResearchRunRepository.ts',
  ];

  function filesOf(entry: string): string[] {
    const full = path.join(ROOT, entry);
    if (!statSync(full).isDirectory()) return [entry];
    return readdirSync(full).flatMap((name) => filesOf(path.join(entry, name)));
  }

  const all = SOURCES.flatMap(filesOf).filter((f) => /\.tsx?$/.test(f));
  const source = (f: string) => stripSourceComments(readFileSync(path.join(ROOT, f), 'utf8'));

  it('no ideas route imports Prisma, the db client or a repository', () => {
    const offenders = all
      .filter((f) => f.startsWith('app/'))
      .filter((f) => /@\/lib\/db['"]|@\/lib\/repositories\/|@\/generated\/prisma/.test(source(f)));
    expect(offenders).toEqual([]);
  });

  it('no $transaction outside lib/services/', () => {
    const offenders = all
      .filter((f) => !f.startsWith('lib/services/'))
      .filter((f) => /\$transaction/.test(source(f)));
    expect(offenders).toEqual([]);
  });
});
