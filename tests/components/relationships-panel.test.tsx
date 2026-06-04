// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReadinessVerdictDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { RelationshipsPanel } from '@/app/(authed)/issues/[key]/_components/RelationshipsPanel';

// The 2.4.5 relationships surface: the reusable ReadinessBadge (the
// presentational face of the service readiness verdict) + the RelationshipsPanel
// that groups link edges by kind and shows the badge above them. Both are pure
// server components with no async/data work, so they render directly under
// happy-dom — no DB, runnable in-sandbox.

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
      key: 'done',
      label: 'Done',
      category: 'done',
      color: null,
      position: 'a1',
      isInitial: false,
    },
  ],
  transitions: [],
  policyMode: 'open',
};

const EMPTY: Omit<React.ComponentProps<typeof RelationshipsPanel>, 'readiness' | 'workflow'> = {
  blockedBy: [],
  blocks: [],
  relatesTo: [],
  duplicates: [],
  clones: [],
};
const READY: ReadinessVerdictDto = { ready: true, openBlockers: [] };

describe('ReadinessBadge (2.4.5)', () => {
  it('renders the state as TEXT (not colour alone) — "Ready" when ready', () => {
    render(<ReadinessBadge ready />);
    screen.getByText('Ready');
  });

  it('names the open blockers when blocked', () => {
    render(<ReadinessBadge ready={false} blockers={['PROD-3', 'PROD-12']} />);
    screen.getByText('Blocked');
    // The reason is legible: the open blockers are named in text.
    screen.getByText(/PROD-3, PROD-12/);
  });

  it('renders a bare "Blocked" with no names when none are passed (board-card reuse)', () => {
    const { container } = render(<ReadinessBadge ready={false} />);
    screen.getByText('Blocked');
    expect(container.textContent).not.toMatch(/by\s/i);
  });
});

describe('RelationshipsPanel (2.4.5)', () => {
  it('shows a muted empty state (not blank) when the item has no links', () => {
    render(<RelationshipsPanel {...EMPTY} readiness={READY} workflow={workflow} />);
    screen.getByText('Relationships');
    screen.getByText('No linked issues.');
    // No blockers → no readiness badge at all.
    expect(screen.queryByText('Ready')).toBeNull();
  });

  it('groups links by kind, each linked item a navigable row with its status', () => {
    render(
      <RelationshipsPanel
        blockedBy={[summary({ id: 'b', identifier: 'PROD-3', title: 'Upstream', status: 'todo' })]}
        blocks={[summary({ id: 'k', identifier: 'PROD-9', title: 'Downstream', status: 'done' })]}
        relatesTo={[summary({ id: 'r', identifier: 'PROD-5', title: 'Related thing' })]}
        duplicates={[summary({ id: 'd', identifier: 'PROD-7', title: 'Dup thing' })]}
        clones={[summary({ id: 'c', identifier: 'PROD-8', title: 'Clone thing' })]}
        readiness={{
          ready: false,
          openBlockers: [summary({ id: 'b', identifier: 'PROD-3' })],
        }}
        workflow={workflow}
      />,
    );

    // Group headers present.
    screen.getByText('Blocked by');
    screen.getByText('Blocks');
    screen.getByText('Relates to');
    screen.getByText('Duplicates');
    screen.getByText('Clones');

    // Each row links to its own detail page; status renders the workflow label.
    const blocker = screen.getByRole('link', { name: /PROD-3/ });
    expect(blocker.getAttribute('href')).toBe('/issues/PROD-3');
    expect(blocker.textContent).toContain('Upstream');
    expect(blocker.textContent).toContain('To Do');

    const blocked = screen.getByRole('link', { name: /PROD-9/ });
    expect(blocked.textContent).toContain('Done');

    // Blockers present → the readiness badge shows and names the open blocker.
    screen.getByText('Blocked');
    screen.getByText(/^by PROD-3$/);
  });

  it('shows "Ready" above the groups when blockers exist but are all resolved', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        blockedBy={[summary({ id: 'b', identifier: 'PROD-3', status: 'done' })]}
        readiness={{ ready: true, openBlockers: [] }}
        workflow={workflow}
      />,
    );
    screen.getByText('Ready');
    // The resolved blocker is still listed under its group.
    within(screen.getByRole('link', { name: /PROD-3/ })).getByText('Done');
  });

  it('falls back to the raw status key for a cross-project status the workflow does not classify', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        relatesTo={[summary({ id: 'x', identifier: 'OTHER-2', status: 'mystery' })]}
        readiness={READY}
        workflow={workflow}
      />,
    );
    expect(screen.getByRole('link', { name: /OTHER-2/ }).textContent).toContain('mystery');
  });
});
