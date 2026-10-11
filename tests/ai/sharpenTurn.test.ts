import { describe, expect, it } from 'vitest';
import { parseSharpenTurn, SHARPEN_CAPS } from '@/lib/ai/sharpenTurn';

// Task MOTIR-1101 · Subtask MOTIR-8181 — the core-side read of a `sharpen_turn`
// result. Untrusted model output: anything that is not a well-formed turn is
// `null`, never a guessed kind.

const reading = (id: string, recommended: boolean) => ({
  id,
  label: `Reading ${id}`,
  detail: '',
  recommended,
});
const question = {
  id: 'q1',
  text: 'Who exports invoices?',
  topic: 'workflow',
  because: null,
  quote: null,
  readings: [reading('a', true), reading('b', false)],
};
const base = { settled: [], assumptions: [], writeBack: null };

describe('parseSharpenTurn', () => {
  it('reads a question turn', () => {
    expect(parseSharpenTurn({ kind: 'question', question, ...base })).toEqual({
      kind: 'question',
      question,
      ...base,
    });
  });

  it.each(['nothing_to_ask', 'finished', 'stopped', 'unavailable'])('reads a %s turn', (kind) => {
    const parsed = parseSharpenTurn({
      kind,
      question: null,
      settled: [
        {
          questionId: 'q1',
          question: 'Q',
          answer: 'A',
          topic: 'non_happy',
          readingId: null,
          source: 'person',
        },
      ],
      assumptions: [
        { questionId: 'q2', question: 'Q2', recommendation: 'R', why: 'W', source: 'planner' },
      ],
      writeBack: { ok: false, error: 'refused' },
    });
    expect(parsed?.kind).toBe(kind);
    expect(parsed?.question).toBeNull();
    expect(parsed?.settled).toHaveLength(1);
    expect(parsed?.writeBack).toEqual({ ok: false, error: 'refused' });
  });

  it.each([
    ['not an object', 'nope'],
    ['an unknown kind', { kind: 'guess', ...base }],
    ['a question turn with no question', { kind: 'question', question: null, ...base }],
    [
      'one reading',
      { kind: 'question', question: { ...question, readings: [reading('a', true)] }, ...base },
    ],
    [
      'five readings',
      {
        kind: 'question',
        question: {
          ...question,
          readings: ['a', 'b', 'c', 'd', 'e'].map((id, i) => reading(id, i === 0)),
        },
        ...base,
      },
    ],
    [
      'no recommended reading',
      {
        kind: 'question',
        question: { ...question, readings: [reading('a', false), reading('b', false)] },
        ...base,
      },
    ],
    [
      'duplicate reading ids',
      {
        kind: 'question',
        question: { ...question, readings: [reading('a', true), reading('a', false)] },
        ...base,
      },
    ],
    ['an unknown topic', { kind: 'question', question: { ...question, topic: 'stack' }, ...base }],
    ['a malformed settled entry', { kind: 'finished', ...base, settled: [{ answer: 1 }] }],
    ['a malformed writeBack', { kind: 'finished', ...base, writeBack: { ok: 'yes' } }],
  ])('refuses %s', (_label, raw) => {
    expect(parseSharpenTurn(raw)).toBeNull();
  });

  it('caps long strings', () => {
    const long = 'x'.repeat(SHARPEN_CAPS.text + 50);
    const parsed = parseSharpenTurn({
      kind: 'question',
      question: { ...question, text: long },
      ...base,
    });
    expect(parsed?.question?.text).toHaveLength(SHARPEN_CAPS.text);
  });
});
