import { describe, expect, it } from 'vitest';
import { QUICK_SEARCH_MIN_QUERY_LENGTH, quickSearchNumber } from '@/lib/workItems/quickSearch';

// MOTIR-6896 — the pure half of the bare-number arm: which queries NAME a
// work-item number. Everything that returns `null` here takes the unchanged
// key-prefix + title path in `workItemRepository.quickSearch`, so this is also
// the proof that nothing but digits ever reaches the integer bind.

describe('quickSearchNumber', () => {
  it('reads a bare number and a `#`-prefixed one', () => {
    expect(quickSearchNumber('6010')).toBe(6010);
    expect(quickSearchNumber('#6010')).toBe(6010);
    expect(quickSearchNumber('  #6010  ')).toBe(6010);
  });

  it('names no number for anything that is not digits only', () => {
    for (const q of [
      '1; drop',
      '6010 plan',
      'MOTIR-6010',
      '##6010',
      '60-10',
      '6.5',
      '',
      '   ',
      '#',
    ]) {
      expect(quickSearchNumber(q), `query=${JSON.stringify(q)}`).toBeNull();
    }
  });

  it('names no number below the minimum length — `#6` as `6` alone', () => {
    expect(QUICK_SEARCH_MIN_QUERY_LENGTH).toBe(2);
    expect(quickSearchNumber('6')).toBeNull();
    expect(quickSearchNumber('#6')).toBeNull();
    expect(quickSearchNumber('10')).toBe(10);
  });

  it('names no number beyond the integer column', () => {
    expect(quickSearchNumber('2147483647')).toBe(2147483647);
    expect(quickSearchNumber('2147483648')).toBeNull();
    expect(quickSearchNumber('99999999999999999999')).toBeNull();
  });
});
