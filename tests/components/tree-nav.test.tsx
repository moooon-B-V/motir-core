// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { ParentBreadcrumb } from '@/app/(authed)/issues/[key]/_components/ParentBreadcrumb';
import { ChildList } from '@/app/(authed)/issues/[key]/_components/ChildList';

// Pure presentational tree-navigation surfaces for the issue detail page
// (Subtask 2.4.3): the parent breadcrumb (ancestor chain, root→self) and the
// direct-child list. Both are server components with no async/data work, so
// they render directly under happy-dom — no DB, runnable in-sandbox.

afterEach(cleanup);

function summary(overrides: Partial<WorkItemSummaryDto> = {}): WorkItemSummaryDto {
  return {
    id: 'wi',
    parentId: null,
    kind: 'task',
    key: 1,
    identifier: 'PROD-1',
    title: 'An item',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    archivedAt: null,
    ...overrides,
  };
}

const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's1',
      projectId: 'p1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a0',
      isInitial: true,
    },
    {
      id: 's2',
      projectId: 'p1',
      key: 'in_progress',
      label: 'In Progress',
      category: 'in_progress',
      color: null,
      position: 'a1',
      isInitial: false,
    },
  ],
  transitions: [],
  policyMode: 'open',
};

const members: WorkspaceMemberDTO[] = [
  { userId: 'u_dana', name: 'Dana Kim', email: 'dana@example.com', role: 'member' },
];

describe('ParentBreadcrumb (2.4.3)', () => {
  it('renders nothing for a top-level item (no ancestors → no breadcrumb)', () => {
    const { container } = render(<ParentBreadcrumb ancestors={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the ancestor chain root→self, each a link to its detail page', () => {
    const ancestors = [
      summary({ id: 'e', kind: 'epic', identifier: 'PROD-12', title: 'Q3 launch' }),
      summary({ id: 's', kind: 'story', identifier: 'PROD-31', title: 'OAuth sign-in' }),
    ];
    render(<ParentBreadcrumb ancestors={ancestors} />);

    const nav = screen.getByRole('navigation', { name: /parent issues/i });
    const links = within(nav).getAllByRole('link');
    // Order is root→self: Epic first, immediate parent (Story) last.
    expect(links).toHaveLength(2);
    expect(links[0]?.textContent).toContain('Epic: Q3 launch');
    expect(links[0]?.getAttribute('href')).toBe('/issues/PROD-12');
    expect(links[1]?.textContent).toContain('Story: OAuth sign-in');
    expect(links[1]?.getAttribute('href')).toBe('/issues/PROD-31');
  });
});

describe('ChildList (2.4.3)', () => {
  it('renders nothing for a leaf (no children → no scaffold)', () => {
    const { container } = render(<ChildList items={[]} workflow={workflow} members={members} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists each child as a link with identifier, title, status pill, and a count', () => {
    const items = [
      summary({
        id: 'c1',
        identifier: 'PROD-41',
        title: 'Set up OAuth credentials',
        status: 'in_progress',
        assigneeId: 'u_dana',
      }),
      summary({ id: 'c2', identifier: 'PROD-49', title: 'Callback bug', status: 'todo' }),
    ];
    render(<ChildList items={items} workflow={workflow} members={members} />);

    // Section title + count badge reflecting the number of children.
    screen.getByText('Child issues');
    screen.getByText('2');

    const first = screen.getByRole('link', { name: /PROD-41/ });
    expect(first.getAttribute('href')).toBe('/issues/PROD-41');
    expect(first.textContent).toContain('Set up OAuth credentials');
    // Status renders the workflow label, not the raw key.
    expect(first.textContent).toContain('In Progress');
    // Assigned child shows the assignee's initial avatar (title carries identity).
    expect(within(first).getByTitle('Dana Kim').textContent).toBe('D');

    const second = screen.getByRole('link', { name: /PROD-49/ });
    expect(second.getAttribute('href')).toBe('/issues/PROD-49');
    expect(second.textContent).toContain('To Do');
    expect(within(second).queryByTitle(/.+/)).toBeNull(); // unassigned → no avatar
  });

  it('falls back to the raw status key when it is not in the workflow', () => {
    const items = [summary({ id: 'c3', identifier: 'PROD-50', status: 'mystery' })];
    render(<ChildList items={items} workflow={workflow} members={members} />);
    expect(screen.getByRole('link', { name: /PROD-50/ }).textContent).toContain('mystery');
  });
});
