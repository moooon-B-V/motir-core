// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ChildList } from '@/app/(authed)/items/[key]/_components/ChildList';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// MOTIR-2301 — the child row's own SHAPE routes through the element-semantic
// shape tokens, never a Tier-0 utility.
//
// The row shipped as `rounded-md px-2 py-2`. Only the shape tokens a
// `[data-style]` block overrides participate in the style swap, so the row's
// radius resolved to the generic `--radius-md` (the CARD/container radius, which
// differs from `--radius-control` in 8 of the 11 registered styles and is not
// overridden at all by `soft-playful`), and its padding was a fixed 8px/8px under
// every style. CLAUDE.md's shape rule maps a menu/list row to `--radius-control`
// + `--spacing-control-x|y`; this asserts the row keeps that mapping.
//
// This is the row-scoped guard, deliberately narrow: the repo-wide raw-`rounded-*`
// audit is its own scoped work, not this card's. It mirrors the shape of
// `tests/theme/swapLayerLint.test.ts`, which does the same job for the COLOUR axis.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/items/MOTIR-1',
  useSearchParams: () => new URLSearchParams(),
}));

const workflow = {
  id: 'wf_1',
  projectId: 'p_1',
  statuses: [
    { id: 's1', key: 'todo', label: 'To Do', category: 'todo', color: null, position: 'a0' },
  ],
  transitions: [],
  policyMode: 'restricted',
} as unknown as WorkflowDto;

const items = [
  {
    id: 'i_1',
    identifier: 'MOTIR-2302',
    kind: 'subtask',
    title: 'A child row',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
  },
] as unknown as WorkItemSummaryDto[];

function renderRow() {
  const { container } = renderWithIntl(
    <ChildList items={items} workflow={workflow} members={[] as WorkspaceMemberDTO[]} />,
  );
  const row = container.querySelector('li > a');
  expect(row).not.toBeNull();
  return row as HTMLAnchorElement;
}

describe('ChildList row — shape flows through the control tokens (MOTIR-2301)', () => {
  it('takes its radius from --radius-control, not a Tier-0 radius utility', () => {
    const row = renderRow();
    expect(row.className).toContain('rounded-(--radius-control)');
    expect(row.className).not.toMatch(/\brounded-(?:none|xs|sm|md|lg|xl|2xl|3xl|full)\b/);
    expect(row.className).not.toMatch(/rounded-\(--radius-(?:xs|sm|md|lg|xl)\)/);
  });

  it('takes its OWN padding from --spacing-control-x/y, not a fixed utility', () => {
    const row = renderRow();
    expect(row.className).toContain('px-(--spacing-control-x)');
    expect(row.className).toContain('py-(--spacing-control-y)');
    // A fixed px-/py-/p- number is what the token replaced.
    expect(row.className).not.toMatch(/\b[pP][xy]?-\d/);
  });

  it('keeps gap-3 raw — spacing BETWEEN children is layout, not the row’s shape', () => {
    expect(renderRow().className).toContain('gap-3');
  });

  it('leaves the hover fill and focus ring untouched', () => {
    const row = renderRow();
    expect(row.className).toContain('hover:bg-(--el-surface)');
    expect(row.className).toContain('focus-visible:ring-(--focus-ring-color)');
  });
});
