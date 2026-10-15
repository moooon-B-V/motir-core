import { describe, expect, it } from 'vitest';

import { composeGuideSeedFirstTurn, isGuideSeedableState } from '@/lib/planning/guideSeed';

describe('composeGuideSeedFirstTurn', () => {
  it('returns the request byte for byte, trimming only its outer whitespace', () => {
    const request =
      '## Re-plan MOTIR-9\n\n- the provider is retired — «déjà vu» 日本語\n\n  indented line';
    expect(composeGuideSeedFirstTurn({ requestMd: `\n  ${request}\t \n` })).toBe(request);
  });

  it('reads a blank request as null, so it is not seedable', () => {
    expect(composeGuideSeedFirstTurn({ requestMd: ' \n\t ' })).toBeNull();
    expect(composeGuideSeedFirstTurn({ requestMd: '' })).toBeNull();
  });
});

describe('isGuideSeedableState', () => {
  it('seeds an undecided or confirmed offer, and nothing else', () => {
    expect(isGuideSeedableState('undecided')).toBe(true);
    expect(isGuideSeedableState('confirmed')).toBe(true);
    expect(isGuideSeedableState('declined')).toBe(false);
    expect(isGuideSeedableState('superseded')).toBe(false);
    expect(isGuideSeedableState(null)).toBe(false);
  });
});
