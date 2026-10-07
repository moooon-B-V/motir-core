import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdeaNotActiveError,
  IdeaNotFoundError,
  IdeaSlugTakenError,
  IdeaTagTakenError,
  InvalidIdeaInputError,
  UnknownIdeaTagError,
} from '@/lib/ideas/errors';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformWriteUnauditedError,
} from '@/lib/platform/errors';
import { withPlatformWrite } from '@/lib/platform/context';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { directionInput, ideaAuditRows, motirBuysInput, seedTags, staffActor } from './_helpers';

/**
 * The idea store's STAFF service (Story MOTIR-7662 · MOTIR-7671), against real
 * Postgres: every write's happy path and refusal, the audit row each writes in
 * the same transaction (actor, role, credential, target), whole-batch rollback,
 * and the two genuine races — accepting either winner, with exactly one row.
 */

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('addIdeas', () => {
  it('adds a batch with evidence and tags, one audit row per idea naming the credential', async () => {
    await seedTags('smb', 'consumer');
    const actor = await staffActor('operator', { kind: 'token', apiTokenId: 'tok_1' });

    const result = await ideasAdminService.addIdeas(actor, [
      directionInput('first-idea', { tags: ['smb', 'consumer'] }),
      motirBuysInput('second-idea', { tags: ['smb'] }),
    ]);

    expect(result.slugs).toEqual(['first-idea', 'second-idea']);
    const first = await adminDb.idea.findUniqueOrThrow({
      where: { slug: 'first-idea' },
      include: { evidence: true, tags: { include: { tag: true } } },
    });
    expect(first.evidence).toHaveLength(1);
    expect(first.evidence[0]!.sourceDate?.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(first.tags.map((t) => t.tag.slug).sort()).toEqual(['consumer', 'smb']);

    const rows = await ideaAuditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: 'idea.add',
      targetKind: 'idea',
      targetId: first.id,
      targetLabel: 'first-idea',
      actorUserId: actor.userId,
      actorRole: 'operator',
    });
    expect(rows[0]!.reason).toMatch(/personal access token/);
    expect((rows[0]!.metadata as { credential: unknown }).credential).toEqual({
      kind: 'token',
      apiTokenId: 'tok_1',
    });
  });

  it('uses the stated reason, and a session credential when the console writes', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [motirBuysInput('a-console-idea')], 'Weekly refresh');
    const [row] = await ideaAuditRows();
    expect(row!.reason).toBe('Weekly refresh');
    expect((row!.metadata as { credential: unknown }).credential).toEqual({ kind: 'session' });
  });

  it('refuses the whole batch on one invalid idea and names every problem', async () => {
    const actor = await staffActor('operator');
    const bad = directionInput('Bad Slug', {
      evidence: [
        { claim: 'c', sourceName: 's', url: 'http://insecure.test', sourceDate: '2026-02-30' },
      ],
      whyMotir: 'not for a direction',
    });
    const err = await ideasAdminService
      .addIdeas(actor, [directionInput('good-one'), bad])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidIdeaInputError);
    const fields = (err as InvalidIdeaInputError).issues.map((i) => i.field);
    expect(fields).toEqual(
      expect.arrayContaining(['slug', 'whyMotir', 'evidence[0].url', 'evidence[0].sourceDate']),
    );
    expect(await adminDb.idea.count()).toBe(0);
    expect(await ideaAuditRows()).toHaveLength(0);
  });

  it('refuses a direction with no evidence, an empty batch and an oversized one', async () => {
    const actor = await staffActor('operator');
    await expect(
      ideasAdminService.addIdeas(actor, [directionInput('no-evidence', { evidence: [] })]),
    ).rejects.toBeInstanceOf(InvalidIdeaInputError);
    await expect(ideasAdminService.addIdeas(actor, [])).rejects.toBeInstanceOf(
      InvalidIdeaInputError,
    );
    const many = Array.from({ length: 21 }, (_, i) => motirBuysInput(`idea-${i}`));
    await expect(ideasAdminService.addIdeas(actor, many)).rejects.toBeInstanceOf(
      InvalidIdeaInputError,
    );
  });

  it('refuses the whole batch on an unknown tag, naming it', async () => {
    await seedTags('smb');
    const actor = await staffActor('operator');
    const err = await ideasAdminService
      .addIdeas(actor, [directionInput('tagged', { tags: ['smb', 'nope', 'zzz'] })])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownIdeaTagError);
    expect((err as UnknownIdeaTagError).tags).toEqual(['nope', 'zzz']);
    expect(await adminDb.idea.count()).toBe(0);
  });

  it('refuses slugs taken in the store and repeated in the batch, naming every one', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [motirBuysInput('existing')]);
    const err = await ideasAdminService
      .addIdeas(actor, [
        motirBuysInput('existing'),
        motirBuysInput('twice'),
        motirBuysInput('twice'),
        motirBuysInput('fresh'),
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdeaSlugTakenError);
    expect((err as IdeaSlugTakenError).slugs).toEqual(['existing', 'twice']);
    expect(await adminDb.idea.count()).toBe(1);
    expect(await ideaAuditRows()).toHaveLength(1);
  });

  it('rolls the ideas back when the audit append fails', async () => {
    const actor = await staffActor('operator');
    vi.spyOn(platformAuditLogRepository, 'create').mockRejectedValueOnce(
      new Error('append failed'),
    );
    await expect(
      ideasAdminService.addIdeas(actor, [motirBuysInput('rolled-back')]),
    ).rejects.toThrow('append failed');
    expect(await adminDb.idea.count()).toBe(0);
  });

  it('refuses a support-level actor before writing anything', async () => {
    const actor = await staffActor('support');
    await expect(
      ideasAdminService.addIdeas(actor, [motirBuysInput('nope')]),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('lets exactly one of two concurrent overlapping batches commit', async () => {
    const actor = await staffActor('operator');
    const results = await Promise.allSettled([
      ideasAdminService.addIdeas(actor, [motirBuysInput('shared'), motirBuysInput('only-a')]),
      ideasAdminService.addIdeas(actor, [motirBuysInput('shared'), motirBuysInput('only-b')]),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdeaSlugTakenError);
    expect(await adminDb.idea.count()).toBe(2);
    expect(await ideaAuditRows()).toHaveLength(2);
  });
});

describe('validation, field by field', () => {
  it('names every rule a new idea breaks, in one refusal', async () => {
    const actor = await staffActor('operator');
    const long = (n: number) => 'x'.repeat(n + 1);
    const attempt = ideasAdminService.addIdeas(actor, [
      {
        slug: 'all-wrong',
        title: long(120),
        pitch: '   ',
        kind: 'maybe' as never,
        category: 'astrology' as never,
        capabilities: [...Array.from({ length: 8 }, () => 'ok'), ' '],
        tags: ['a', 'b', 'c', 'd', 'e', 'f', 'a'],
        evidence: [
          ...Array.from({ length: 10 }, () => ({
            claim: 'c',
            sourceName: 's',
            url: 'https://ok.example',
          })),
          { claim: ' ', sourceName: '', url: 'http://plain.example', sourceDate: '2026-02-30' },
          { claim: 'c', sourceName: 's', url: 'not a url', sourceDate: 'May 2026' },
        ],
        gap: long(600),
      },
    ]);
    await expect(attempt).rejects.toBeInstanceOf(InvalidIdeaInputError);
    const err = (await attempt.catch((e: unknown) => e)) as InvalidIdeaInputError;
    expect(new Set(err.issues.map((i) => i.field))).toEqual(
      new Set([
        'title',
        'pitch',
        'kind',
        'category',
        'gap',
        'capabilities',
        'capabilities[8]',
        'tags',
        'evidence',
        'evidence[10].claim',
        'evidence[10].sourceName',
        'evidence[10].url',
        'evidence[10].sourceDate',
        'evidence[11].url',
        'evidence[11].sourceDate',
      ]),
    );
    expect(await adminDb.idea.count()).toBe(0);
  });

  it('refuses a tag with a bad slug, no label or no description, naming each', async () => {
    const actor = await staffActor('operator');
    const attempt = ideasAdminService.addTag(actor, {
      slug: 'Not A Slug',
      label: ' ',
      description: '',
    });
    const err = (await attempt.catch((e: unknown) => e)) as InvalidIdeaInputError;
    expect(err).toBeInstanceOf(InvalidIdeaInputError);
    expect(err.issues.map((i) => i.field)).toEqual(['slug', 'label', 'description']);
    const blank = (await ideasAdminService
      .addTag(actor, { slug: '', label: 'L', description: 'D' })
      .catch((e: unknown) => e)) as InvalidIdeaInputError;
    expect(blank.issues).toEqual([expect.objectContaining({ slug: null, field: 'slug' })]);
  });

  it('refuses a research run covering more areas than the cap', async () => {
    const actor = await staffActor('operator');
    const attempt = ideasAdminService.recordResearchRun(actor, {
      areasCovered: Array.from({ length: 41 }, (_, i) => `area-${i}`),
      addedCount: 0,
      retiredCount: 0,
      reportMd: '# Run',
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidIdeaInputError);
  });
});

describe('updateIdea', () => {
  it('applies a sparse patch, replaces evidence and tags, stamps the review and names the fields', async () => {
    await seedTags('smb', 'consumer');
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('to-edit', { tags: ['smb'] })]);

    const dto = await ideasAdminService.updateIdea(actor, 'to-edit', {
      title: 'A better title',
      tags: ['consumer'],
      evidence: [
        { claim: 'New claim one', sourceName: 'S1', url: 'https://a.test/1', sourceDate: null },
        {
          claim: 'New claim two',
          sourceName: 'S2',
          url: 'https://a.test/2',
          sourceDate: '2025-10-01',
        },
      ],
      gap: '   ',
      reviewed: true,
    });

    expect(dto.title).toBe('A better title');
    expect(dto.tags.map((t) => t.slug)).toEqual(['consumer']);
    expect(dto.evidence.map((e) => e.claim)).toEqual(['New claim one', 'New claim two']);
    expect(dto.evidence[1]!.sourceDate).toBe('2025-10-01');
    expect(dto.gap).toBeNull();
    expect(dto.lastReviewedAt).not.toBeNull();

    const rows = await ideaAuditRows();
    expect(rows.at(-1)).toMatchObject({ action: 'idea.update', targetLabel: 'to-edit' });
    expect((rows.at(-1)!.metadata as { fields: string[] }).fields).toEqual([
      'title',
      'gap',
      'evidence',
      'tags',
      'lastReviewedAt',
    ]);
  });

  it('edits kind, category, pitch, capabilities and the motir-buys fields', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('to-flip')]);
    const dto = await ideasAdminService.updateIdea(actor, 'to-flip', {
      kind: 'motir_buys',
      category: 'finance',
      pitch: 'New pitch',
      capabilities: ['One'],
      whyNow: 'Now',
      whyMotir: 'Because',
      whoElse: 'Them',
      reason: 'Reclassified',
    });
    expect(dto).toMatchObject({
      kind: 'motir_buys',
      category: { slug: 'finance', label: 'Finance' },
      pitch: 'New pitch',
      capabilities: ['One'],
      whyNow: 'Now',
      whyMotir: 'Because',
      whoElse: 'Them',
    });
    expect((await ideaAuditRows()).at(-1)!.reason).toBe('Reclassified');
  });

  it('refuses an unknown slug, an empty patch, and a merged result that breaks a rule', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('edit-me')]);
    await expect(
      ideasAdminService.updateIdea(actor, 'missing', { title: 'x' }),
    ).rejects.toBeInstanceOf(IdeaNotFoundError);
    await expect(ideasAdminService.updateIdea(actor, 'edit-me', {})).rejects.toBeInstanceOf(
      InvalidIdeaInputError,
    );
    await expect(
      ideasAdminService.updateIdea(actor, 'edit-me', { whyMotir: 'only for motir_buys' }),
    ).rejects.toBeInstanceOf(InvalidIdeaInputError);
    await expect(
      ideasAdminService.updateIdea(actor, 'edit-me', { tags: ['unknown'] }),
    ).rejects.toBeInstanceOf(UnknownIdeaTagError);
    expect(await ideaAuditRows()).toHaveLength(1);
  });
});

describe('retireIdea', () => {
  it('retires with the reason on the idea and on its audit row', async () => {
    const actor = await staffActor('operator', { kind: 'token', apiTokenId: 'tok_9' });
    await ideasAdminService.addIdeas(actor, [motirBuysInput('to-retire')]);
    const dto = await ideasAdminService.retireIdea(actor, 'to-retire', '  The market moved  ');
    expect(dto).toMatchObject({ status: 'retired', retiredReason: 'The market moved' });
    expect(dto.retiredAt).not.toBeNull();
    const row = (await ideaAuditRows()).at(-1)!;
    expect(row).toMatchObject({ action: 'idea.retire', reason: 'The market moved' });
    expect((row.metadata as { credential: unknown }).credential).toEqual({
      kind: 'token',
      apiTokenId: 'tok_9',
    });
  });

  it('refuses a blank reason, an already-retired idea and an unknown slug', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [motirBuysInput('retire-twice')]);
    await expect(ideasAdminService.retireIdea(actor, 'retire-twice', '  ')).rejects.toBeInstanceOf(
      InvalidIdeaInputError,
    );
    await expect(
      ideasAdminService.retireIdea(actor, 'retire-twice', 'x'.repeat(2001)),
    ).rejects.toBeInstanceOf(InvalidIdeaInputError);
    await ideasAdminService.retireIdea(actor, 'retire-twice', 'Done');
    await expect(
      ideasAdminService.retireIdea(actor, 'retire-twice', 'Again'),
    ).rejects.toBeInstanceOf(IdeaNotActiveError);
    await expect(ideasAdminService.retireIdea(actor, 'missing', 'Gone')).rejects.toBeInstanceOf(
      IdeaNotFoundError,
    );
    expect((await ideaAuditRows()).map((r) => r.action)).toEqual(['idea.add', 'idea.retire']);
  });

  it('lets exactly one of two concurrent retires succeed, with one audit row', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [motirBuysInput('raced')]);
    const results = await Promise.allSettled([
      ideasAdminService.retireIdea(actor, 'raced', 'First'),
      ideasAdminService.retireIdea(actor, 'raced', 'Second'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(IdeaNotActiveError);
    expect((await ideaAuditRows()).filter((r) => r.action === 'idea.retire')).toHaveLength(1);
  });
});

describe('deleteIdea', () => {
  it('lets a superadmin delete, cascading evidence, and keeps the slug and title on the row', async () => {
    const operator = await staffActor('operator');
    const superadmin = await staffActor('superadmin');
    await ideasAdminService.addIdeas(operator, [directionInput('to-delete')]);
    await ideasAdminService.deleteIdea(superadmin, 'to-delete', 'Added by mistake');
    expect(await adminDb.idea.count()).toBe(0);
    expect(await adminDb.ideaEvidence.count()).toBe(0);
    const row = (await ideaAuditRows()).at(-1)!;
    expect(row).toMatchObject({
      action: 'idea.delete',
      actorRole: 'superadmin',
      reason: 'Added by mistake',
    });
    expect(row.metadata).toMatchObject({ slug: 'to-delete', title: 'Direction to-delete' });
  });

  it('refuses an operator, a blank reason and an unknown slug, writing nothing', async () => {
    const operator = await staffActor('operator');
    const superadmin = await staffActor('superadmin');
    await ideasAdminService.addIdeas(operator, [motirBuysInput('keep-me')]);
    await expect(ideasAdminService.deleteIdea(operator, 'keep-me', 'No')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    await expect(ideasAdminService.deleteIdea(superadmin, 'keep-me', '')).rejects.toBeInstanceOf(
      InvalidIdeaInputError,
    );
    await expect(ideasAdminService.deleteIdea(superadmin, 'missing', 'x')).rejects.toBeInstanceOf(
      IdeaNotFoundError,
    );
    expect(await adminDb.idea.count()).toBe(1);
    expect(await ideaAuditRows()).toHaveLength(1);
  });
});

describe('tags and research runs', () => {
  it('adds a tag with its stated reason and refuses a duplicate or a reasonless one', async () => {
    const actor = await staffActor('operator');
    const tag = await ideasAdminService.addTag(actor, {
      slug: 'eu-ai-act',
      label: 'EU AI Act',
      description: 'Ideas the EU AI Act creates or reshapes',
    });
    expect(tag).toEqual({
      slug: 'eu-ai-act',
      label: 'EU AI Act',
      description: 'Ideas the EU AI Act creates or reshapes',
      count: 0,
    });
    await expect(
      ideasAdminService.addTag(actor, { slug: 'eu-ai-act', label: 'Again', description: 'Dup' }),
    ).rejects.toBeInstanceOf(IdeaTagTakenError);
    const err = await ideasAdminService
      .addTag(actor, { slug: 'Bad Slug', label: '', description: ' ' })
      .catch((e: unknown) => e);
    expect((err as InvalidIdeaInputError).issues.map((i) => i.field)).toEqual([
      'slug',
      'label',
      'description',
    ]);
    const rows = await ideaAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'idea.tag_add', targetLabel: 'tag:eu-ai-act' });

    const listed = await ideasAdminService.listTags(actor);
    expect(listed.map((t) => t.slug)).toEqual(['eu-ai-act']);
  });

  it('records a research run and lists the recent ones', async () => {
    const actor = await staffActor('operator', { kind: 'token', apiTokenId: 'tok_r' });
    const run = await ideasAdminService.recordResearchRun(actor, {
      areasCovered: ['legal', ' ', 'pets'],
      addedCount: 3,
      retiredCount: 1,
      reportMd: '# Report',
    });
    expect(run).toMatchObject({
      areasCovered: ['legal', 'pets'],
      addedCount: 3,
      actorUserId: actor.userId,
    });
    const runs = await ideasAdminService.listResearchRuns(actor, 5);
    expect(runs.map((r) => r.id)).toEqual([run.id]);
    expect((await ideaAuditRows())[0]).toMatchObject({
      action: 'idea.research_run',
      targetId: run.id,
    });

    await expect(
      ideasAdminService.recordResearchRun(actor, {
        areasCovered: [],
        addedCount: -1,
        retiredCount: 1.5,
        reportMd: '',
      }),
    ).rejects.toBeInstanceOf(InvalidIdeaInputError);
  });
});

describe('staff reads', () => {
  it('lists every status by default, filters, and pages with a cursor', async () => {
    await seedTags('smb');
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [
      directionInput('alpha', { tags: ['smb'] }),
      motirBuysInput('beta', { title: 'Needle in the title' }),
      directionInput('gamma', { category: 'pets' }),
    ]);
    await ideasAdminService.retireIdea(actor, 'gamma', 'Stale');

    const all = await ideasAdminService.listForStaff(actor);
    expect(all.items.map((i) => i.slug).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(all.nextCursor).toBeNull();

    expect(
      (await ideasAdminService.listForStaff(actor, { status: 'retired' })).items.map((i) => i.slug),
    ).toEqual(['gamma']);
    expect(
      (await ideasAdminService.listForStaff(actor, { kind: 'motir_buys' })).items.map(
        (i) => i.slug,
      ),
    ).toEqual(['beta']);
    expect(
      (await ideasAdminService.listForStaff(actor, { category: 'pets' })).items.map((i) => i.slug),
    ).toEqual(['gamma']);
    expect(
      (await ideasAdminService.listForStaff(actor, { tag: 'smb' })).items.map((i) => i.slug),
    ).toEqual(['alpha']);
    expect(
      (await ideasAdminService.listForStaff(actor, { q: 'needle' })).items.map((i) => i.slug),
    ).toEqual(['beta']);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await ideasAdminService.listForStaff(actor, { limit: 1, cursor });
      seen.push(...page.items.map((i) => i.slug));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['alpha', 'beta', 'gamma']);

    await expect(
      ideasAdminService.listForStaff(actor, { cursor: 'garbage' }),
    ).rejects.toBeInstanceOf(InvalidIdeaInputError);
  });

  it('reads one idea of any status, and refuses an unknown slug', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [motirBuysInput('one')]);
    await ideasAdminService.retireIdea(actor, 'one', 'Old');
    expect((await ideasAdminService.getForStaff(actor, 'one')).status).toBe('retired');
    await expect(ideasAdminService.getForStaff(actor, 'missing')).rejects.toBeInstanceOf(
      IdeaNotFoundError,
    );
  });
});

describe('withPlatformWrite', () => {
  it('rolls back a write that records no audit row', async () => {
    const actor = await staffActor('operator');
    await expect(withPlatformWrite(actor, async () => 'nothing recorded')).rejects.toBeInstanceOf(
      PlatformWriteUnauditedError,
    );
  });

  it('refuses a row whose action needs a reason it was not given', async () => {
    const actor = await staffActor('operator');
    await expect(
      withPlatformWrite(actor, (_tx, record) =>
        record({ action: 'idea.retire', targetKind: 'idea', targetId: 'x' }),
      ),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(await ideaAuditRows()).toHaveLength(0);
  });
});
