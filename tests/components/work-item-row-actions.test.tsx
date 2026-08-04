// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { WorkItemRowActions } from '@/app/(authed)/items/_components/WorkItemRowActions';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';

// MOTIR-2098 — the ROW → menu seam. MOTIR-2097 put the whole Plan / Re-plan rule
// behind one shared function and every surface asks it, but this one had to
// degrade rule 2 ("a LEAF with a description shows Re-plan") to a hardcoded
// `hasDescription: false`, because no list row carried a description signal.
// The reads now project the boolean, so what is pinned here is that the ROW's
// value reaches the rule — the menu's own rule tests live in
// work-item-actions-menu.test.tsx, and duplicating them here would test the
// function twice and the wiring never.

function row(over: Partial<IssueRowData> & { identifier: string }): IssueRowData {
  return {
    id: `wi_${over.identifier}`,
    title: 'An issue',
    kind: 'task',
    type: 'code',
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    assigneeId: null,
    assigneeName: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    priority: 'medium',
    reporterName: 'Ada',
    dueDate: null,
    dueLabel: null,
    estimateMinutes: null,
    estimateLabel: null,
    storyPoints: null,
    storyPointsLabel: null,
    hasChildren: false,
    hasDescription: false,
    ...over,
  };
}

function openRowMenu(data: IssueRowData) {
  renderWithIntl(
    <ToastProvider>
      <ProjectAccessProvider canEdit canManage={false}>
        <WorkItemRowActions row={data} />
      </ProjectAccessProvider>
    </ToastProvider>,
  );
  fireEvent.click(
    screen.getByRole('button', { name: new RegExp(`Actions for ${data.identifier}`) }),
  );
}

const expand = () => screen.queryByRole('menuitem', { name: 'Expand' });
const replan = () => screen.queryByRole('menuitem', { name: 'Re-plan' });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WorkItemRowActions — the row feeds rule 2 with its own description signal', () => {
  it('a LEAF row WITH a description offers Re-plan, not Expand', () => {
    openRowMenu(row({ identifier: 'PROD-1', kind: 'task', hasDescription: true }));
    expect(replan()).toBeTruthy();
    expect(expand()).toBeNull();
  });

  it('a LEAF row WITHOUT a description offers Expand, not Re-plan', () => {
    openRowMenu(row({ identifier: 'PROD-2', kind: 'task', hasDescription: false }));
    expect(expand()).toBeTruthy();
    expect(replan()).toBeNull();
  });

  it('every leaf kind reads its face from the description — bug and subtask too', () => {
    for (const kind of ['bug', 'subtask'] as const) {
      cleanup();
      openRowMenu(row({ identifier: 'PROD-3', kind, hasDescription: true }));
      expect(replan()).toBeTruthy();
      expect(expand()).toBeNull();
    }
  });

  it('rule 3 still wins for a CONTAINER — a described but childless epic reads Expand', () => {
    // The described-ness of a container is irrelevant: for an epic/story it is
    // the CHILDREN that constitute the plan, not the prose.
    openRowMenu(
      row({ identifier: 'PROD-4', kind: 'epic', hasChildren: false, hasDescription: true }),
    );
    expect(expand()).toBeTruthy();
    expect(replan()).toBeNull();
  });

  it('rule 1 still wins over rule 2 — a DONE described leaf offers neither door', () => {
    openRowMenu(
      row({ identifier: 'PROD-5', kind: 'task', hasDescription: true, statusCategory: 'done' }),
    );
    expect(expand()).toBeNull();
    expect(replan()).toBeNull();
  });
});
