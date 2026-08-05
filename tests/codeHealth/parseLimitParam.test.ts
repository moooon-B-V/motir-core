import { describe, expect, it } from 'vitest';
import { parseLimitParam, parseOffsetParam } from '@/app/api/ai/coding-convention/_shared';

// `findingsLimit` on the audit route (MOTIR-2207 · Panel 7 §3). It looks like
// the offset parser beside it and is deliberately NOT the same: an offset is
// 0-based (0 is the first page), while motir-ai's `parsePositiveInt` REJECTS a
// limit of 0 outright — so a `?findingsLimit=0` that slipped through here would
// come back as a 502 from the boundary, not as a cheap read.
describe('parseLimitParam', () => {
  it('accepts the cheapest legal summary limit', () => {
    expect(parseLimitParam('1')).toBe(1);
    expect(parseLimitParam('100')).toBe(100);
  });

  it('REJECTS 0 — the difference from the offset parser', () => {
    expect(parseLimitParam('0')).toBeUndefined();
    // …which accepts it, because 0 is a legitimate first page.
    expect(parseOffsetParam('0')).toBe(0);
  });

  it('falls back to the service default for absent or unusable input', () => {
    expect(parseLimitParam(null)).toBeUndefined();
    expect(parseLimitParam('')).toBeUndefined();
    expect(parseLimitParam('-1')).toBeUndefined();
    expect(parseLimitParam('1.5')).toBeUndefined();
    expect(parseLimitParam('abc')).toBeUndefined();
  });
});
