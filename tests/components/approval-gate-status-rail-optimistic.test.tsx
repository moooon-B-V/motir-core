// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { announceGateDecided } from '@/lib/approvals/decidedGates';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// THE GUARD FOR *THE STATUS RAIL MOVES WITHOUT A SERVER ROUND TRIP* (Bug
// MOTIR-5212), RE-HOMED ONTO THE PATH THE DECISION TAKES NOW (Story MOTIR-5215 ·
// Subtask MOTIR-5229).
//
// ⚠️ THE DECISION IS NO LONGER MADE ON THIS PAGE. It used to be pressed in
// `DesignResultSection`, whose own decide call applied the optimistic status.
// The item page now hands the decision to the approval OVERLAY, mounted in the
// authed shell OUTSIDE the page's `OptimisticStatusProvider`; the overlay
// announces the decided row (`lib/approvals/decidedGates.ts`) and
// `DecidedGateStatusBridge`, rendered inside the provider, applies its
// `outcomeRef` (MOTIR-5570). This suite therefore drives the REAL announcement,
// the REAL bridge, the REAL section and the REAL rail inside the REAL provider —
// every half of the channel, no stand-in for any of them.
//
// ⚠️ WHY IT MOUNTS THE REAL RAIL AND NOT A STAND-IN. The defect is a missing
// CHANNEL between islands that do not know about each other. A test that drove
// the writer against a one-line fake reader would assert the provider works and
// say nothing about whether the rail is wired to it.
//
// ⚠️ WHAT "THE REFRESH DEFERRED" MEANS HERE. What a run waits for after a decision
// is the RSC APPLY a refresh triggers — a fresh server render with a new `status`
// prop. This suite never delivers one unless a case says so, which is the exact
// condition MOTIR-5118 measured in production (the apply lost, the rail stale for
// twenty seconds). A rail that reads `Done` under it is the property guarded.
//
// ⚠️ PROVEN ABLE TO GO RED: with the bridge's `applyOptimisticStatus(...)` line
// removed, test 1 fails on the rail still reading `In Progress`.
//
// ⚠️ NOTHING HERE REPLACES `tests/e2e/approval-gate-repaint.spec.ts`, which drives
// the same decision through the overlay in a real browser. This suite pins the
// mechanism; that one pins the outcome.
//
// The decided-gate store is module-level, as it is in the product, so every case
// uses its own gate id.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/items/MOTIR-4321',
  useSearchParams: () => new URLSearchParams(),
}));
// The rail's own inline-edit doors. Untouched by this suite — stubbed only so
// the panel mounts without pulling the server action modules (and the db client
// behind them) into a happy-dom lane, exactly as `issue-detail-fields.test.tsx`
// does.
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn().mockResolvedValue({ ok: true, updatedAt: 'x' }),
  changeStatusAction: vi.fn().mockResolvedValue({ ok: true, updatedAt: 'x' }),
}));
vi.mock('@/components/issues/actions/workItemActionsClient', () => ({
  setWorkItemSprint: vi.fn(),
}));
vi.mock('@/app/(authed)/items/actions', () => ({
  listCandidateParentsAction: vi.fn().mockResolvedValue({ ok: true, candidates: [] }),
}));
vi.mock('@/app/(authed)/items/[key]/customFieldActions', () => ({
  setCustomFieldValueAction: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/app/(authed)/items/[key]/labelComponentActions', () => ({
  addLabelAction: vi.fn().mockResolvedValue({ ok: true, labels: [] }),
  removeLabelAction: vi.fn().mockResolvedValue({ ok: true, labels: [] }),
  addComponentAction: vi.fn().mockResolvedValue({ ok: true, components: [] }),
  removeComponentAction: vi.fn().mockResolvedValue({ ok: true, components: [] }),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { CoreFieldsPanel } from '@/app/(authed)/items/[key]/_components/CoreFieldsPanel';
import { DesignResultSection } from '@/app/(authed)/items/[key]/_components/DesignResultSection';
import { DecidedGateStatusBridge } from '@/app/(authed)/items/[key]/_components/DecidedGateStatusBridge';
import { OptimisticStatusProvider } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';

afterEach(cleanup);

const members: WorkspaceMemberDTO[] = [
  { userId: 'u_reviewer', name: 'Ada Lovelace', email: 'ada@example.com', role: 'owner' },
];

const workflow: WorkflowDto = {
  statuses: [
    ['in_progress', 'In Progress', 'in_progress'],
    ['in_review', 'In Review', 'in_progress'],
    ['done', 'Done', 'done'],
  ].map(([key, label, category], i) => ({
    id: `s${i}`,
    projectId: 'proj_1',
    key: key as string,
    label: label as string,
    category: category as WorkflowDto['statuses'][number]['category'],
    color: null,
    position: `a${i}`,
    isInitial: false,
  })),
  transitions: [],
  policyMode: 'open',
};

function makeItem(status: string): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'proj_1',
    parentId: null,
    kind: 'subtask',
    key: 4321,
    identifier: 'MOTIR-4321',
    title: 'Design the approvals room',
    descriptionMd: null,
    explanationMd: null,
    explanationSource: 'user_authored',
    status,
    priority: 'medium',
    assigneeId: null,
    reporterId: 'u_reviewer',
    dueDate: null,
    estimateMinutes: null,
    type: 'design',
    executor: 'human',
    storyPoints: null,
    position: 'a0',
    sprintId: null,
    backlogRank: 'a0',
    publicChildrenHidden: false,
    sessionBranch: null,
    targetRepo: null,
    targetRepos: [],
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    subject: null,
    archivedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
  };
}

function awaiting(id: string): ApprovalGateDTO {
  return {
    id,
    workItemId: 'wi_1',
    kind: 'design_result',
    subjectId: 'ev-1',
    state: 'awaiting',
    decidedById: null,
    decidedAt: null,
    noteMd: null,
    supersededCause: null,
    subjectVersion: '9840d00ea1b2',
    decidedByLabel: null,
    routedToId: 'u_reviewer',
    decidedUnderAuthority: null,
    decisionSource: null,
    outcomeRef: null,
    chosenOption: null,
    createdAt: '2026-09-08T04:00:00.000Z',
    updatedAt: '2026-09-08T04:00:00.000Z',
  };
}

/**
 * The decided row the overlay's decide response carries, and announces.
 *
 * `outcomeRef` is the load-bearing field and it is the SERVER's own record of
 * the status its transaction wrote (`approvalGatesService.decide` sets it from
 * `effect.statusWritten`). A decision that moved nothing carries `null` —
 * which is what every `request_changes` returns.
 */
function decided(
  gate: ApprovalGateDTO,
  state: ApprovalGateDTO['state'],
  outcomeRef: string | null,
): ApprovalGateDTO {
  return {
    ...gate,
    state,
    decidedById: 'u_reviewer',
    decidedAt: '2026-09-08T05:00:00.000Z',
    decidedByLabel: 'Ada Lovelace',
    decidedUnderAuthority: 'reporter',
    decisionSource: 'ui',
    outcomeRef,
  };
}

/** A published design the port can SHOW, once a decided record renders it. */
const PUBLISHED: DesignEvidenceDTO = {
  id: 'ev-1',
  workItemId: 'wi_1',
  noteMd: '## The approvals room\n\nProse the reviewer reads.',
  noteTruncated: false,
  assets: [
    {
      id: 'a-note',
      kind: 'note_file',
      url: '/api/attachments/att-note/content',
      mimeType: 'text/markdown',
      sizeBytes: 64,
      sourcePath: 'design/approvals/design-notes.md',
      position: 0,
    },
  ],
  commitSha: 'cafe1234567',
  ciRunUrl: null,
  producedByKey: 'MOTIR-4320',
  createdAt: '2026-09-08T03:00:00.000Z',
  withdrawnAt: null,
  withdrawnById: null,
  withdrawnReason: null,
};

/** The page, reduced to the islands the channel joins plus the provider between
 *  them — the same nesting `items/[key]/page.tsx` and `LateSections.tsx` mount. */
function page(serverStatus: string, gate: ApprovalGateDTO) {
  return (
    <OptimisticStatusProvider serverStatus={serverStatus}>
      <DecidedGateStatusBridge gateId={gate.id} />
      <DesignResultSection
        evidence={PUBLISHED}
        isDesignCard
        gate={gate}
        canDecide
        subject={null}
        itemIdentifier="MOTIR-4321"
        routedToLabel={null}
        routedToViewer
      />
      <CoreFieldsPanel
        item={makeItem(serverStatus)}
        members={members}
        workflow={workflow}
        parent={null}
        reporterIsSelf
      />
    </OptimisticStatusProvider>
  );
}

/** The rail's Status field card. */
function railStatus(): HTMLElement {
  const chevron = screen.getByRole('button', { name: 'Edit Status' });
  const card = chevron.closest('[data-surface="card"]');
  if (!card) throw new Error('the Status field card did not render');
  return card as HTMLElement;
}

describe('the status rail repaints from a decision made in the overlay, before any server render', () => {
  it('APPROVING moves the rail to Done while the server render is still outstanding', () => {
    const gate = awaiting('gate-rail-approve');
    render(page('in_progress', gate));
    expect(railStatus().textContent).toContain('In Progress');

    // What the overlay does on a successful decide.
    act(() => announceGateDecided({ gate: decided(gate, 'approved', 'done'), filesKept: true }));

    // THE ASSERTION THIS SUITE EXISTS FOR. No fresh server prop has arrived, so
    // the only thing that can have moved the rail is the announced decision.
    expect(railStatus().textContent).toContain('Done');
    expect(railStatus().textContent).not.toContain('In Progress');
    // …and the section draws the decided record in the same render.
    expect(screen.getByText('Approved', { exact: true })).toBeTruthy();
  });

  it('REQUESTING CHANGES leaves the rail where it was — the decision moved nothing', () => {
    const gate = awaiting('gate-rail-changes');
    render(page('in_progress', gate));

    act(() =>
      announceGateDecided({ gate: decided(gate, 'changes_requested', null), filesKept: null }),
    );

    expect(railStatus().textContent).toContain('In Progress');
    expect(railStatus().textContent).not.toContain('Done');
    expect(screen.getByText('Changes requested', { exact: true })).toBeTruthy();
  });

  it('A SERVER RENDER THAT DISAGREES WINS — the optimistic value does not outlive it', () => {
    const gate = awaiting('gate-rail-disagree');
    const { rerender } = render(page('in_progress', gate));

    act(() => announceGateDecided({ gate: decided(gate, 'approved', 'done'), filesKept: true }));
    expect(railStatus().textContent).toContain('Done');

    // The refresh lands with a status that is NEITHER the pre-decision value
    // NOR the one the decision predicted — a sibling moved the card.
    rerender(page('in_review', decided(gate, 'approved', 'done')));

    expect(railStatus().textContent).toContain('In Review');
    expect(railStatus().textContent).not.toContain('Done');
  });

  it('NO ANNOUNCEMENT, NO MOVE — a refused decision is never announced, so nothing applies', () => {
    const gate = awaiting('gate-rail-refused');
    render(page('in_progress', gate));

    expect(railStatus().textContent).toContain('In Progress');
    // The band still invites; nothing on the page decided anything.
    expect(screen.getByRole('link', { name: 'Review & approve' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
