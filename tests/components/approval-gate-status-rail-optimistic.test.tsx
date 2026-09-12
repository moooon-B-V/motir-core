// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// THE GUARD FOR *THE STATUS RAIL MOVES WITHOUT A SERVER ROUND TRIP* (Bug
// MOTIR-5212).
//
// ⚠️ WHY IT MOUNTS THE REAL RAIL AND NOT A STAND-IN. The defect is a missing
// CHANNEL between two sibling islands: `DesignResultSection` takes the decision
// and `CoreFieldsPanel` draws the status, and nothing joined them. A test that
// drove the writer against a one-line fake reader would assert the provider
// works and say nothing at all about whether the rail is wired to it — the
// *green suite that mocks the seam* shape, where the mocked layer is the layer
// that broke. So both real components mount, inside the real provider, and the
// assertion reads the rail's own pill.
//
// ⚠️ WHAT "THE REFRESH DEFERRED" MEANS HERE, PRECISELY. `router.refresh()` is a
// void call; what a run is waiting for is the RSC APPLY it triggers — a fresh
// server render arriving with a new `status` prop. This suite never delivers
// one. That is not a convenience: it is the exact condition MOTIR-5118 measured
// in production, where the refresh returned 200 in 113 ms and the rail kept its
// pre-decision value for twenty seconds because the apply was lost. A run in
// which the apply never arrives is therefore the DEFECT's own conditions, and a
// rail that reads `Done` under them is the property this card ships.
//
// ⚠️ AND IT IS PROVEN ABLE TO GO RED. Against unmodified
// `DesignResultSection.tsx` — the single `applyOptimisticStatus(...)` line
// removed, everything else including the provider left in place — test 1 fails
// on the rail still reading `In Progress`. The failure is quoted in the pull
// request body. A guard for an intermittent defect that has never been shown
// failing is a tautology, not evidence.
//
// ⚠️ NOTHING HERE REPLACES `tests/e2e/approval-gate-repaint.spec.ts`, WHICH THIS
// CARD LEAVES BYTE-IDENTICAL. That spec is the detector the defect was found
// by, and it asserts something this lane structurally cannot: that a REAL
// browser, on a page nobody reloaded, against a REAL decide transaction, shows
// the moved rail. This suite pins the mechanism; that one pins the outcome.

const { decideSpy, refreshSpy, toastSpy } = vi.hoisted(() => ({
  decideSpy: vi.fn(),
  refreshSpy: vi.fn(),
  toastSpy: vi.fn(),
}));

vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction: decideSpy,
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

import { CoreFieldsPanel } from '@/app/(authed)/items/[key]/_components/CoreFieldsPanel';
import { DesignResultSection } from '@/app/(authed)/items/[key]/_components/DesignResultSection';
import { OptimisticStatusProvider } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

const AWAITING: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi_1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  subjectVersion: '9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'u_reviewer',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

/**
 * The gate row a decide response returns.
 *
 * `outcomeRef` is the load-bearing field and it is the SERVER's own record of
 * the status its transaction wrote (`approvalGatesService.decide` sets it from
 * `effect.statusWritten`). A decision that moved nothing carries `null` there —
 * which is what every `request_changes` returns, by way of the handler's
 * `request_changes_moves_nothing` arm.
 */
function decided(state: ApprovalGateDTO['state'], outcomeRef: string | null): ApprovalGateDTO {
  return {
    ...AWAITING,
    state,
    decidedById: 'u_reviewer',
    decidedAt: '2026-09-08T05:00:00.000Z',
    decidedByLabel: 'Ada Lovelace',
    decidedUnderAuthority: 'reporter',
    decisionSource: 'ui',
    outcomeRef,
  };
}

/**
 * A published design the port can actually SHOW.
 *
 * ⚠️ IT IS NOT DECORATION, AND `evidence: null` DOES NOT WORK HERE — which the
 * first run of this suite found, before the code was even in question. The
 * frame withholds its verbs when the port reports it has nothing to display
 * (state `X`, *"You cannot approve what cannot be shown"*), and
 * `DesignResultPanel` reports `failed` unless the row carries a note or an
 * asset with a URL. A fixture with no subject therefore renders a frame with no
 * Approve button, and every test below fails on the button rather than on the
 * rail — a green-looking red that says nothing about this card.
 *
 * A NOTE and no assets is the smallest thing that satisfies it: it makes
 * `hasSubject` true without mounting a `MockFrame`, whose own sandboxed fetch
 * would report `rendering` and withhold the verbs for a second reason.
 */
const PUBLISHED: DesignEvidenceDTO = {
  id: 'ev-1',
  workItemId: 'wi_1',
  noteMd: '## The approvals room\n\nProse the reviewer reads.',
  noteTruncated: false,
  assets: [],
  commitSha: 'cafe1234567',
  ciRunUrl: null,
  producedByKey: 'MOTIR-4320',
  createdAt: '2026-09-08T03:00:00.000Z',
  withdrawnAt: null,
  withdrawnById: null,
  withdrawnReason: null,
};

/** The page, reduced to the two islands the channel joins plus the provider
 *  between them — the same nesting `items/[key]/page.tsx` mounts. */
function renderPage(serverStatus: string) {
  return render(
    <OptimisticStatusProvider serverStatus={serverStatus}>
      <DesignResultSection
        evidence={PUBLISHED}
        isDesignCard
        gate={AWAITING}
        canDecide
        subject={null}
        itemIdentifier="MOTIR-4321"
        routedToLabel={null}
      />
      <CoreFieldsPanel
        item={makeItem(serverStatus)}
        members={members}
        workflow={workflow}
        parent={null}
        reporterIsSelf
      />
    </OptimisticStatusProvider>,
  );
}

/** The rail's Status field card — scoped past the gate frame's own copy, the
 *  same way `approval-gate-repaint.spec.ts` scopes its browser locator. */
function railStatus(): HTMLElement {
  const chevron = screen.getByRole('button', { name: 'Edit Status' });
  const card = chevron.closest('[data-surface="card"]');
  if (!card) throw new Error('the Status field card did not render');
  return card as HTMLElement;
}

/** Press Approve and confirm it — the verb is terminal, so it confirms. */
async function approve(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByText('Approving this will:');
  fireEvent.click(screen.getByRole('button', { name: 'Yes, Approve' }));
}

describe('the status rail repaints from the decide response, before any server render', () => {
  it('APPROVING moves the rail to Done while the refresh is still outstanding', async () => {
    decideSpy.mockResolvedValue({ ok: true, gate: decided('approved', 'done') });
    renderPage('in_progress');

    expect(railStatus().textContent).toContain('In Progress');

    await approve();

    // THE ASSERTION THIS CARD EXISTS FOR. No fresh server prop has arrived and
    // none will in this suite, so the only thing that can have moved the rail
    // is the value the decide response carried.
    await waitFor(() => expect(railStatus().textContent).toContain('Done'));
    expect(railStatus().textContent).not.toContain('In Progress');

    // The server half is untouched: the refresh still fires (MOTIR-5118's
    // measurement stands, and it is what reaches the surfaces with no in-browser
    // path — the record band's `Files kept` line among them).
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('REQUESTING CHANGES leaves the rail where it was — the response moved nothing', async () => {
    // The handler's `request_changes_moves_nothing` arm sets `statusWritten:
    // null`, so the gate comes back with a null `outcomeRef`. The rail holding
    // still is therefore a consequence of the server's own record rather than
    // of a branch in the client that could drift from the handler.
    decideSpy.mockResolvedValue({ ok: true, gate: decided('changes_requested', null) });
    renderPage('in_progress');

    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));

    await waitFor(() => expect(decideSpy).toHaveBeenCalled());
    expect(railStatus().textContent).toContain('In Progress');
    expect(railStatus().textContent).not.toContain('Done');
  });

  it('A SERVER RENDER THAT DISAGREES WINS — the optimistic value does not outlive it', async () => {
    decideSpy.mockResolvedValue({ ok: true, gate: decided('approved', 'done') });
    const { rerender } = renderPage('in_progress');

    await approve();
    await waitFor(() => expect(railStatus().textContent).toContain('Done'));

    // The refresh lands, and it carries a status that is NEITHER the
    // pre-decision value NOR the one the response predicted — a sibling moved
    // the card, a cascade re-opened it, an admin edited it. The reconcile has
    // one job here and it is to lose gracefully.
    rerender(
      <OptimisticStatusProvider serverStatus="in_review">
        <DesignResultSection
          evidence={PUBLISHED}
          isDesignCard
          gate={decided('approved', 'done')}
          canDecide
          subject={null}
          itemIdentifier="MOTIR-4321"
          routedToLabel={null}
        />
        <CoreFieldsPanel
          item={makeItem('in_review')}
          members={members}
          workflow={workflow}
          parent={null}
          reporterIsSelf
        />
      </OptimisticStatusProvider>,
    );

    expect(railStatus().textContent).toContain('In Review');
    expect(railStatus().textContent).not.toContain('Done');
  });

  it('A REFUSAL MOVES NOTHING — there is no value to apply and none is applied', async () => {
    decideSpy.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_NOT_AUTHORISED', decidedByLabel: null },
    });
    renderPage('in_progress');

    await approve();

    await waitFor(() => expect(decideSpy).toHaveBeenCalled());
    // The rollback, and it is structural: the optimistic status is read OFF the
    // response, so a response that refused carries nothing to apply. There is
    // no override to retract and no window in which one existed.
    expect(railStatus().textContent).toContain('In Progress');
    expect(railStatus().textContent).not.toContain('Done');
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
