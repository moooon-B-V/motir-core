import { describe, expect, it, vi } from 'vitest';
import { fieldRef } from '@/lib/translation/fieldRefs';
import { createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import {
  AI_TOTAL_SPEND,
  UNIT,
  billedUnits,
  readerScope,
  script,
  sessionUser,
  translateJobs,
} from './helpers/translationStoryFixture';
import {
  agentReads,
  keepGerman,
  lockWaiters,
  mcpClient,
  press,
  pressPastTheDeadline,
  reader,
  ready,
  rows,
  statuses,
  story,
  usageJson,
  registerStorySeam,
} from './helpers/translationStoryHarness';

// THE STORY, ASSEMBLED — what a press costs, what the usage line reports, and
// what agents read (Story MOTIR-7735 · Subtask MOTIR-8124). The same assembled
// path as `translationStory.test.ts`: real route, door, locks and store against a
// real database, motir-ai replaced on the wire by the in-repo jobs mock. A failed,
// hung or refused job is billed nothing, so each case below reads the mock's job
// record for what was submitted and what succeeded.

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

describe('a failed job leaves no charge', () => {
  it('200, failed per field, nothing kept, nothing billed, no upstream text', async () => {
    const s = await story();
    script(seam(), [{ status: 'failed' }]);
    const res = await press(s.owner, s.itemId);

    expect(res.status).toBe(200);
    expect(Object.values(statuses(res.body))).toEqual(s.refs.map(() => 'failed'));
    expect(await rows()).toHaveLength(0);
    expect(billedUnits(seam())).toBe(0);
    const wire = JSON.stringify(res.body);
    for (const leak of ['fixture', 'ai_job_failed', 'motir-ai', 'translation-story.test']) {
      expect(wire).not.toContain(leak);
    }
  });

  it('the retry keeps the rows and bills ONE job across both attempts', async () => {
    const s = await story();
    script(seam(), [{ status: 'failed' }, { status: 'succeeded' }]);
    await press(s.owner, s.itemId);
    const retry = await press(s.owner, s.itemId);

    expect(retry.body.fields).toEqual(ready(s.refs, 'de'));
    expect(await rows()).toHaveLength(7);
    expect(translateJobs(seam())).toHaveLength(2);
    expect(billedUnits(seam())).toBe(1);
    expect(await lockWaiters()).toBe(0);
  });

  it('kept fields survive it: ready for the two kept, failed for the five sent', async () => {
    const s = await story();
    const keptRefs = [fieldRef.title(), fieldRef.description()];
    await keepGerman(s, keptRefs);
    script(seam(), [{ status: 'failed' }]);
    const res = await press(s.owner, s.itemId);

    const sent = translateJobs(seam())[0]!.translate!.fields.map((f) => f.fieldRef);
    expect(sent).toEqual(s.refs.slice(2));
    expect(statuses(res.body)).toEqual(
      Object.fromEntries(s.refs.map((r) => [r, keptRefs.includes(r) ? 'ready' : 'failed'])),
    );
    expect(await rows()).toHaveLength(2);
  });
});

describe('a hung job and no credit leave no charge', () => {
  it('a hung job: timeout per field, nothing kept, nothing billed, the lock released', async () => {
    const s = await story();
    script(seam(), [{ status: 'running' }]);
    const res = await pressPastTheDeadline(seam(), s.owner, s.itemId);

    expect(res.status).toBe(200);
    expect(Object.values(statuses(res.body))).toEqual(s.refs.map(() => 'timeout'));
    expect(await rows()).toHaveLength(0);
    expect(billedUnits(seam())).toBe(0);
    // The lock was released: the next press runs at once and translates.
    script(seam(), [{ status: 'running' }, { status: 'succeeded' }]);
    expect((await press(s.owner, s.itemId)).body.fields).toEqual(ready(s.refs, 'de'));
  }, 60_000);

  it('out of credits: no_credit per field, nothing kept or billed; with credit it translates', async () => {
    const s = await story();
    script(seam(), [{ submit: 'out_of_credits' }, { submit: 'accepted' }]);
    const refused = await press(s.owner, s.itemId);

    expect(refused.status).toBe(200);
    expect(Object.values(statuses(refused.body))).toEqual(s.refs.map(() => 'no_credit'));
    expect(await rows()).toHaveLength(0);
    expect(translateJobs(seam())).toHaveLength(0);
    expect(billedUnits(seam())).toBe(0);
    expect((await press(s.owner, s.itemId)).body.fields).toEqual(ready(s.refs, 'de'));
    expect(billedUnits(seam())).toBe(1);
  });
});

describe('the Translation usage line', () => {
  it('carries the block verbatim; it moves on a success, not on a failure or a refusal', async () => {
    const s = await story();
    expect((await usageJson(s)).translation).toEqual({ totalSpend: 0, monthSpend: 0 });
    script(seam(), [{ status: 'failed' }, { submit: 'out_of_credits' }, { status: 'succeeded' }]);
    await press(s.owner, s.itemId);
    await press(s.owner, s.itemId);
    expect((await usageJson(s)).translation).toEqual({ totalSpend: 0, monthSpend: 0 });

    await press(s.owner, s.itemId);
    const after = await usageJson(s);
    expect(after.translation).toEqual({ totalSpend: UNIT, monthSpend: UNIT });
    // Not folded into the AI figures.
    expect(after.totalSpend).toBe(AI_TOTAL_SPEND);
  });

  it('an absent block is null, a zero block is zeros, and the two differ', async () => {
    const s = await story();
    seam().usageMode = 'absent';
    const absent = (await usageJson(s)).translation;
    seam().usageMode = 'zero';
    const zero = (await usageJson(s)).translation;

    expect(absent).toBeNull();
    expect(zero).toEqual({ totalSpend: 0, monthSpend: 0 });
    expect(zero).not.toEqual(absent);
  });
});

describe('agents read the original', () => {
  it('get_work_item, the REST read and the dispatch prompt are word for word unchanged', async () => {
    const s = await story();
    const client = await mcpClient(s);
    const before = await agentReads(s, client);
    await press(s.owner, s.itemId);
    await press(await reader(s, 'fr@example.com', 'fr'), s.itemId);
    expect(await rows()).toHaveLength(14);

    const after = await agentReads(s, client);
    expect(after).toEqual(before);
    for (const payload of Object.values(after)) {
      for (const key of ['anyNeedsTranslation', 'needsTranslation', 'sourceLanguage', '"kept"']) {
        expect(payload).not.toContain(key);
      }
      expect(payload).not.toContain('[de]');
      expect(payload).not.toContain('[fr]');
    }
  });

  it('a body or query naming another language, user or organisation changes nothing', async () => {
    const s = await story();
    const other = await createV1ProjectCaller({ workspaceName: 'Other', identifier: 'OTH' });
    const body = {
      targetLanguage: 'fr',
      userId: other.fixture.ownerId,
      organizationId: other.fixture.workspace.organizationId,
    };
    const res = await press(s.owner, s.itemId, body, '?targetLanguage=ja&lang=ja');

    expect(res.body.targetLanguage).toBe('de');
    expect(translateJobs(seam())[0]!.translate!.targetLanguage).toBe('de');
    expect(seam().submittedOrgs).toEqual([s.caller.fixture.workspace.organizationId]);
    expect(await rows({ targetLanguage: 'de' })).toHaveLength(7);
  });
});
