import { describe, expect, it } from 'vitest';
import { formatGraphSize } from '@/lib/codeGraph/formatGraphSize';

// The size format design/code-context §17.5 specifies for the refusal line
// (MOTIR-7132): binary units, at most one decimal, TRUNCATED, and no trailing `.0`.

const GIB = 1024 ** 3;

describe('formatGraphSize', () => {
  it.each([
    [GIB, '1 GiB'],
    [1_503_238_553, '1.4 GiB'], // 1.39999… GiB — float noise is not a tenth
    [1.4 * GIB, '1.4 GiB'],
    [GIB + 1, '1 GiB'],
    [1.96 * GIB, '1.9 GiB'],
    [4 * GIB, '4 GiB'],
    [1_000_000, '976.5 KiB'],
    [2_000_000, '1.9 MiB'],
    [600 * 1024 * 1024, '600 MiB'],
    [512, '512 B'],
    [0, '0 B'],
  ])('%d bytes → %s', (bytes, expected) => {
    expect(formatGraphSize(bytes)).toBe(expected);
  });

  it('truncates, never rounds up — a size is never overstated', () => {
    expect(formatGraphSize(GIB * 1.99)).toBe('1.9 GiB');
  });

  it('uses the locale’s digits but the same unit symbols', () => {
    expect(formatGraphSize(1.4 * GIB, 'zh')).toBe('1.4 GiB');
    expect(formatGraphSize(1.4 * GIB, 'de')).toBe('1,4 GiB');
  });

  it('treats a negative as zero rather than printing a minus', () => {
    expect(formatGraphSize(-5)).toBe('0 B');
  });
});
