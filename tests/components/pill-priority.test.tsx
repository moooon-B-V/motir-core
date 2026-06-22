// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Pill } from '@/components/ui/Pill';

// MOTIR-1273 · 1266.2 — the `priority` Pill axis renders all five priorities
// with DISTINCT backgrounds, fixing the medium/lowest collapse. (No jest-dom —
// assert on className strings directly, per tests/components convention.)

afterEach(cleanup);

const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'] as const;

describe('Pill priority axis', () => {
  it('renders each priority with a distinct color-mix background off its --el-priority-* hue', () => {
    const classes = PRIORITIES.map((p) => {
      const { unmount } = render(<Pill priority={p}>{p}</Pill>);
      const cls = screen.getByText(p).className;
      unmount();
      return cls;
    });
    // Every priority chip references its own hue token …
    PRIORITIES.forEach((p, i) => {
      expect(classes[i]).toContain(`--el-priority-${p}`);
      expect(classes[i]).toContain('color-mix');
      // … and the ink is the AA-safe strong text (hue lives in the background).
      expect(classes[i]).toContain('--el-text-strong');
    });
    // All five class strings are unique (the un-collapse).
    expect(new Set(classes).size).toBe(PRIORITIES.length);
  });

  it('un-collapses medium and lowest specifically (the reported regression)', () => {
    const { unmount } = render(<Pill priority="medium">m</Pill>);
    const medium = screen.getByText('m').className;
    unmount();
    render(<Pill priority="lowest">l</Pill>);
    const lowest = screen.getByText('l').className;
    expect(medium).not.toBe(lowest);
    expect(medium).toContain('--el-priority-medium');
    expect(lowest).toContain('--el-priority-lowest');
  });

  it('emits no Tier-0 --color-* token (swap-layer compliant)', () => {
    render(<Pill priority="highest">x</Pill>);
    expect(screen.getByText('x').className).not.toMatch(/--color-/);
  });
});
