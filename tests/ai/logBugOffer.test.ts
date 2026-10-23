import { describe, expect, it } from 'vitest';
import { InvalidAuthoredBugError } from '@/lib/ai/authoredBug';
import { parseLogBugOffer, readLogBugOffer } from '@/lib/ai/logBugOffer';
import { readAskOutcome } from '@/lib/planning/askResult';
import { BUG_REF, bugDraft, logBugOffer } from '../fixtures/logBugOfferFixtures';

// THE LOG-A-BUG OFFER, AS CORE READS IT (Story MOTIR-9220 · MOTIR-9322). Model output
// from across the boundary becomes a write on somebody's card once a person agrees,
// so every field is checked here; one failed field refuses the whole offer.

describe('parseLogBugOffer', () => {
  it('reads a well-formed offer, trimming and de-duplicating', () => {
    const parsed = parseLogBugOffer(
      logBugOffer({
        title: '  Saving a comment drops the @mention ',
        target: { kind: 'existing', key: 'ABC-30' },
        contextRefs: [BUG_REF, ` ${BUG_REF} `],
      }),
    );
    expect(parsed).toMatchObject({
      kind: 'log_bug',
      title: 'Saving a comment drops the @mention',
      acceptanceCriteria: ['A saved comment keeps its @mention'],
      target: { kind: 'existing', key: 'ABC-30' },
      contextRefs: [BUG_REF],
    });
    expect(parsed.draft.grounded).toBe(true);
  });

  it('reads a new target as having no key', () => {
    expect(parseLogBugOffer(logBugOffer({ target: { kind: 'new', key: 'ABC-1' } })).target).toEqual(
      { kind: 'new', key: null },
    );
  });

  it.each([
    ['not an object', null, 'offer'],
    ['another kind', { kind: 'plan' }, 'offer'],
    ['an empty title', logBugOffer({ title: '  ' }), 'title'],
    ['a non-string title', logBugOffer({ title: 7 }), 'title'],
    ['an over-long title', logBugOffer({ title: 'x'.repeat(201) }), 'title'],
    ['a two-line title', logBugOffer({ title: 'one\ntwo' }), 'title'],
    ['no criteria', logBugOffer({ acceptanceCriteria: [] }), 'acceptanceCriteria'],
    [
      'nine criteria',
      logBugOffer({ acceptanceCriteria: Array(9).fill('x') }),
      'acceptanceCriteria',
    ],
    ['a blank criterion', logBugOffer({ acceptanceCriteria: [' '] }), 'acceptanceCriteria'],
    [
      'a draft failing the authored-bug check',
      logBugOffer({ draft: bugDraft({ type: 'nope' }) }),
      'type',
    ],
    [
      'one candidate mechanism',
      logBugOffer({ draft: bugDraft({ candidateMechanisms: ['a'] }) }),
      'candidateMechanisms',
    ],
    ['an ungrounded draft', logBugOffer({ draft: bugDraft({ grounded: false }) }), 'draft'],
    ['no target', logBugOffer({ target: 'new' }), 'target'],
    ['an unknown target kind', logBugOffer({ target: { kind: 'move', key: 'ABC-1' } }), 'target'],
    ['an existing target with no key', logBugOffer({ target: { kind: 'existing' } }), 'target'],
    [
      'an anchored target with a bad key',
      logBugOffer({ target: { kind: 'anchored', key: 'abc' } }),
      'target',
    ],
    ['no code context ref', logBugOffer({ contextRefs: [] }), 'contextRefs'],
    ['a non-list context refs', logBugOffer({ contextRefs: BUG_REF }), 'contextRefs'],
    ['a blank context ref', logBugOffer({ contextRefs: [''] }), 'contextRefs'],
    [
      'too many context refs',
      logBugOffer({ contextRefs: Array.from({ length: 21 }, (_, i) => `a/${i}.ts`) }),
      'contextRefs',
    ],
  ])('refuses %s, naming the field', (_label, raw, field) => {
    let caught: unknown;
    try {
      parseLogBugOffer(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidAuthoredBugError);
    expect((caught as InvalidAuthoredBugError).field).toBe(field);
    expect(readLogBugOffer(raw)).toBeNull();
  });
});

describe('the ask result reads a log_bug offer whole, or not at all', () => {
  const ask = (offer: unknown) =>
    readAskOutcome({ ask: { intent: 'ask', answer: 'It drops it.', citations: [], offer } });

  it('carries a well-formed offer', () => {
    expect(ask(logBugOffer())?.offer).toMatchObject({ kind: 'log_bug', contextRefs: [BUG_REF] });
  });

  it('drops a malformed one and keeps the answer', () => {
    const outcome = ask(logBugOffer({ contextRefs: [] }));
    expect(outcome?.answer).toBe('It drops it.');
    expect(outcome).not.toHaveProperty('offer');
  });
});
