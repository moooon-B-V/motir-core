import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toProjectAutoTranslateChangeDTO } from '@/lib/mappers/projectAutoTranslateSettingsMappers';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { projectSettingChangeRepository } from '@/lib/repositories/projectSettingChangeRepository';
import { projectAutoTranslateSettingsService } from '@/lib/services/projectAutoTranslateSettingsService';
import { adminDb } from '../../helpers/adminDb';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';
import {
  billedUnits,
  readerScope,
  sessionUser,
  translateJobs,
} from './helpers/translationStoryFixture';
import { press, registerStorySeam, story } from './helpers/translationStoryHarness';
import { resolveSurfaceTranslation } from '@/lib/pages/surfaceTranslation';
import { readerTranslationContextService } from '@/lib/services/readerTranslationContextService';
import { projectsService } from '@/lib/services/projectsService';
import {
  autoStory,
  echoedTitle,
  cloudBilling,
  enable,
  flip,
  itemInOtherProject,
  outsiderOf,
  readSwitch,
  titlesWithoutSession,
  readerIn,
  rowsOfTitles,
  switchOf,
  titles,
  trail,
} from './helpers/autoTranslateStoryHarness';

// THE AUTO-TRANSLATE STORY, ASSEMBLED — the switch, the shared titles, the gates
// (Story MOTIR-7738 · Subtask MOTIR-8835). The real settings and batch routes, the
// real many-titles door, the real advisory locks and kept-translation store, the
// real RLS, all in a real database under the tenant context; only motir-ai is
// replaced, on the WIRE, by the in-repo jobs mock. A charge is read from the
// mock's own job record: one billed unit per accepted `translate` job that
// succeeded. What a reader is charged for is `autoTranslateStoryCharges.test.ts`.

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => readerScope.getStore()?.ctx ?? null };
});
vi.mock('next-intl/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl/server')>();
  return { ...actual, getLocale: async () => readerScope.getStore()?.locale ?? 'en' };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSession: async () => (sessionUser.current ? { user: sessionUser.current } : null),
  };
});

const seam = registerStorySeam();

// Billing is self-host unless a case turns the cloud on, so none inherits it.
beforeEach(() => cloudBilling(false));

describe('the switch', () => {
  it('while OFF the on-demand press still translates and bills exactly one job', async () => {
    const s = await autoStory(1);
    const res = await press(s.owner, s.ids[0]!);

    expect(res.status).toBe(200);
    expect(res.body.fields.map((f) => f.status)).toEqual(['ready']);
    expect(translateJobs(seam())).toHaveLength(1);
    expect(billedUnits(seam())).toBe(1);
  });

  it('is OFF by default: the batch answers enabled:false, spends nothing, keeps nothing', async () => {
    const s = await autoStory();
    const res = await titles(s.owner, s);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, targetLanguage: 'ko', titles: [] });
    expect(translateJobs(seam())).toHaveLength(0);
    expect(await rowsOfTitles()).toBe(0);
  });

  it('an administrator flips it on, and the trail records who and when', async () => {
    const s = await autoStory();
    const on = await flip(s.owner, s, true);

    expect(on.status).toBe(200);
    expect(on.body.autoTranslateWorkContent).toBe(true);
    expect(await switchOf(s)).toBe(true);
    const log = await trail(s);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      changedByUserId: s.owner.ctx.userId,
      fromEnabled: false,
      toEnabled: true,
    });
    const read = await readSwitch(s.owner, s);
    expect(read.body).toMatchObject({ autoTranslateWorkContent: true, totalChanges: 1 });
  });

  it('a plain member READS the state but cannot change it', async () => {
    const s = await autoStory();
    const member = await readerIn(s, 'member@example.com', 'de');

    expect((await readSwitch(member, s)).status).toBe(200);
    const refused = await flip(member, s, true);
    expect(refused.status).toBe(403);
    expect(await switchOf(s)).toBe(false);
    expect(await trail(s)).toHaveLength(0);
  });

  it('naming the held value writes no trail row', async () => {
    const s = await autoStory();
    await flip(s.owner, s, true);
    await flip(s.owner, s, true);
    expect(await trail(s)).toHaveLength(1);
  });
});

describe('the trail', () => {
  it('outlives the person who flipped: their id and name go null, the record stays', async () => {
    const s = await autoStory();
    const admin = await readerIn(s, 'leaver@example.com', 'ko');
    await addToProjectAs({
      key: s.key,
      actorUserId: s.owner.ctx.userId,
      ctx: s.owner.ctx,
      targetUserId: admin.ctx.userId,
      role: 'admin',
    });
    expect((await flip(admin, s, true)).status).toBe(200);
    await adminDb.user.delete({ where: { id: admin.ctx.userId } });

    const read = await readSwitch(s.owner, s);
    expect(read.body.changes).toHaveLength(1);
    expect(read.body.changes[0]).toMatchObject({ changedByUserId: null, changedByName: null });
  });

  it('keeps the id and shows no name when the actor does not resolve', async () => {
    const s = await autoStory();
    await flip(s.owner, s, true);
    const [row] = await trail(s);

    expect(toProjectAutoTranslateChangeDTO(row!, new Map())).toMatchObject({
      changedByUserId: s.owner.ctx.userId,
      changedByName: null,
    });
  });

  it('a project that vanishes under a read or a flip is ProjectNotFoundError, never a half write', async () => {
    const s = await autoStory();
    vi.spyOn(projectRepository, 'findAutoTranslateWorkContent').mockResolvedValueOnce(null);
    await expect(
      projectAutoTranslateSettingsService.getSettings(s.projectId, s.owner.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    vi.spyOn(projectRepository, 'lockById').mockResolvedValueOnce(null);
    await expect(
      projectAutoTranslateSettingsService.updateSettings(
        s.projectId,
        { autoTranslateWorkContent: true },
        s.owner.ctx,
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    vi.spyOn(projectRepository, 'findAutoTranslateWorkContent').mockResolvedValueOnce(null);
    await expect(
      projectAutoTranslateSettingsService.updateSettings(
        s.projectId,
        { autoTranslateWorkContent: true },
        s.owner.ctx,
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    vi.restoreAllMocks();
    expect(await switchOf(s)).toBe(false);
    expect(await trail(s)).toHaveLength(0);
  });

  it('is invisible to a read outside any tenant context (row-level security)', async () => {
    const s = await autoStory();
    await flip(s.owner, s, true);
    await flip(s.owner, s, false);

    expect(await trail(s)).toHaveLength(2);
    expect(await projectSettingChangeRepository.countByProject(s.projectId)).toBe(0);
    expect(await projectSettingChangeRepository.listRecentByProject(s.projectId, 10)).toEqual([]);
  });

  it('an empty patch is a read: nothing is written', async () => {
    const s = await autoStory();
    const dto = await projectAutoTranslateSettingsService.updateSettings(
      s.projectId,
      {},
      s.owner.ctx,
    );

    expect(dto.autoTranslateWorkContent).toBe(false);
    expect(await trail(s)).toHaveLength(0);
  });
});

describe('shared titles', () => {
  it('a Korean batch is ONE job for all the titles, kept per item', async () => {
    const s = await autoStory(3);
    await flip(s.owner, s, true);
    const res = await titles(s.owner, s);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.titles.map((t) => t.status)).toEqual(['ready', 'ready', 'ready']);
    expect(res.body.titles.map((t) => (t.status === 'ready' ? t.text : null)).sort()).toEqual([
      echoedTitle('ko', 1),
      echoedTitle('ko', 2),
      echoedTitle('ko', 3),
    ]);
    expect(translateJobs(seam())).toHaveLength(1);
    expect(billedUnits(seam())).toBe(1);
    expect(await rowsOfTitles()).toBe(3);
  });

  it('a second Korean reader, and a repeat, cost zero jobs and read the same text', async () => {
    const s = await autoStory(3);
    await enable(s);
    const first = await titles(s.owner, s);
    const second = await titles(await readerIn(s, 'ko2@example.com', 'ko'), s);
    const repeat = await titles(s.owner, s);

    expect(second.body.titles).toEqual(first.body.titles);
    expect(repeat.body.titles).toEqual(first.body.titles);
    expect(translateJobs(seam())).toHaveLength(1);
    expect(billedUnits(seam())).toBe(1);
  });

  it('a German reader is a different language: ONE more job, and Korean rows stay', async () => {
    const s = await autoStory(2);
    await enable(s);
    await titles(s.owner, s);
    const de = await titles(await readerIn(s, 'de@example.com', 'de'), s);

    expect(de.body.titles.every((t) => t.status === 'ready')).toBe(true);
    expect(translateJobs(seam())).toHaveLength(2);
    expect(await rowsOfTitles()).toBe(4);
  });

  it('a Korean and a German reader asking at once each get their own language, from one job apiece', async () => {
    const s = await autoStory(2);
    await enable(s);
    const de = await readerIn(s, 'de@example.com', 'de');
    const [ko, german] = await Promise.all([titles(s.owner, s), titles(de, s)]);

    expect(ko.body.titles.every((t) => t.status === 'ready' && t.text.startsWith('[ko] '))).toBe(
      true,
    );
    expect(
      german.body.titles.every((t) => t.status === 'ready' && t.text.startsWith('[de] ')),
    ).toBe(true);
    expect(ko.body.titles.every((t) => t.status === 'ready' && t.sourceLanguage === 'en')).toBe(
      true,
    );
    expect(translateJobs(seam())).toHaveLength(2);
    expect(await rowsOfTitles()).toBe(4);

    const third = await titles(await readerIn(s, 'ko3@example.com', 'ko'), s);
    expect(third.body.titles).toEqual(ko.body.titles);
    expect(translateJobs(seam())).toHaveLength(2);
  });

  it('a Chinese title is never sent to a Chinese reader, and billing is not even asked', async () => {
    cloudBilling(true);
    const zh = await story();
    const s = {
      caller: zh.caller,
      projectId: zh.caller.fixture.projectId,
      key: zh.caller.projectKey,
      ids: [zh.itemId],
      keys: [zh.key],
      owner: { ctx: zh.owner.ctx, locale: 'zh' as const },
    };
    await enable(s);
    const res = await titles(s.owner, s);
    const project = await projectsService.getByKey(s.key, s.owner.ctx);
    const verdicts = await readerScope.run(s.owner, () =>
      readerTranslationContextService.resolveForTitles({
        project,
        reader: s.owner.ctx,
        readerLocale: 'zh',
        titles: [{ id: zh.itemId, title: '为所有客户构建导出功能', language: 'zh' }],
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.titles).toEqual([]);
    expect(translateJobs(seam())).toHaveLength(0);
    expect(verdicts!.context.credit).toBe('ok');
    expect(seam().usageReads).toBe(0);
  });

  it('a title already in the reader’s language is not sent', async () => {
    const s = await autoStory(2);
    await enable(s);
    const english = await readerIn(s, 'en@example.com', 'en');
    const res = await titles(english, s);

    expect(res.status).toBe(200);
    expect(translateJobs(seam())).toHaveLength(0);
    expect(res.body.titles.every((t) => t.status !== 'ready')).toBe(true);
  });

  it('switching it off stops reads and spending; kept rows survive and serve again at no charge', async () => {
    const s = await autoStory(2);
    await flip(s.owner, s, true);
    await titles(s.owner, s);
    await flip(s.owner, s, false);

    const off = await titles(s.owner, s);
    expect(off.body).toMatchObject({ enabled: false, titles: [] });
    expect(translateJobs(seam())).toHaveLength(1);
    expect(await rowsOfTitles()).toBe(2);

    await flip(s.owner, s, true);
    const back = await titles(s.owner, s);
    expect(back.body.titles.every((t) => t.status === 'ready')).toBe(true);
    expect(translateJobs(seam())).toHaveLength(1);
    expect(await trail(s)).toHaveLength(3);
  });
});

describe('the item page path', () => {
  it('the press the page makes on mount keeps every field, and a later reader is free', async () => {
    const s = await autoStory(1);
    await flip(s.owner, s, true);
    const project = await projectsService.getByKey(s.key, s.owner.ctx);
    const context = await readerScope.run(s.owner, () =>
      resolveSurfaceTranslation(project, s.owner.ctx),
    );
    expect(context).toMatchObject({ autoTranslateWorkContent: true, targetLanguage: 'ko' });

    const mine = await press(s.owner, s.ids[0]!);
    expect(mine.body.fields.map((f) => f.status)).toEqual(['ready']);
    const other = await press(await readerIn(s, 'ko2@example.com', 'ko'), s.ids[0]!);
    expect(other.body).toEqual(mine.body);
    expect(translateJobs(seam())).toHaveLength(1);
    expect(await rowsOfTitles()).toBe(1);
  });
});

describe('the switch is the ceiling', () => {
  it('a surface that resolved ON before the flip is answered enabled:false and spends nothing', async () => {
    const s = await autoStory(2);
    await flip(s.owner, s, true);
    const project = await projectsService.getByKey(s.key, s.owner.ctx);
    const before = await readerScope.run(s.owner, () =>
      resolveSurfaceTranslation(project, s.owner.ctx),
    );
    expect(before?.autoTranslateWorkContent).toBe(true);

    await flip(s.owner, s, false);
    const after = await titles(s.owner, s);

    expect(after.body).toMatchObject({ enabled: false, titles: [] });
    expect(translateJobs(seam())).toHaveLength(0);
    expect(await rowsOfTitles()).toBe(0);
  });
});

describe('the gates', () => {
  it('another workspace’s and another project’s ids are absent, like an id that does not exist', async () => {
    const s = await autoStory(1);
    const foreign = await autoStory(1);
    const sibling = await itemInOtherProject(s);
    await enable(s);
    const res = await titles(s.owner, s, [s.ids[0]!, foreign.ids[0]!, sibling, 'no-such-id']);

    expect(res.status).toBe(200);
    expect(res.body.titles.map((t) => t.workItemId)).toEqual([s.ids[0]]);
    expect(translateJobs(seam())).toHaveLength(1);
    expect(translateJobs(seam())[0]!.translate!.fields).toHaveLength(1);
  });

  it('no session is refused before anything is read or submitted', async () => {
    const s = await autoStory(1);
    await enable(s);

    expect(await titlesWithoutSession(s)).toBe(401);
    expect(translateJobs(seam())).toHaveLength(0);
  });

  it('a Visitor is answered no context at all', async () => {
    const s = await autoStory(1);
    await enable(s);
    const project = await projectsService.getByKey(s.key, s.owner.ctx);
    const visitor = {
      kind: 'visitor' as const,
      project: {} as never,
      actorUserId: s.owner.ctx.userId,
      permissions: new Set<never>(),
      hiddenIds: new Set<string>(),
    };

    expect(
      readerTranslationContextService.resolveContext({
        project,
        reader: visitor,
        readerLocale: 'ko',
      }),
    ).toBeNull();
    expect(
      await readerTranslationContextService.resolveForTitles({
        project,
        reader: visitor,
        readerLocale: 'ko',
        titles: [],
      }),
    ).toBeNull();
  });

  it('a reader who cannot open the project gets 404 from both doors and costs nothing', async () => {
    const s = await autoStory();
    await enable(s);
    const outsider = await outsiderOf(s, 'outsider@example.com', 'ko');

    expect((await titles(outsider, s)).status).toBe(404);
    expect((await readSwitch(outsider, s)).status).toBe(404);
    expect((await flip(outsider, s, false)).status).toBe(404);
    expect(translateJobs(seam())).toHaveLength(0);
    expect(await switchOf(s)).toBe(true);
  });

  it('an id from another project is omitted, never translated or billed', async () => {
    const s = await autoStory(1);
    const other = await autoStory(1);
    await enable(s);
    const res = await titles(s.owner, s, [s.ids[0]!, other.ids[0]!]);

    expect(res.status).toBe(200);
    expect(res.body.titles).toHaveLength(1);
    expect(res.body.titles[0]!.workItemId).toBe(s.ids[0]);
    expect(translateJobs(seam())).toHaveLength(1);
  });

  it('a malformed body is 400 and spends nothing', async () => {
    const s = await autoStory(1);
    await enable(s);
    const res = await titles(s.owner, s, 'nope' as unknown as string[]);
    expect(res.status).toBe(400);
    expect(translateJobs(seam())).toHaveLength(0);
  });
});
