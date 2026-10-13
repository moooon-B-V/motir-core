import { describe, expect, it } from 'vitest';
import { InvalidTranslationsError, parseTranslations } from '@/lib/ai/translate';

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
