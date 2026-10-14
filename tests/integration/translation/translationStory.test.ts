import { describe, expect, it, vi } from 'vitest';
import { fieldRef } from '@/lib/translation/fieldRefs';
import {
  billedUnits,
  readerScope,
  script,
  sessionUser,
  translateJobs,
  ZH,
} from './helpers/translationStoryFixture';
import {
  EDITED,
  SOURCE_TEXTS,
  echoed,
  editDescription,
  keepGerman,
  lockWaiters,
  nextSubmit,
  offerFor,
  press,
  reader,
  ready,
  release,
  rows,
  story,
  registerStorySeam,
} from './helpers/translationStoryHarness';

// THE STORY, ASSEMBLED — kept and shared, staleness, single flight (Story
// MOTIR-7735 · Subtask MOTIR-8124). A reader's press crosses the real route, the
// real door, the real advisory locks and the real kept-translation store in a
// real database, under the tenant context; only motir-ai is replaced, on the
// WIRE, by the in-repo jobs mock (`lib/test-ai-jobs-mock.ts`). A charge is read
// from the mock's own job record: one billed unit per accepted `translate` job
// that succeeded (the ledger's arithmetic is the motir-ai story gate's). The
// failure, usage and agent cases are `translationStoryCharges.test.ts`.

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

describe('kept and shared', () => {
  it('the first press is ONE job carrying all five field kinds and keeps a row per field', async () => {
    const s = await story();
    const res = await press(s.owner, s.itemId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ targetLanguage: 'de', fields: ready(s.refs, 'de') });
    expect(translateJobs(seam())).toHaveLength(1);
    const sent = translateJobs(seam())[0]!.translate!;
    expect(sent.targetLanguage).toBe('de');
    expect(sent.fields.map((f) => f.fieldRef)).toEqual(s.refs);
    expect(sent.fields.map((f) => f.text)).toEqual(SOURCE_TEXTS);
    expect(await rows()).toHaveLength(7);
    expect(billedUnits(seam())).toBe(1);
  });

  it('a second German reader, and a repeat press, cost zero jobs and get identical text', async () => {
    const s = await story();
    const first = await press(s.owner, s.itemId);
    const second = await press(await reader(s, 'second@example.com', 'de'), s.itemId);
    const repeat = await press(s.owner, s.itemId);

    expect(second.body).toEqual(first.body);
    expect(repeat.body).toEqual(first.body);
    expect(translateJobs(seam())).toHaveLength(1);
    expect(billedUnits(seam())).toBe(1);
    expect(await rows()).toHaveLength(7);
  });

  it('a French reader makes a job and rows of its own, beside the German ones', async () => {
    const s = await story();
    await press(s.owner, s.itemId);
    const germanRows = await rows({ targetLanguage: 'de' });
    const fr = await press(await reader(s, 'fr@example.com', 'fr'), s.itemId);

    expect(fr.body).toEqual({ targetLanguage: 'fr', fields: ready(s.refs, 'fr') });
    expect(translateJobs(seam())).toHaveLength(2);
    expect(translateJobs(seam())[1]!.translate!.targetLanguage).toBe('fr');
    expect(await rows({ targetLanguage: 'fr' })).toHaveLength(7);
    expect(await rows({ targetLanguage: 'de' })).toEqual(germanRows);
  });
});

describe('the offer after translating', () => {
  it('kept for German, offered to English, nothing to offer a Chinese reader', async () => {
    const s = await story();
    await press(s.owner, s.itemId);

    const de = await offerFor(s.owner, s.itemId);
    expect(Object.keys(de.fields)).toEqual(s.refs);
    for (const ref of s.refs) expect(de.fields[ref]!.kept, ref).toBe(true);
    const en = await offerFor(await reader(s, 'en@example.com', 'en'), s.itemId);
    expect(en.anyNeedsTranslation).toBe(true);
    for (const ref of s.refs) {
      expect(en.fields[ref], ref).toMatchObject({
        needsTranslation: true,
        kept: false,
        sourceLanguage: 'zh',
      });
    }
    const zh = await offerFor(await reader(s, 'zh@example.com', 'zh'), s.itemId);
    expect(zh.anyNeedsTranslation).toBe(false);
  });
});

describe('staleness — an edit', () => {
  it('an edit moves ONE field’s revision; the next press sends that field alone', async () => {
    const s = await story();
    await press(s.owner, s.itemId);
    const before = await offerFor(s.owner, s.itemId);
    await editDescription(s);

    const after = await offerFor(s.owner, s.itemId);
    for (const ref of s.refs) {
      const changed = ref === fieldRef.description();
      expect(after.fields[ref]!.revision === before.fields[ref]!.revision, ref).toBe(!changed);
      expect(after.fields[ref]!.kept, ref).toBe(!changed);
    }
    const res = await press(s.owner, s.itemId);
    expect(translateJobs(seam())).toHaveLength(2);
    expect(translateJobs(seam())[1]!.translate!.fields).toEqual([
      { fieldRef: fieldRef.description(), text: EDITED },
    ]);
    expect(billedUnits(seam())).toBe(2);
    const texts = [ZH.title, EDITED, ...SOURCE_TEXTS.slice(2)];
    expect(res.body.fields).toEqual(ready(s.refs, 'de', texts));
  });

  it('the old translation is never served, and its row is gone once the new one is kept', async () => {
    const s = await story();
    await press(s.owner, s.itemId);
    await editDescription(s);
    const old = echoed('de', ZH.description);

    expect(JSON.stringify(await offerFor(s.owner, s.itemId))).not.toContain(old);
    const res = await press(s.owner, s.itemId);
    expect(JSON.stringify(res.body)).not.toContain(old);
    const kept = await rows({ fieldRef: fieldRef.description(), targetLanguage: 'de' });
    expect(kept.map((r) => r.translatedText)).toEqual([echoed('de', EDITED)]);
  });
});

describe('staleness — a later reader', () => {
  it('is offered Translate; their press costs nothing once it was re-kept', async () => {
    const s = await story();
    await press(s.owner, s.itemId);
    await editDescription(s);
    const third = await reader(s, 'third@example.com', 'de');

    const offer = await offerFor(third, s.itemId);
    expect(offer.anyNeedsTranslation).toBe(true);
    expect(offer.fields[fieldRef.description()]!.kept).toBe(false);
    // Nobody re-translated yet: the third reader's press sends the description alone.
    await press(third, s.itemId);
    expect(translateJobs(seam()).map((j) => j.translate!.fields.length)).toEqual([7, 1]);
    // Now it is kept: a fourth reader's press sends nothing.
    await press(await reader(s, 'fourth@example.com', 'de'), s.itemId);
    expect(translateJobs(seam())).toHaveLength(2);
    expect(billedUnits(seam())).toBe(2);
  });
});

// The job is held open by the mock (`status: 'running'`) until the test rewrites
// its outcome; the second press is released only once Postgres shows it WAITING
// on the first press's advisory lock. No sleep decides an ordering.
describe('single flight', () => {
  it('two simultaneous presses submit ONE job and both read the same texts', async () => {
    const s = await story();
    const second = await reader(s, 'second@example.com', 'de');
    script(seam(), [{ status: 'running' }]);
    const submitted = nextSubmit(seam());

    const a = press(s.owner, s.itemId);
    await submitted;
    const b = press(second, s.itemId);
    await expect.poll(lockWaiters, { timeout: 20_000 }).toBeGreaterThan(0);
    release(seam());
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.body).toEqual({ targetLanguage: 'de', fields: ready(s.refs, 'de') });
    expect(rb.body).toEqual(ra.body);
    expect(translateJobs(seam())).toHaveLength(1);
    expect(billedUnits(seam())).toBe(1);
  }, 60_000);

  it('overlapping field sets: each field is sent once across both presses, no deadlock', async () => {
    const s = await story();
    script(seam(), [{ status: 'running' }]);
    const submitted = nextSubmit(seam());
    const a = press(s.owner, s.itemId);
    await submitted;
    // While A holds all seven locks, the title is kept elsewhere: B needs six of them.
    await keepGerman(s, [fieldRef.title()]);
    const b = press(await reader(s, 'second@example.com', 'de'), s.itemId);
    await expect.poll(lockWaiters, { timeout: 20_000 }).toBeGreaterThan(0);
    release(seam());
    const [ra, rb] = await Promise.all([a, b]);

    const sent = translateJobs(seam()).flatMap((j) => j.translate!.fields.map((f) => f.fieldRef));
    expect(sent.sort()).toEqual([...s.refs].sort());
    expect(rb.body).toEqual(ra.body);
    expect(await rows()).toHaveLength(7);
  }, 60_000);
});
