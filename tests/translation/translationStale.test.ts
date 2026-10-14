import { describe, expect, it } from 'vitest';
import type { TranslationOfferDTO } from '@/lib/dto/workItemTranslation';
import {
  applyOffer,
  barPhase,
  initialTranslationState,
  revisionsToSend,
  translationReducer,
  type TranslationState,
} from '@/app/(authed)/items/[key]/_components/translation/translationReducer';

// THE STALE STATE, pure (Story MOTIR-7735 · MOTIR-8123; design MOTIR-8112
// panels 10–11). A new offer whose revision for a field differs drops that
// field's held translation at once and, in the translated view, queues it for
// one re-request; an answer for an older revision is discarded.

type Fields = TranslationOfferDTO['fields'];
const field = (revision: string, needsTranslation = true) => ({
  needsTranslation,
  kept: false,
  sourceLanguage: needsTranslation ? ('zh' as const) : null,
  revision,
});
const offerOf = (fields: Fields): TranslationOfferDTO => ({
  targetLanguage: 'en',
  anyNeedsTranslation: Object.values(fields).some((f) => f.needsTranslation),
  fields,
});

const V1 = offerOf({
  title: field('t1'),
  description: field('d1'),
  'todo:a:text': field('a1'),
});

/** Pressed and answered: every field translated, the translated view open. */
function translated(): TranslationState {
  const start = initialTranslationState(V1);
  const sent = revisionsToSend(start);
  const pending = translationReducer(start, { type: 'start', sent });
  return translationReducer(pending, {
    type: 'apply',
    sent,
    results: [
      { fieldRef: 'title', status: 'ready', text: 'Title' },
      { fieldRef: 'description', status: 'ready', text: 'Description' },
      { fieldRef: 'todo:a:text', status: 'ready', text: 'Step' },
    ],
  });
}

describe('applyOffer — an edit reaches the translated view', () => {
  it('drops ONLY the changed field’s translation, marks it edited-pending and queues it once', () => {
    const before = translated();
    const after = applyOffer(before, offerOf({ ...V1.fields, description: field('d2') }));
    expect(after.fields.description).toEqual({
      state: 'pending',
      text: null,
      revision: 'd2',
      edited: true,
    });
    expect(after.queue).toEqual(['description']);
    // Untouched fields keep the SAME entry object — nothing re-renders them.
    expect(after.fields.title).toBe(before.fields.title);
    expect(after.fields['todo:a:text']).toBe(before.fields['todo:a:text']);
    // The bar is not busy: a re-request is not a press.
    expect(barPhase(after, Object.keys(after.fields))).toEqual({
      kind: 'translated',
      failedCount: 0,
    });
  });

  it('the same offer twice changes nothing and queues nothing again', () => {
    const edited = offerOf({ ...V1.fields, description: field('d2') });
    const once = applyOffer(translated(), edited);
    const dequeued = translationReducer(once, { type: 'dequeue', refs: once.queue });
    expect(applyOffer(dequeued, edited)).toBe(dequeued);
    expect(applyOffer(translated(), V1)).toEqual(translated());
  });

  it('an answer for an OLDER revision is discarded; the current one lands', () => {
    const s = applyOffer(translated(), offerOf({ ...V1.fields, description: field('d2') }));
    const stale = translationReducer(s, {
      type: 'apply',
      quiet: true,
      sent: { description: 'd1' },
      results: [{ fieldRef: 'description', status: 'ready', text: 'Old description' }],
    });
    expect(stale.fields.description).toMatchObject({ state: 'pending', text: null });
    const fresh = translationReducer(stale, {
      type: 'apply',
      quiet: true,
      sent: { description: 'd2' },
      results: [{ fieldRef: 'description', status: 'ready', text: 'New description' }],
    });
    expect(fresh.fields.description).toEqual({
      state: 'ready',
      text: 'New description',
      revision: 'd2',
      edited: false,
    });
  });

  it('a failed re-translation shows failed and never the old translation', () => {
    const s = applyOffer(translated(), offerOf({ ...V1.fields, description: field('d2') }));
    const failed = translationReducer(s, {
      type: 'apply',
      quiet: true,
      sent: { description: 'd2' },
      results: [{ fieldRef: 'description', status: 'failed' }],
    });
    expect(failed.fields.description).toMatchObject({ state: 'failed', text: null });
    const down = translationReducer(s, {
      type: 'requestFailed',
      quiet: true,
      sent: { description: 'd2' },
    });
    expect(down.fields.description).toMatchObject({ state: 'failed', text: null });
  });

  it('a field now in the reader’s language leaves the state; a deleted to-do is removed', () => {
    const s = applyOffer(
      translated(),
      offerOf({ title: field('t2', false), description: V1.fields.description! }),
    );
    expect(Object.keys(s.fields)).toEqual(['description']);
    expect(s.queue).toEqual([]);
  });

  it('a NEW to-do that needs translating is requested in the translated view, unmarked as edited', () => {
    const s = applyOffer(translated(), offerOf({ ...V1.fields, 'todo:b:text': field('b1') }));
    expect(s.fields['todo:b:text']).toEqual({
      state: 'pending',
      text: null,
      revision: 'b1',
      edited: false,
    });
    expect(s.queue).toEqual(['todo:b:text']);
  });
});

describe('applyOffer — outside the translated view', () => {
  it('in the ORIGINAL view an edit marks nothing pending and queues nothing', () => {
    const original = translationReducer(translated(), { type: 'setView', view: 'original' });
    const s = applyOffer(original, offerOf({ ...V1.fields, description: field('d2') }));
    expect(s.fields.description).toEqual({
      state: 'idle',
      text: null,
      revision: 'd2',
      edited: false,
    });
    expect(s.queue).toEqual([]);
    // The next press sends the edited field at its new revision.
    expect(revisionsToSend(s)).toEqual({ description: 'd2' });
  });

  it('before any press an edit only updates the revision', () => {
    const s = applyOffer(
      initialTranslationState(V1),
      offerOf({ ...V1.fields, title: field('t2') }),
    );
    expect(s.fields.title).toEqual({ state: 'idle', text: null, revision: 't2', edited: false });
    expect(s.queue).toEqual([]);
  });
});
