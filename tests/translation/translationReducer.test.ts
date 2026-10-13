import { describe, expect, it } from 'vitest';
import type { TranslationOfferDTO } from '@/lib/dto/workItemTranslation';
import {
  barPhase,
  initialTranslationState,
  revisionsToSend,
  translationReducer,
  type TranslationState,
} from '@/app/(authed)/items/[key]/_components/translation/translationReducer';

// The item view's translation state machine (Story MOTIR-7735 · MOTIR-8122;
// design MOTIR-8112 § States). Pure: no renderer, no fetch.

const offer: TranslationOfferDTO = {
  targetLanguage: 'en',
  anyNeedsTranslation: true,
  fields: {
    title: { needsTranslation: true, kept: false, sourceLanguage: 'zh', revision: 'r0' },
    description: { needsTranslation: true, kept: true, sourceLanguage: 'zh', revision: 'r0' },
    explanation: { needsTranslation: false, kept: false, sourceLanguage: null, revision: 'r0' },
    'todo:t1:text': { needsTranslation: true, kept: false, sourceLanguage: 'zh', revision: 'r0' },
  },
};
const ALL = ['title', 'description', 'explanation', 'todo:t1:text'];

const press = (s: TranslationState, only?: string[]) =>
  translationReducer(s, { type: 'start', sent: revisionsToSend(s, only) });
/** The revisions of the fields a request in flight was sent for: the pending ones. */
const inFlight = (s: TranslationState) =>
  revisionsToSend(
    s,
    Object.keys(s.fields).filter((ref) => s.fields[ref]!.state === 'pending'),
  );
const answer = (s: TranslationState, results: unknown[]) =>
  translationReducer(s, { type: 'apply', results: results as never, sent: inFlight(s) });

describe('initialTranslationState', () => {
  it('holds an idle entry for each differing field only', () => {
    const s = initialTranslationState(offer);
    expect(Object.keys(s.fields)).toEqual(['title', 'description', 'todo:t1:text']);
    expect(Object.values(s.fields).every((f) => f.state === 'idle' && f.text === null)).toBe(true);
    expect(s.busy).toBe(false);
    expect(barPhase(s, ALL)).toEqual({ kind: 'offered' });
  });
});

describe('a press and its answer', () => {
  it('start marks every differing field pending and the bar busy', () => {
    const s = press(initialTranslationState(offer));
    expect(Object.values(s.fields).map((f) => f.state)).toEqual(['pending', 'pending', 'pending']);
    expect(barPhase(s, ALL)).toEqual({ kind: 'busy' });
  });

  it('ready swaps in text; failed / timeout keep the original; a success stays translated', () => {
    const s = answer(press(initialTranslationState(offer)), [
      { fieldRef: 'title', status: 'ready', text: 'Title EN' },
      { fieldRef: 'description', status: 'timeout' },
      { fieldRef: 'todo:t1:text', status: 'failed' },
    ]);
    expect(s.fields.title).toMatchObject({ state: 'ready', text: 'Title EN' });
    expect(s.fields.description).toMatchObject({ state: 'timeout', text: null });
    expect(s.fields['todo:t1:text']!.state).toBe('failed');
    expect(barPhase(s, ALL)).toEqual({ kind: 'translated', failedCount: 2 });
  });

  it('an unknown status — or ready with no text — is failed, never unmarked', () => {
    const s = answer(press(initialTranslationState(offer)), [
      { fieldRef: 'title', status: 'exploded' },
      { fieldRef: 'description', status: 'ready', text: '   ' },
      { fieldRef: 'todo:t1:text', status: 42 },
    ]);
    expect(Object.values(s.fields).map((f) => f.state)).toEqual(['failed', 'failed', 'failed']);
    expect(barPhase(s, ALL)).toEqual({ kind: 'failed' });
  });

  it('a field the server does not name, or does not offer, is ignored; a pending one unnamed returns to idle', () => {
    const s = answer(press(initialTranslationState(offer)), [
      { fieldRef: 'title', status: 'ready', text: 'T' },
      { fieldRef: 'explanation', status: 'ready', text: 'never shown' },
      { fieldRef: 'todo:zz:text', status: 'ready', text: 'unknown' },
      { status: 'ready', text: 'no ref' },
    ]);
    expect(Object.keys(s.fields)).toEqual(['title', 'description', 'todo:t1:text']);
    expect(s.fields.description!.state).toBe('idle');
  });

  it('no credit wins the bar and removes the button (D6)', () => {
    const s = answer(press(initialTranslationState(offer)), [
      { fieldRef: 'title', status: 'no_credit' },
      { fieldRef: 'description', status: 'ready', text: 'kept copy' },
    ]);
    expect(barPhase(s, ALL)).toEqual({ kind: 'no_credit' });
  });

  it('a failed request fails every pending field', () => {
    const s = translationReducer(press(initialTranslationState(offer)), {
      type: 'requestFailed',
      sent: inFlight(press(initialTranslationState(offer))),
    });
    expect(Object.values(s.fields).map((f) => f.state)).toEqual(['failed', 'failed', 'failed']);
    expect(s.busy).toBe(false);
    expect(barPhase(s, ALL)).toEqual({ kind: 'failed' });
  });
});

describe('retry and the toggle', () => {
  const partly = () =>
    answer(press(initialTranslationState(offer)), [
      { fieldRef: 'title', status: 'ready', text: 'Title EN' },
      { fieldRef: 'description', status: 'failed' },
      { fieldRef: 'todo:t1:text', status: 'ready', text: 'Step EN' },
    ]);

  it('a field retry re-marks only that field; the translated ones keep their text', () => {
    const s = press(partly(), ['description']);
    expect(s.fields.description!.state).toBe('pending');
    expect(s.fields.title).toMatchObject({ state: 'ready', text: 'Title EN' });
    const done = answer(s, [
      { fieldRef: 'title', status: 'failed' },
      { fieldRef: 'description', status: 'ready', text: 'Desc EN' },
      { fieldRef: 'todo:t1:text', status: 'ready', text: 'Step EN' },
    ]);
    // A later failure for a field that already succeeded does not take it away.
    expect(done.fields.title).toMatchObject({ state: 'ready', text: 'Title EN' });
    expect(done.fields.description).toMatchObject({ state: 'ready', text: 'Desc EN' });
    expect(barPhase(done, ALL)).toEqual({ kind: 'translated', failedCount: 0 });
  });

  it('the item Retry re-marks every field not yet translated', () => {
    const s = press(partly());
    expect(s.fields.description!.state).toBe('pending');
    expect(s.fields.title!.state).toBe('ready');
  });

  it('setView switches the view and touches no field', () => {
    const s = partly();
    const original = translationReducer(s, { type: 'setView', view: 'original' });
    expect(original.view).toBe('original');
    expect(original.fields).toBe(s.fields);
    expect(translationReducer(original, { type: 'setView', view: 'translated' }).view).toBe(
      'translated',
    );
  });

  it('the bar counts only the host’s scope (the quick view: title and description)', () => {
    const s = answer(press(initialTranslationState(offer)), [
      { fieldRef: 'title', status: 'ready', text: 'T' },
      { fieldRef: 'description', status: 'ready', text: 'D' },
      { fieldRef: 'todo:t1:text', status: 'failed' },
    ]);
    expect(barPhase(s, ['title', 'description'])).toEqual({ kind: 'translated', failedCount: 0 });
    expect(barPhase(s, ALL)).toEqual({ kind: 'translated', failedCount: 1 });
  });
});
