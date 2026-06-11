import { describe, expect, it } from 'vitest';
import { LABEL_TINTS, labelTint } from '@/lib/labels/labelTint';

// The label-colour deviation (Story 5.4 · Subtask 5.4.8): the chip tint is
// derived client-side from the name — FNV-1a over the lowercased name, mod 6,
// into the `--el-tint-*` pastel family. Deterministic, so the same label is
// the same colour on every surface and across sessions.

describe('labelTint', () => {
  it('is deterministic — the same name always hashes to the same tint', () => {
    const first = labelTint('perf-q3');
    for (let i = 0; i < 5; i++) expect(labelTint('perf-q3')).toBe(first);
  });

  it('is case-insensitive — PERF-Q3 and perf-q3 are the same label, same colour', () => {
    expect(labelTint('PERF-Q3')).toBe(labelTint('perf-q3'));
    expect(labelTint('Design-Debt')).toBe(labelTint('design-debt'));
  });

  it('always lands in the six-pastel family', () => {
    const names = ['api', 'perf-q3', 'design-debt', 'infra', 'flaky', 'onboarding', 'a', ''];
    for (const name of names) {
      expect(LABEL_TINTS).toContain(labelTint(name));
    }
  });

  it('spreads across the family (not a constant function)', () => {
    const tints = new Set(Array.from({ length: 40 }, (_, i) => labelTint(`label-${i}`)));
    expect(tints.size).toBeGreaterThan(1);
  });
});
