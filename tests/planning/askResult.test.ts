import { describe, expect, it } from 'vitest';
import { ASK_ANSWER_MAX_CHARS, ASK_MAX_CITATIONS, readAskOutcome } from '@/lib/planning/askResult';

// The consuming half of MOTIR-1817's boundary contract (MOTIR-1819) — reading an
// `ask_project` result. A boundary parser, so what it is worth testing is every
// way the far side can be wrong: an older engine that carries no `ask` unit, a
// malformed one, an unbounded body, a fabricated citation shape.

describe('readAskOutcome — what it refuses to read', () => {
  it('yields null when there is no `ask` unit at all', () => {
    // An older engine, a different job kind, or a job that failed before it
    // produced one. Distinct from a job that RAN and had nothing to say.
    for (const raw of [null, undefined, 42, 'text', [], {}, { ask: null }, { ask: 'nope' }]) {
      expect(readAskOutcome(raw)).toBeNull();
    }
  });

  it('reads an ANSWER with its citations', () => {
    expect(
      readAskOutcome({
        ask: { intent: 'ask', answer: '  ABC-1 is blocked.  ', citations: ['ABC-1'] },
      }),
    ).toEqual({ intent: 'ask', answer: 'ABC-1 is blocked.', citations: ['ABC-1'] });
  });

  it('reads the REDIRECT as carrying nothing, whatever else the field held', () => {
    // A producer that sent an answer beside a plan_change verdict is confused;
    // the safe read is the one that does not put stray prose on the thread.
    expect(
      readAskOutcome({ ask: { intent: 'plan_change', answer: 'ignore me', citations: ['ABC-1'] } }),
    ).toEqual({ intent: 'plan_change', answer: null, citations: [] });
  });

  it('DEFAULTS an unrecognised intent to `ask` — never to a plan change', () => {
    // The expensive half of the asymmetry: an unparseable envelope must not turn
    // into a plan-edit job the person never asked for.
    expect(readAskOutcome({ ask: { intent: 'wat', answer: 'hi' } })).toEqual({
      intent: 'ask',
      answer: 'hi',
      citations: [],
    });
    expect(readAskOutcome({ ask: {} })).toEqual({ intent: 'ask', answer: null, citations: [] });
  });

  it('treats an empty or non-string answer as nothing said', () => {
    expect(readAskOutcome({ ask: { intent: 'ask', answer: '   ' } })?.answer).toBeNull();
    expect(readAskOutcome({ ask: { intent: 'ask', answer: 7 } })?.answer).toBeNull();
  });

  it('BOUNDS the answer — a runaway generation cannot write an unbounded row', () => {
    const long = 'x'.repeat(ASK_ANSWER_MAX_CHARS + 500);
    const answer = readAskOutcome({ ask: { intent: 'ask', answer: long } })!.answer!;
    expect(answer.length).toBe(ASK_ANSWER_MAX_CHARS);
    expect(answer.endsWith('…')).toBe(true);
  });
});

describe('readAskOutcome — the citations', () => {
  it('drops anything that is not key-shaped, and de-duplicates', () => {
    const out = readAskOutcome({
      ask: {
        intent: 'ask',
        citations: ['ABC-1', 'ABC-1', 'not a key', '', 42, null, 'see ABC-2 here', 'ABC-2'],
      },
    });
    // `see ABC-2 here` CONTAINS a key and is not one — the pattern is anchored.
    expect(out!.citations).toEqual(['ABC-1', 'ABC-2']);
  });

  it('is empty when the field is missing or not an array', () => {
    expect(readAskOutcome({ ask: { intent: 'ask', citations: 'ABC-1' } })!.citations).toEqual([]);
    expect(readAskOutcome({ ask: { intent: 'ask' } })!.citations).toEqual([]);
  });

  it('BOUNDS the count — an answer resting on forty items is not one a person can check', () => {
    const many = Array.from({ length: ASK_MAX_CITATIONS + 10 }, (_, i) => `ABC-${i + 1}`);
    expect(readAskOutcome({ ask: { intent: 'ask', citations: many } })!.citations).toHaveLength(
      ASK_MAX_CITATIONS,
    );
  });
});
