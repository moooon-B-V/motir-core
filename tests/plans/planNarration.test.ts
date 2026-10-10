import { describe, expect, it } from 'vitest';
import {
  cleanNarrationSentence,
  PLAN_NARRATION_BATCH_MAX,
  PLAN_NARRATION_SENTENCE_MAX,
} from '@/lib/plans/planNarration';

// Story MOTIR-8060 · Subtask MOTIR-8062 — the one rule both narration doors share
// for a single sentence: what is stored is what a person reads in the chat panel,
// so it is one line, has no control characters, and has a length the panel can
// wrap. Pure, so it is pinned here without a database.

describe('cleanNarrationSentence', () => {
  it('collapses every run of whitespace — newlines and tabs included — to one space', () => {
    expect(cleanNarrationSentence('  Laying\n\tthe   billing\r\nstory.  ')).toBe(
      'Laying the billing story.',
    );
  });

  it('strips control characters a terminal or a model might leave behind', () => {
    expect(cleanNarrationSentence('Reading\u0007 the \u001b[0mcard.')).toBe('Reading the [0mcard.');
  });

  it.each(['', '   ', '\n\t', '\u0000\u0007'])('returns null for %j — nothing to say', (raw) => {
    expect(cleanNarrationSentence(raw)).toBeNull();
  });

  it('keeps a sentence AT the cap untouched', () => {
    const exact = 'a'.repeat(PLAN_NARRATION_SENTENCE_MAX);
    expect(cleanNarrationSentence(exact)).toBe(exact);
  });

  it('cuts a sentence over the cap to the cap, ending in an ellipsis', () => {
    const cleaned = cleanNarrationSentence('b'.repeat(PLAN_NARRATION_SENTENCE_MAX + 50))!;
    expect(Array.from(cleaned)).toHaveLength(PLAN_NARRATION_SENTENCE_MAX);
    expect(cleaned.endsWith('…')).toBe(true);
  });

  it('counts by code point, so a cut never splits a surrogate pair', () => {
    const cleaned = cleanNarrationSentence('😀'.repeat(PLAN_NARRATION_SENTENCE_MAX + 5))!;
    const points = Array.from(cleaned);
    expect(points).toHaveLength(PLAN_NARRATION_SENTENCE_MAX);
    expect(points.slice(0, -1).every((p) => p === '😀')).toBe(true);
  });

  it('pins the two caps the doors and the tool description cite', () => {
    expect(PLAN_NARRATION_SENTENCE_MAX).toBe(240);
    expect(PLAN_NARRATION_BATCH_MAX).toBe(20);
  });
});
