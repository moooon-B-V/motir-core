import { describe, expect, it } from 'vitest';
import {
  InvalidTranslationsError,
  TRANSLATE_MAX_CHARS_PER_JOB,
  TRANSLATE_MAX_FIELDS_PER_JOB,
  batchTranslateFields,
  parseTranslations,
} from '@/lib/ai/translate';

// `parseTranslations` (Story MOTIR-7735 · MOTIR-8119): the reply is VALIDATED
// against the fields sent, never cast — one non-empty text per fieldRef, none
// extra, none missing, none duplicated, returned in the order sent.

const sent = [{ fieldRef: 'title' }, { fieldRef: 'description' }];

describe('parseTranslations', () => {
  it('returns one text per fieldRef, in the order SENT rather than the order received', () => {
    const raw = [
      { fieldRef: 'description', text: 'La description' },
      { fieldRef: 'title', text: 'Le titre' },
    ];
    expect(parseTranslations(raw, sent)).toEqual([
      { fieldRef: 'title', text: 'Le titre' },
      { fieldRef: 'description', text: 'La description' },
    ]);
  });

  it('drops any extra key an entry carries', () => {
    const raw = [
      { fieldRef: 'title', text: 'T', model: 'x' },
      { fieldRef: 'description', text: 'D' },
    ];
    expect(parseTranslations(raw, sent)[0]).toEqual({ fieldRef: 'title', text: 'T' });
  });

  it.each([
    ['not an array', { title: 'T' }],
    ['null', null],
    ['a missing fieldRef', [{ fieldRef: 'title', text: 'T' }]],
    [
      'an extra fieldRef',
      [
        { fieldRef: 'title', text: 'T' },
        { fieldRef: 'description', text: 'D' },
        { fieldRef: 'acceptance', text: 'A' },
      ],
    ],
    [
      'a duplicated fieldRef',
      [
        { fieldRef: 'title', text: 'T' },
        { fieldRef: 'title', text: 'T2' },
        { fieldRef: 'description', text: 'D' },
      ],
    ],
    [
      'an empty text',
      [
        { fieldRef: 'title', text: '' },
        { fieldRef: 'description', text: 'D' },
      ],
    ],
    [
      'a whitespace-only text',
      [
        { fieldRef: 'title', text: '  \n' },
        { fieldRef: 'description', text: 'D' },
      ],
    ],
    [
      'a non-string text',
      [
        { fieldRef: 'title', text: 3 },
        { fieldRef: 'description', text: 'D' },
      ],
    ],
    ['a non-object entry', ['T', { fieldRef: 'description', text: 'D' }]],
    ['an entry with no fieldRef', [{ text: 'T' }, { fieldRef: 'description', text: 'D' }]],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseTranslations(raw, sent)).toThrow(InvalidTranslationsError);
  });

  it('accepts an empty reply for an empty batch', () => {
    expect(parseTranslations([], [])).toEqual([]);
  });
});

describe('batchTranslateFields — motir-ai input limits', () => {
  const f = (i: number, len = 5) => ({ fieldRef: `f${i}`, text: 'x'.repeat(len) });

  it('keeps a small set in one batch', () => {
    expect(batchTranslateFields([f(1), f(2)])).toEqual({ batches: [[f(1), f(2)]], oversized: [] });
  });

  it('splits at 32 fields, in order', () => {
    const fields = Array.from({ length: 70 }, (_, i) => f(i));
    const { batches } = batchTranslateFields(fields);
    expect(batches.map((b) => b.length)).toEqual([32, 32, 6]);
    expect(batches.flat()).toEqual(fields);
  });

  it('splits before the texts together pass 40,000 characters', () => {
    const { batches } = batchTranslateFields([f(1, 25_000), f(2, 15_000), f(3, 1)]);
    expect(batches.map((b) => b.map((x) => x.fieldRef))).toEqual([['f1', 'f2'], ['f3']]);
    for (const b of batches) {
      expect(b.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(
        TRANSLATE_MAX_CHARS_PER_JOB,
      );
      expect(b.length).toBeLessThanOrEqual(TRANSLATE_MAX_FIELDS_PER_JOB);
    }
  });

  it('a single field too long for any job is set aside, never sent', () => {
    expect(batchTranslateFields([f(1), f(2, 40_001), f(3)])).toEqual({
      batches: [[f(1), f(3)]],
      oversized: ['f2'],
    });
  });
});
