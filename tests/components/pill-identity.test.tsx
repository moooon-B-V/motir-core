// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Pill } from '@/components/ui/Pill';

// MOTIR-1274 · 1266.3 — the role / org-role / privacy Pill axes render through
// the DEDICATED --el-role-* / --el-org-role-* / --el-privacy-* tokens (no longer
// the shared --el-tint-* pool), each keeping the AA-safe --el-text-strong ink on
// a hued tint background. (No jest-dom — assert on className strings directly,
// per tests/components convention.)

afterEach(cleanup);

describe('Pill identity-hue axes', () => {
  it('memberRole routes through --el-role-* with AA-safe strong ink', () => {
    const roles = ['admin', 'member', 'viewer'] as const;
    const classes = roles.map((r) => {
      const { unmount } = render(<Pill memberRole={r}>{r}</Pill>);
      const cls = screen.getByText(r).className;
      unmount();
      return cls;
    });
    roles.forEach((r, i) => {
      expect(classes[i]).toContain(`bg-(--el-role-${r})`);
      expect(classes[i]).toContain('--el-text-strong');
      expect(classes[i]).not.toContain('--el-tint-');
    });
  });

  it('orgRole routes through --el-org-role-*', () => {
    const roles = ['owner', 'admin', 'member'] as const;
    roles.forEach((r) => {
      const { unmount } = render(<Pill orgRole={r}>{r}</Pill>);
      const cls = screen.getByText(r).className;
      unmount();
      expect(cls).toContain(`bg-(--el-org-role-${r})`);
      expect(cls).not.toContain('--el-tint-');
    });
  });

  it('the privacy "Not public" badge routes through --el-privacy-private', () => {
    render(<Pill tone="private">Not public</Pill>);
    const cls = screen.getByText('Not public').className;
    expect(cls).toContain('bg-(--el-privacy-private)');
    expect(cls).toContain('--el-text-strong');
    expect(cls).not.toContain('--el-tint-');
  });
});
