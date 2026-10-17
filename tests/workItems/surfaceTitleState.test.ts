import { describe, expect, it } from 'vitest';
import {
  failedCount,
  foldAnswer,
  foldFailure,
  hasTranslatedTitle,
  idsToRequest,
  initialSurfaceTitleState,
  markPending,
  setShowOriginal,
  surfacePhase,
  titleView,
} from '@/components/workItems/titleTranslation/surfaceTitleState';

// The per-surface state of auto-translated titles (Story MOTIR-7738 · MOTIR-8833;
// design MOTIR-8824). Pure functions: no request, no React.

const A = { id: 'a', title: 'Build the export' };
const B = { id: 'b', title: 'Fix login' };
const C = { id: 'c', title: 'Ship it' };

const ready = (id: string, text: string) =>
  ({
    workItemId: id,
    fieldRef: `${id}:title`,
    status: 'ready',
    text,
    sourceLanguage: 'en',
  }) as const;
const status = (id: string, s: 'failed' | 'no_credit' | 'timeout') =>
  ({ workItemId: id, fieldRef: `${id}:title`, status: s }) as const;

describe('idsToRequest', () => {
  it('asks for ids with no entry, once each, in arrival order', () => {
    const s = initialSurfaceTitleState(true);
    expect(idsToRequest(s, [B, A, B])).toEqual(['b', 'a']);
  });

  it('asks nothing while the switch is off or the organisation cannot pay', () => {
    expect(idsToRequest(initialSurfaceTitleState(false), [A])).toEqual([]);
    expect(idsToRequest(initialSurfaceTitleState(true, true), [A])).toEqual([]);
  });

  it('does not re-ask an id that has an answer, and re-asks one whose title was edited', () => {
    let s = initialSurfaceTitleState(true);
    s = markPending(s, [A, B], ['a', 'b']);
    expect(idsToRequest(s, [A, B])).toEqual([]);
    expect(idsToRequest(s, [{ id: 'a', title: 'Build the export, again' }, B])).toEqual(['a']);
  });
});

describe('foldAnswer', () => {
  it('keeps a ready title as translated, an omitted id as already in the reader language', () => {
    let s = markPending(initialSurfaceTitleState(true), [A, B], ['a', 'b']);
    s = foldAnswer(s, [A, B], {
      enabled: true,
      titles: [ready('a', '내보내기 만들기')],
    });
    expect(titleView(s, 'a', A.title)).toMatchObject({
      value: 'translated',
      text: '내보내기 만들기',
    });
    expect(titleView(s, 'b', B.title)).toMatchObject({ value: 'already', text: B.title });
  });

  it('shows a failed or timed-out title as its stored text, with no mark', () => {
    let s = markPending(initialSurfaceTitleState(true), [A, B], ['a', 'b']);
    s = foldAnswer(s, [A, B], {
      enabled: true,
      titles: [status('a', 'failed'), status('b', 'timeout')],
    });
    expect(titleView(s, 'a', A.title)).toEqual({
      value: 'failed',
      text: A.title,
      sourceLanguage: null,
    });
    expect(titleView(s, 'b', B.title).value).toBe('failed');
    expect(failedCount(s, [A, B])).toBe(2);
  });

  it('moves the surface to no-credit and back to stored text on a no_credit entry', () => {
    let s = markPending(initialSurfaceTitleState(true), [A], ['a']);
    s = foldAnswer(s, [A], { enabled: true, titles: [status('a', 'no_credit')] });
    expect(s.noCredit).toBe(true);
    expect(titleView(s, 'a', A.title).value).toBe('stored');
    expect(surfacePhase(s, [A])).toBe('no-credit');
    expect(idsToRequest(s, [B])).toEqual([]);
  });

  it('turns the surface off, clearing every entry, when the switch was turned off', () => {
    let s = markPending(initialSurfaceTitleState(true), [A], ['a']);
    s = foldAnswer(s, [A], { enabled: false, titles: [] });
    expect(s).toMatchObject({ enabled: false, entries: {} });
    expect(surfacePhase(s, [A])).toBe('off');
  });

  it('drops an answer for a title edited since it was asked', () => {
    let s = markPending(initialSurfaceTitleState(true), [A], ['a']);
    const edited = { id: 'a', title: 'Build the export v2' };
    s = markPending(s, [edited], ['a']);
    s = foldAnswer(s, [A], { enabled: true, titles: [ready('a', 'old translation')] });
    expect(titleView(s, 'a', edited.title)).toMatchObject({ value: 'pending', text: edited.title });
  });
});

describe('foldFailure', () => {
  it('reads every asked title as failed', () => {
    let s = markPending(initialSurfaceTitleState(true), [A, B], ['a', 'b']);
    s = foldFailure(s, [A, B]);
    expect(failedCount(s, [A, B])).toBe(2);
  });
});

describe('Show original', () => {
  it('swaps the text, leaves the entries, and offers the switch only once something translated', () => {
    let s = markPending(initialSurfaceTitleState(true), [A, B], ['a', 'b']);
    expect(hasTranslatedTitle(s, [A, B])).toBe(false);
    s = foldAnswer(s, [A, B], { enabled: true, titles: [ready('a', 'X')] });
    expect(hasTranslatedTitle(s, [A, B])).toBe(true);
    expect(surfacePhase(s, [A, B])).toBe('translated');
    const shown = setShowOriginal(s, true);
    expect(titleView(shown, 'a', A.title)).toMatchObject({ value: 'original', text: A.title });
    expect(surfacePhase(shown, [A, B])).toBe('showing-original');
    expect(shown.entries).toBe(s.entries);
  });
});

describe('surfacePhase', () => {
  it('is pending until every title has an answer, then nothing-differs when none differs', () => {
    let s = initialSurfaceTitleState(true);
    expect(surfacePhase(s, [A, C])).toBe('pending');
    s = markPending(s, [A, C], ['a', 'c']);
    expect(surfacePhase(s, [A, C])).toBe('pending');
    s = foldAnswer(s, [A, C], { enabled: true, titles: [] });
    expect(surfacePhase(s, [A, C])).toBe('nothing-differs');
  });

  it('is failed when only failures remain', () => {
    let s = markPending(initialSurfaceTitleState(true), [A], ['a']);
    s = foldAnswer(s, [A], { enabled: true, titles: [status('a', 'failed')] });
    expect(surfacePhase(s, [A])).toBe('failed');
  });
});
