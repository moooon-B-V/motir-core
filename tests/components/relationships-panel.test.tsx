// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type {
  ReadinessVerdictDto,
  RelationshipLinkDto,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';

// The relationships surface (2.4.5 read + 2.4.9 edit). The panel now imports the
// client AddLinkControl / RemoveLinkButton, which import the detail-page Server
// Actions — stub that module so importing the panel doesn't pull in `db`. These
// tests render the panel READ-ONLY (editable unset), so the add/remove islands
// aren't instantiated; the interactive add control is tested in
// add-link-control.test.tsx.
vi.mock('@/app/(authed)/issues/[key]/actions', () => ({
  createLinkAction: vi.fn(),
  removeLinkAction: vi.fn(),
  listLinkCandidatesAction: vi.fn(),
}));

import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { RelationshipsPanel } from '@/app/(authed)/issues/[key]/_components/RelationshipsPanel';

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

function link(overrides: Partial<WorkItemSummaryDto> = {}): RelationshipLinkDto {
  const item = summary(overrides);
  return { linkId: `link-${item.id}`, item };
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
    const lnk = screen.getByRole('link', { name: 'PROD-3' });
    expect(lnk.getAttribute('href')).toBe('/issues/PROD-3');
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

describe('RelationshipsPanel (2.4.5 read-only)', () => {
  it('shows a muted empty state (not blank); read-only mode has no add control', () => {
    render(<RelationshipsPanel {...EMPTY} readiness={READY} workflow={workflow} />);
    screen.getByText('Relationships');
    screen.getByText('No linked issues yet.');
    expect(screen.queryByText('Ready to start')).toBeNull();
    // Not editable → no "+ Link issue" entry point.
    expect(screen.queryByRole('button', { name: /Link issue/ })).toBeNull();
  });

  it('groups links by kind, each linked item a navigable row with its status', () => {
    render(
      <RelationshipsPanel
        blockedBy={[link({ id: 'b', identifier: 'PROD-3', title: 'Upstream', status: 'todo' })]}
        blocks={[link({ id: 'k', identifier: 'PROD-9', title: 'Downstream', status: 'done' })]}
        relatesTo={[link({ id: 'r', identifier: 'PROD-5', title: 'Related thing' })]}
        duplicates={[link({ id: 'd', identifier: 'PROD-7', title: 'Dup thing' })]}
        clones={[link({ id: 'c', identifier: 'PROD-8', title: 'Clone thing' })]}
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

    screen.getByText('Blocked');
    screen.getByText(/Waiting on 1 issue/);
  });

  it('shows "Ready to start" above the groups when blockers exist but are all resolved', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        blockedBy={[link({ id: 'b', identifier: 'PROD-3', status: 'done' })]}
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
        relatesTo={[link({ id: 'x', identifier: 'OTHER-2', status: 'mystery' })]}
        readiness={READY}
        workflow={workflow}
      />,
    );
    expect(screen.getByRole('link', { name: /OTHER-2/ }).textContent).toContain('mystery');
  });
});
