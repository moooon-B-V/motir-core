import { describe, expect, it } from 'vitest';
import { anyNeedsTranslation, classifyFields } from '@/lib/translation/needsTranslation';

// The per-field needs-translation classifier (Story MOTIR-7735 · Subtask
// MOTIR-8115). Pure: no mocks of the database or network are needed because
// neither is reached.

const GERMAN = 'Das ist ein ganz normaler Satz über die Planung unserer Arbeit.';
const ENGLISH = 'This is a perfectly ordinary sentence about planning our work.';

describe('classifyFields', () => {
  it('a recorded language decides without the detector', () => {
    // German text recorded as zh: the detector would say de, the record wins.
    expect(classifyFields([{ id: 'title', text: GERMAN, language: 'zh' }], 'de')).toEqual([
      { id: 'title', needsTranslation: true, basis: 'recorded' },
    ]);
  });

  it('a recorded language equal to the reader’s needs nothing, however short or odd', () => {
    expect(classifyFields([{ id: 'title', text: 'x7', language: 'en' }], 'en')).toEqual([
      { id: 'title', needsTranslation: false, basis: 'recorded' },
    ]);
    expect(classifyFields([{ id: 'title', text: 'x7', language: 'EN-GB' }], 'en-US')[0]).toEqual({
      id: 'title',
      needsTranslation: false,
      basis: 'recorded',
    });
  });

  it('no record: detected as the reader’s language needs nothing', () => {
    expect(classifyFields([{ id: 'description', text: ENGLISH, language: null }], 'en')).toEqual([
      { id: 'description', needsTranslation: false, basis: 'detected' },
    ]);
    expect(classifyFields([{ id: 'description', text: GERMAN, language: null }], 'en')).toEqual([
      { id: 'description', needsTranslation: true, basis: 'detected' },
    ]);
  });

  it('no record and undecidable counts as not the reader’s', () => {
    expect(classifyFields([{ id: 'title', text: 'Fix login', language: null }], 'en')).toEqual([
      { id: 'title', needsTranslation: true, basis: 'undecidable' },
    ]);
  });

  it('empty or whitespace-only text never needs translating, whatever its record', () => {
    expect(
      classifyFields(
        [
          { id: 'description', text: '', language: 'zh' },
          { id: 'explanation', text: '  \n\t', language: null },
        ],
        'en',
      ),
    ).toEqual([
      { id: 'description', needsTranslation: false, basis: 'empty' },
      { id: 'explanation', needsTranslation: false, basis: 'empty' },
    ]);
  });

  it('classifies per field, and anyNeedsTranslation follows', () => {
    const mixed = classifyFields(
      [
        { id: 'title', text: '修复登录页面的错误', language: null },
        { id: 'description', text: ENGLISH, language: 'en' },
        { id: 'todo:t1:text', text: ENGLISH, language: null },
      ],
      'en',
    );
    expect(mixed.map((r) => [r.id, r.needsTranslation])).toEqual([
      ['title', true],
      ['description', false],
      ['todo:t1:text', false],
    ]);
    expect(anyNeedsTranslation(mixed)).toBe(true);

    const allMine = classifyFields(
      [
        { id: 'title', text: ENGLISH, language: 'en' },
        { id: 'description', text: '', language: null },
      ],
      'en',
    );
    expect(anyNeedsTranslation(allMine)).toBe(false);
  });
});
