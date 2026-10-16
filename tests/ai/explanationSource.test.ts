import { describe, it, expect } from 'vitest';
import {
  explanationLanguageForSave,
  explanationLanguageFromClient,
  explanationSourceForSave,
  isUntouchedAiDraft,
} from '@/lib/ai/explanationSource';

// The "Draft with AI" provenance classifier (Subtask 8.8.12), shared by the
// create modal + edit form. Pure logic — keyed off the AI-produced baseline.
describe('explanationSourceForSave', () => {
  it('returns undefined when there was no AI draft this session', () => {
    expect(explanationSourceForSave('Hand-typed prose', null)).toBeUndefined();
    expect(explanationSourceForSave('', null)).toBeUndefined();
  });

  it('returns ai_draft when the value still equals the untouched draft', () => {
    expect(explanationSourceForSave('AI drafted this.', 'AI drafted this.')).toBe('ai_draft');
  });

  it('ignores surrounding whitespace when matching the draft (still ai_draft)', () => {
    expect(explanationSourceForSave('  AI drafted this.\n', 'AI drafted this.')).toBe('ai_draft');
  });

  it('returns user_edited when the user changed the draft', () => {
    expect(explanationSourceForSave('AI drafted this, then I edited.', 'AI drafted this.')).toBe(
      'user_edited',
    );
  });

  it('returns undefined when a draft was cleared to empty', () => {
    expect(explanationSourceForSave('   ', 'AI drafted this.')).toBeUndefined();
  });
});

describe('isUntouchedAiDraft', () => {
  it('is true only while the editor holds the untouched draft', () => {
    expect(isUntouchedAiDraft('AI drafted this.', 'AI drafted this.')).toBe(true);
    expect(isUntouchedAiDraft('AI drafted this, edited.', 'AI drafted this.')).toBe(false);
    expect(isUntouchedAiDraft('AI drafted this.', null)).toBe(false);
  });
});

// Story MOTIR-7734 · MOTIR-8744 — the language a drafted explanation is SAVED
// with: the draft's, only while there is a draft, text and a stated language.
describe('explanationLanguageForSave', () => {
  it('is undefined with no draft this session, whatever language is held', () => {
    expect(explanationLanguageForSave('Hand-typed prose', null, 'ko')).toBeUndefined();
  });

  it('is undefined when the draft was cleared to empty', () => {
    expect(explanationLanguageForSave('   ', '초안', 'ko')).toBeUndefined();
  });

  it('is undefined when the draft’s frame named no language', () => {
    expect(explanationLanguageForSave('초안', '초안', null)).toBeUndefined();
  });

  it('is the draft’s language for an untouched draft', () => {
    expect(explanationLanguageForSave('초안', '초안', 'ko')).toBe('ko');
  });

  it('keeps the draft’s language for an edited draft (a human edit is not detected)', () => {
    expect(explanationLanguageForSave('초안, 수정함', '초안', 'ko')).toBe('ko');
  });
});

describe('explanationLanguageFromClient', () => {
  it('forwards a supported explanation language beside explanation text', () => {
    expect(explanationLanguageFromClient({ explanation: 'zh' }, '原因')).toEqual({
      languages: { explanation: 'zh' },
    });
  });

  it('drops a language outside the eleven codes, or one with no text', () => {
    expect(explanationLanguageFromClient({ explanation: 'xx' }, 'Why')).toEqual({});
    expect(explanationLanguageFromClient({ explanation: 'ko' }, '  ')).toEqual({});
    expect(explanationLanguageFromClient({ explanation: 'ko' }, null)).toEqual({});
    expect(explanationLanguageFromClient(undefined, 'Why')).toEqual({});
  });

  it('never forwards a forged title or description language', () => {
    const forged = { explanation: 'ko', title: 'ja', description: 'de' } as {
      explanation?: unknown;
    };
    expect(explanationLanguageFromClient(forged, 'Why')).toEqual({
      languages: { explanation: 'ko' },
    });
  });
});
