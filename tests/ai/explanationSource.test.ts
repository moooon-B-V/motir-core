import { describe, it, expect } from 'vitest';
import { explanationSourceForSave, isUntouchedAiDraft } from '@/lib/ai/explanationSource';

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
