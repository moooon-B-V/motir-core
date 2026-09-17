// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { BoardCardDto } from '@/lib/dto/boards';
import type { HomeWorkItemRowDto } from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

// MOTIR-5477 §3 — ONE DONE RULE, ASSERTED ACROSS ALL THREE SURFACES AT ONCE.
//
// ⚠️ WHY THIS EXISTS WHEN `ciBadgeState` ALREADY HAS ITS OWN 4 × 3 TABLE. That
// table proves the RULE returns null for a done card. It cannot prove the three
// surfaces APPLY it: each one builds its own inputs — the board card reads a
// `statusCategory` the projection resolved server-side, the `/items` row reads the
// one its mapper carried, and the Workbench row reads one `toWorkbenchRowViews`
// resolves from the workflow — and a surface that passed the wrong argument, or
// none, would draw a red badge on a finished card with every other test green.
//
// So: ONE fixture value (`failing` × a `done` category), THREE renders, and the
// same query. A surface that forgets the rule fails on its own row of the table.

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: 'workbench') =>
      createTranslator({ locale: 'en', messages, namespace }),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { BoardCard } from '@/app/(authed)/boards/_components/BoardCard';
import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { WorkbenchList } from '@/app/(authed)/workbench/_components/WorkbenchList';
import { toWorkbenchRowViews } from '@/app/(authed)/workbench/_components/workbenchRows';

afterEach(cleanup);

const MEMBERS: WorkspaceMemberDTO[] = [
  { userId: 'u1', name: 'Zhu Yue', email: 'yue@example.com', role: 'owner' },
];

const WORKFLOW = {
  statuses: [
    { key: 'in_progress', label: 'In Progress', category: 'in_progress' },
    { key: 'done', label: 'Done', category: 'done' },
  ],
} as unknown as WorkflowDto;

/** The badge as every surface emits it — the shared component's marker. */
function badgeIn(root: ParentNode): Element | null {
  return root.querySelector('[data-ci-state]');
}

function boardCard(status: string, statusCategory: 'in_progress' | 'done'): BoardCardDto {
  return {
    id: 'w1',
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    key: 7,
    identifier: 'PROD-7',
    title: 'A finished change',
    status,
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    position: 'a0',
    ready: true,
    awaitingAcceptance: false,
    ciState: 'failing',
    statusCategory,
  } as BoardCardDto;
}

function listRow(status: string, statusCategory: 'in_progress' | 'done'): IssueRowData {
  return {
    id: 'w1',
    identifier: 'PROD-7',
    title: 'A finished change',
    kind: 'task',
    type: null,
    status,
    statusLabel: statusCategory === 'done' ? 'Done' : 'In Progress',
    statusCategory,
    ciState: 'failing',
    assigneeId: null,
    assigneeName: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasDescription: false,
    priority: 'medium',
    reporterName: 'Owner',
    dueDate: null,
    dueLabel: null,
    estimateMinutes: null,
    storyPoints: null,
    estimateLabel: null,
    storyPointsLabel: null,
    hasChildren: false,
  };
}

function workbenchRow(status: string): HomeWorkItemRowDto {
  return {
    id: 'w1',
    kind: 'task',
    type: null,
    key: 7,
    identifier: 'PROD-7',
    title: 'A finished change',
    status,
    ciState: 'failing',
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    completedAt: null,
    project: { id: 'p1', identifier: 'PROD', name: 'Prod' },
    viewerIsAssignee: true,
    viewerIsReporter: true,
  } as HomeWorkItemRowDto;
}

/** The three surfaces, each rendering the SAME card at the given status. */
const SURFACES: Array<{
  name: string;
  render: (status: string, category: 'in_progress' | 'done') => ParentNode;
}> = [
  {
    name: 'the BOARD card',
    render: (status, category) =>
      render(
        <BoardCard
          card={boardCard(status, category)}
          assigneeName={null}
          onOpenQuickView={() => {}}
        />,
      ).container,
  },
  {
    name: 'the /items LIST row',
    render: (status, category) =>
      render(
        <IssueListTable
          rows={[listRow(status, category)]}
          sort={{ column: 'key', direction: 'asc' }}
          filter={EMPTY_FILTER}
          pagination={{ total: 1, page: 1, pageSize: 50 }}
        />,
      ).container,
  },
  {
    name: 'the WORKBENCH row',
    render: (status) =>
      render(
        <WorkbenchList
          rows={toWorkbenchRowViews([workbenchRow(status)], WORKFLOW, MEMBERS, false)}
          label="To do"
          tab="todo"
          pagination={{ total: 1, page: 1, pageSize: 25 }}
        />,
      ).container,
  },
];

describe('§3 one done rule — a finished card draws no badge anywhere (MOTIR-5477)', () => {
  for (const surface of SURFACES) {
    it(`${surface.name} draws NOTHING for a done-category failing card`, () => {
      const container = surface.render('done', 'done');
      expect(badgeIn(container)).toBeNull();
    });

    // ⚠️ THE CONTROL, and it is not optional: "no badge" is also what a surface
    // that never learned to draw one produces. The same fixture at an OPEN status
    // must draw the badge through the same render, or the assertion above proves
    // nothing about the rule.
    it(`${surface.name} DOES draw it for the same card while it is open`, () => {
      const container = surface.render('in_progress', 'in_progress');
      const badge = badgeIn(container);
      expect(badge).toBeTruthy();
      expect(badge!.getAttribute('data-ci-state')).toBe('failing');
    });
  }
});
