import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocale } from 'next-intl/server';
import { resolveSurfaceTranslation, startSurfaceTranslation } from '@/lib/pages/surfaceTranslation';
import { readerTranslationContextService } from '@/lib/services/readerTranslationContextService';
import {
  billedUnits,
  readerScope,
  script,
  sessionUser,
  translateJobs,
  translateSubmits,
} from './helpers/translationStoryFixture';
import { registerStorySeam } from './helpers/translationStoryHarness';
import {
  autoStory,
  cloudBilling,
  enable,
  readerIn,
  rowsOfTitles,
  titles,
  type AutoStory,
} from './helpers/autoTranslateStoryHarness';
import { projectsService } from '@/lib/services/projectsService';

// THE AUTO-TRANSLATE STORY, ASSEMBLED — what it costs and who is told (Story
// MOTIR-7738 · Subtask MOTIR-8835). The same assembled path as
// `autoTranslateStory.test.ts`: the real batch route, door, locks and store against
// a real database, motir-ai replaced on the wire by the in-repo jobs mock. The
// credit verdict is read through the real billing path (the mock serves the usage
// and subscription reads), on a cloud build. A failed, hung or refused job is
// billed nothing, so each case reads the mock's job record.

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

/** The credit verdict a surface would carry for `s`'s English titles, read as `reader`. */
async function verdictFor(s: AutoStory, reader: Awaited<ReturnType<typeof readerIn>>) {
  const project = await projectsService.getByKey(s.key, reader.ctx);
  return readerScope.run(reader, () =>
    readerTranslationContextService.resolveForTitles({
      project,
      reader: reader.ctx,
      readerLocale: reader.locale,
      titles: s.ids.map((id, i) => ({ id, title: `Build export number ${i + 1}`, language: 'en' })),
    }),
  );
}

describe('the credit verdict', () => {
  it('a free cloud organisation is no_credit, and the owner may add credit', async () => {
    cloudBilling(true);
    const s = await autoStory();
    await enable(s);
    const res = await verdictFor(s, s.owner);

    expect(res!.context).toMatchObject({ credit: 'no_credit', canAddCredit: true });
  });

  it('a plain member of a free cloud organisation is told, with no link to add credit', async () => {
    cloudBilling(true);
    const s = await autoStory();
    await enable(s);
    const res = await verdictFor(s, await readerIn(s, 'member@example.com', 'ko'));

    expect(res!.context).toMatchObject({ credit: 'no_credit', canAddCredit: false });
  });

  it('a paid cloud organisation with a balance is ok', async () => {
    cloudBilling(true);
    const s = await autoStory();
    await enable(s);
    seam().subscriptionStatus = 'active';
    const res = await verdictFor(s, s.owner);

    expect(res!.context.credit).toBe('ok');
  });

  it('a paid organisation at zero balance is no_credit', async () => {
    cloudBilling(true);
    const s = await autoStory();
    await enable(s);
    seam().subscriptionStatus = 'active';
    seam().balance = 0;
    const res = await verdictFor(s, s.owner);

    expect(res!.context.credit).toBe('no_credit');
  });

  it('a self-host build never answers no_credit and never asks motir-ai about access', async () => {
    cloudBilling(false);
    const s = await autoStory();
    await enable(s);
    const res = await verdictFor(s, s.owner);

    expect(res!.context.credit).toBe('ok');
    expect(seam().usageReads).toBe(0);
  });

  it('a switched-off project asks nothing of billing, whatever the plan', async () => {
    cloudBilling(true);
    const s = await autoStory();
    const res = await verdictFor(s, s.owner);

    expect(res!.verdicts).toEqual({});
    expect(seam().usageReads).toBe(0);
  });

  it('a surface is handed nothing while the switch is off, and the context once it is on', async () => {
    const s = await autoStory();
    const project = await projectsService.getByKey(s.key, s.owner.ctx);
    expect(
      await readerScope.run(s.owner, () => resolveSurfaceTranslation(project, s.owner.ctx)),
    ).toBeNull();

    await enable(s);
    const on = await projectsService.getByKey(s.key, s.owner.ctx);
    expect(
      await readerScope.run(s.owner, () => resolveSurfaceTranslation(on, s.owner.ctx)),
    ).toEqual({
      autoTranslateWorkContent: true,
      targetLanguage: await readerScope.run(s.owner, () => getLocale()),
      credit: 'ok',
      canAddCredit: false,
    });
  });
});

describe('starting the read for a page', () => {
  it('resolves to the same context as the awaited read', async () => {
    const s = await autoStory();
    await enable(s);
    const project = await projectsService.getByKey(s.key, s.owner.ctx);
    const started = await readerScope.run(s.owner, () =>
      startSurfaceTranslation(project, s.owner.ctx),
    );

    expect(started).toMatchObject({ autoTranslateWorkContent: true, credit: 'ok' });
  });

  it('a read that fails degrades to no translation — the page renders as stored', async () => {
    const s = await autoStory();
    const broken = {
      get autoTranslateWorkContent(): boolean {
        throw new Error('project read failed');
      },
    };

    expect(
      await readerScope.run(s.owner, () => startSurfaceTranslation(broken, s.owner.ctx)),
    ).toBeNull();
  });
});

describe('a refused or failed job leaves no charge', () => {
  it('a refused submit answers no_credit for every title, keeps nothing, bills nothing', async () => {
    const s = await autoStory(2);
    await enable(s);
    script(seam(), [{ submit: 'out_of_credits' }]);
    const res = await titles(s.owner, s);

    expect(res.status).toBe(200);
    expect(res.body.titles.map((t) => t.status)).toEqual(['no_credit', 'no_credit']);
    expect(translateSubmits(seam())).toHaveLength(1);
    expect(translateJobs(seam())).toHaveLength(0);
    expect(billedUnits(seam())).toBe(0);
    expect(await rowsOfTitles()).toBe(0);
  });

  it('a failed job answers failed with no upstream text, and the retry bills ONE job in all', async () => {
    const s = await autoStory(2);
    await enable(s);
    script(seam(), [{ status: 'failed' }, { status: 'succeeded' }]);
    const failed = await titles(s.owner, s);

    expect(failed.body.titles.map((t) => t.status)).toEqual(['failed', 'failed']);
    const wire = JSON.stringify(failed.body);
    for (const leak of ['fixture', 'ai_job_failed', 'motir-ai', 'translation-story.test']) {
      expect(wire).not.toContain(leak);
    }
    expect(billedUnits(seam())).toBe(0);
    expect(await rowsOfTitles()).toBe(0);

    const retry = await titles(s.owner, s);
    expect(retry.body.titles.every((t) => t.status === 'ready')).toBe(true);
    expect(translateJobs(seam())).toHaveLength(2);
    expect(billedUnits(seam())).toBe(1);
  });

  it('two readers asking at once for the same language are billed ONE job', async () => {
    const s = await autoStory(2);
    await enable(s);
    const other = await readerIn(s, 'ko2@example.com', 'ko');
    const [a, b] = await Promise.all([titles(s.owner, s), titles(other, s)]);

    expect(a.body.titles.every((t) => t.status === 'ready')).toBe(true);
    expect(b.body.titles.every((t) => t.status === 'ready')).toBe(true);
    expect(billedUnits(seam())).toBe(1);
  });
});
