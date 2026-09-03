// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { PlanProposalPeekDto } from '@/lib/dto/planReview';
import { PLAN_ITEM_SETTABLE_RAIL_FIELDS } from '@/lib/dto/planReview';

// MOTIR-4184 (story MOTIR-4181, design Part XIV) — the shipped peek in PROPOSAL
// MODE. One component, not two: `ProposalQuickView` exists because a proposal
// peek could once only be opened on an `add`, and every field the review model
// carries has since had to be walked across the op axis by hand, one bug report
// at a time (MOTIR-4134, MOTIR-4143).
//
// ⚠️ THE ASSERTIONS ARE PER FIELD, DELIBERATELY. A test on *"the rail rendered"*
// passes with one row back, which is the EXACT shape MOTIR-4143 was filed for: a
// `modify` whose whole rail had collapsed to a single Parent row, on the surface
// a person approves from. Asserting presence would reproduce the defect's own
// blind spot.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';

const DATA: QuickViewData = {
  id: 'cmqvitem00000000000000p7',
  identifier: 'PROD-7',
  title: 'Email + password sign-in',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'subtask',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  descriptionMd: 'Sign in with email and password.',
  explanationMd: null,
  type: 'code',
  executor: 'coding_agent',
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  archived: null,
  parent: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: true,
  status: 'in_progress',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points' as const,
    pointScale: 'fibonacci' as const,
    customScaleValues: [],
    canEdit: true,
  },
};
/** A `modify` moving two rail rows and both bodies. */
const MODIFY: PlanProposalPeekDto = {
  op: 'modify',
  identifier: 'PROD-7',
  changedFields: ['priority', 'storyPoints', 'description'],
  settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
};

const ADD: PlanProposalPeekDto = {
  op: 'add',
  identifier: null,
  changedFields: [],
  settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
};

const REMOVE: PlanProposalPeekDto = {
  op: 'remove',
  identifier: 'PROD-7',
  changedFields: [],
  settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
};

const DATA_WITH_WHY: QuickViewData = {
  ...DATA,
  explanationMd: 'Because approving is the only path from a proposal to a work item.',
};

function renderProposal(proposal: PlanProposalPeekDto, data: QuickViewData = DATA_WITH_WHY) {
  return render(<IssueQuickViewPanel state="ready" data={data} proposal={proposal} />);
}

afterEach(cleanup);

describe('the shipped peek in PROPOSAL MODE (MOTIR-4184)', () => {
  it('a modify shows the identifier, the op word, BOTH bodies and every rail value — per field (AC 1, 4)', () => {
    renderProposal(MODIFY);

    // WHICH work item, and WHAT the plan will do to it.
    expect(screen.getByText('PROD-7')).toBeTruthy();
    expect(screen.getByTestId('quick-view-op').textContent).toBe('change');

    // Both bodies. AC 4 is asserted DIRECTLY because the two prior defects in
    // this area were both "a body that was carried and never displayed".
    expect(screen.getByText(/Sign in with email and pass/)).toBeTruthy();
    expect(screen.getByText(/only path from a proposal to a work item/)).toBeTruthy();

    // Every rail row, by LABEL — not `rail.children.length`, which would pass
    // with the wrong rows.
    for (const label of [
      'Status',
      'Repositories',
      'Priority',
      'Assignee',
      'Reporter',
      'Parent',
      'Labels',
      'Components',
      'Due date',
      'Sprint',
      'Story points',
      'Estimate',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('suppresses EVERY editor while the actor may edit — suppression, not the permission gate (AC 2)', () => {
    // `canEdit` defaults TRUE without a ProjectAccessProvider, so this mount is
    // the permitted actor. Any affordance found here is proposal mode failing to
    // suppress, never the gate refusing.
    const committed = render(<IssueQuickViewPanel state="ready" data={DATA} />);
    const editableWhenCommitted = committed.container.querySelectorAll('[aria-label^="Edit "]');
    expect(editableWhenCommitted.length).toBeGreaterThan(0); // the control case
    cleanup();

    const { container } = renderProposal(MODIFY);
    expect(container.querySelectorAll('[aria-label^="Edit "]').length).toBe(0);
  });

  it('marks the rows the plan MOVES and leaves the rest alone (AC 3)', () => {
    const { container } = renderProposal(MODIFY);
    const marks = container.querySelectorAll('[data-testid="quick-view-changed-mark"]');
    // `priority` and `storyPoints` are rail rows; `description` is a body and is
    // NOT a rail row, which is why the count is two rather than three.
    expect(marks.length).toBe(2);

    // Scoped to the row's own `<dt>`, which is where the design puts the chip
    // so a screen reader announces it as part of the TERM — "Priority changed" —
    // rather than as a loose chip a reader associates by position.
    const term = (label: string) => {
      const dt = Array.from(container.querySelectorAll('dt')).find((el) =>
        el.textContent?.startsWith(label),
      );
      if (!dt) throw new Error(`no rail term for ${label}`);
      return dt;
    };
    expect(within(term('Priority')).queryAllByTestId('quick-view-changed-mark').length).toBe(1);
    expect(within(term('Assignee')).queryAllByTestId('quick-view-changed-mark').length).toBe(0);
    expect(term('Priority').textContent).toBe('Prioritychanged');
  });

  it('renders NO marker anywhere when the plan changes nothing in the rail (AC 3)', () => {
    const { container } = renderProposal({ ...MODIFY, changedFields: ['description'] });
    expect(container.querySelectorAll('[data-testid="quick-view-changed-mark"]').length).toBe(0);
    // …and says so in words, which is what makes the silence readable.
    expect(screen.getByTestId('quick-view-proposal-foot').textContent).toMatch(/none of these/i);
  });

  it('the count line names the DENOMINATOR, so silence is distinguishable from unsettable (AC 3)', () => {
    renderProposal(MODIFY);
    const foot = screen.getByTestId('quick-view-proposal-foot').textContent ?? '';
    expect(foot).toMatch(/2/);
    expect(foot).toMatch(new RegExp(String(PLAN_ITEM_SETTABLE_RAIL_FIELDS.length)));
  });

  it('an ADD says it does not exist yet and offers NO link out; a modify does (AC 5)', () => {
    renderProposal(ADD);
    expect(screen.getByTestId('quick-view-proposal-new').textContent).toBe('New');
    expect(screen.getByTestId('quick-view-op').textContent).toBe('not yet created');
    // Absent rather than disabled: a disabled control in a dialog is a tab stop
    // that answers nothing.
    expect(screen.queryByTestId('quick-view-open-full')).toBeNull();
    cleanup();

    renderProposal(MODIFY);
    const link = screen.getByTestId('quick-view-open-full');
    // The label carries the TENSE — the destination shows the work item as it
    // STANDS, and nothing on that page says a plan is about to change it
    // (MOTIR-4197).
    expect(link.textContent).toMatch(/as it stands/i);
  });

  it('a remove keeps the target’s identity and says what approving does (AC 1)', () => {
    renderProposal(REMOVE);
    expect(screen.getByTestId('quick-view-op').textContent).toBe('remove');
    expect(screen.getByText('PROD-7')).toBeTruthy();
    expect(screen.getByTestId('quick-view-proposal-foot').textContent).toMatch(/archives/i);
  });

  it('suppresses the sections a proposal cannot fill, and the audit line (AC 1)', () => {
    const { container } = renderProposal(MODIFY);
    // Development / delivery: a proposal delivers nothing.
    expect(container.querySelector('[data-testid="development-section"]')).toBeNull();
    // The audit line is REPLACED by the count, not joined by it.
    expect(screen.queryByText(/^Created/)).toBeNull();
    // The Plan / Re-plan entrance: a proposal is already the output of one.
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('keeps exactly ONE close affordance, with one accessible name (AC 7)', () => {
    const { container } = renderProposal(MODIFY);
    const closes = Array.from(container.querySelectorAll('[aria-label]')).filter(
      (el) => el.getAttribute('aria-label') === 'Close',
    );
    // The defect MOTIR-4022 measured on the surface being retired — two controls
    // named `Close` 40px apart in one dialog — must not return with it.
    expect(closes.length).toBe(1);
  });

  it('carries the marker’s meaning in a WORD, not in colour alone (AC 8)', () => {
    const { container } = renderProposal(MODIFY);
    const mark = container.querySelector('[data-testid="quick-view-changed-mark"]')!;
    expect(mark.textContent?.trim()).toBe('changed');
    // The named token the design specifies — no invented colour.
    expect(mark.className).toContain('bg-(--el-diff-moved)');
  });

  it('leaves the COMMITTED peek exactly as it was — no proposal, no change (AC 6)', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    // The six committed hosts pass no `proposal` and must be untouched by its
    // existence: the shipped deferral line, the audit line and the editors all
    // stay. A change forced on any of them means the arm went in the wrong place.
    expect(screen.queryByTestId('quick-view-proposal-foot')).toBeNull();
    expect(screen.queryByTestId('quick-view-op')).toBeNull();
    expect(screen.getByText(/live on the/)).toBeTruthy();
    expect(screen.getAllByText(/^Created/).length).toBeGreaterThan(0);
  });
});
