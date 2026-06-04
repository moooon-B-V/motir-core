// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReadinessVerdictDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { RelationshipsPanel } from '@/app/(authed)/issues/[key]/_components/RelationshipsPanel';

// The 2.4.5 relationships surface (per design/work-items/relationships.mock.html):
// the reusable ReadinessBadge banner + the RelationshipsPanel that groups link
// edges by kind and shows the banner above them. Both are pure server components
// with no async/data work, so they render directly under happy-dom — no DB,
// runnable in-sandbox. The same RelationshipsPanel is reused read-only on the
// edit page (this covers that too — it's one component).

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
  it('renders the state as TEXT (not colour alone) — "Ready to start" when ready', () => {
    render(<ReadinessBadge ready />);
    screen.getByText('Ready to start');
    screen.getByText('All blockers resolved');
  });

  it('names + links the open blockers when blocked', () => {
    render(
      <ReadinessBadge
        ready={false}
        blockers={[
          { identifier: 'PROD-3', href: '/issues/PROD-3' },
          { identifier: 'PROD-12', href: '/issues/PROD-12' },
        ]}
      />,
    );
    screen.getByText('Blocked');
    screen.getByText(/Waiting on 2 issues/);
    const link = screen.getByRole('link', { name: 'PROD-3' });
    expect(link.getAttribute('href')).toBe('/issues/PROD-3');
  });

  it('singularizes "issue" for a single blocker', () => {
    render(
      <ReadinessBadge
        ready={false}
        blockers={[{ identifier: 'PROD-3', href: '/issues/PROD-3' }]}
      />,
    );
    screen.getByText(/Waiting on 1 issue —/);
  });
});

describe('RelationshipsPanel (2.4.5)', () => {
  it('shows a muted empty state (not blank) + the manage note when there are no links', () => {
    render(<RelationshipsPanel {...EMPTY} readiness={READY} workflow={workflow} />);
    screen.getByText('Relationships');
    screen.getByText('Manage in Epic 5');
    screen.getByText('No linked issues yet.');
    // No blockers → no readiness banner at all.
    expect(screen.queryByText('Ready to start')).toBeNull();
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

    screen.getByText('Blocked by');
    screen.getByText('Blocks');
    screen.getByText('Relates to');
    screen.getByText('Duplicates');
    screen.getByText('Clones');

    // The blocked-by ROW (named by its title — the banner also links PROD-3).
    const blocker = screen.getByRole('link', { name: /Upstream/ });
    expect(blocker.getAttribute('href')).toBe('/issues/PROD-3');
    expect(blocker.textContent).toContain('PROD-3');
    expect(blocker.textContent).toContain('To Do');

    expect(screen.getByRole('link', { name: /Downstream/ }).textContent).toContain('Done');

    // Blockers present → the banner shows and names the open blocker.
    screen.getByText('Blocked');
    screen.getByText(/Waiting on 1 issue/);
  });

  it('shows "Ready to start" above the groups when blockers exist but are all resolved', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        blockedBy={[summary({ id: 'b', identifier: 'PROD-3', status: 'done' })]}
        readiness={{ ready: true, openBlockers: [] }}
        workflow={workflow}
      />,
    );
    screen.getByText('Ready to start');
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
