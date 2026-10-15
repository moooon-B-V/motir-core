import { describe, expect, it } from 'vitest';

import { guideOfferDeclinedBody, parseGuideOfferDeclined } from '@/lib/planning/guideOffer';

describe('guide offer decline marker', () => {
  it('round-trips a turn id', () => {
    expect(parseGuideOfferDeclined(guideOfferDeclinedBody('turn_1'))).toBe('turn_1');
  });

  it('does not read other system bodies as a decline', () => {
    expect(parseGuideOfferDeclined('Kept planning.')).toBeNull();
    expect(parseGuideOfferDeclined(guideOfferDeclinedBody('x').slice(0, -1))).toBeNull();
  });
});
