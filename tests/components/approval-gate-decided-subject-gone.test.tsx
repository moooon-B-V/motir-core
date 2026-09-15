// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import {
  useReportPortRenderStatus,
  type PortRenderStatus,
} from '@/components/approvals/portRenderStatus';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// A DECIDED GATE WHOSE SUBJECT BYTES ARE GONE (Bug MOTIR-5551), beside
// `approval-gate-decided-withdrawn.test.tsx`, which pins `E` and `G` over a
// subject that is still there.
//
// State `X`'s alert — *"You cannot approve what cannot be shown. Retry above, or
// ask the agent to republish."* — means exactly one thing: THE VERBS ARE
// WITHHELD because the subject did not render. A decided frame has no verbs to
// withhold, so the alert under its record told a reader they could not approve
// something that had already been approved or sent back, and asked them to
// retry. `design/work-items/approval-cta.mock.html` panel 3 draws `F` without it.
//
// ⚠️ THE SHAPE IS ORDINARY, NOT CONTRIVED. Only an approval pins its files
// (ADR §6c), so a version that was sent back loses its bytes on the seven-day
// orphan sweep and `subject.evidence` is null from then on; an approval whose
// pin did not land reaches the same shape. `DesignResultPanel` then renders its
// own empty state and — correctly, for an AWAITING gate — reports `failed`.
//
// Two layers, because the defect lives in the frame and was SEEN through the
// section: the frame suite drives the port report directly, so it cannot pass by
// accident of what the panel happens to report; the section suite mounts the
// real `DesignResultPanel` the reporter saw, so it pins the page as rendered.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));

vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

import { DesignResultSection } from '@/app/(authed)/items/[key]/_components/DesignResultSection';
import { OptimisticStatusProvider } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';

const DECIDED: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'changes_requested',
  decidedById: 'user-1',
  decidedAt: '2026-09-08T04:12:00.000Z',
  noteMd: null,
  subjectVersion: '9840d00ea1b2c3d4',
  decidedByLabel: 'Ada Lovelace',
  routedToId: 'user-1',
  decidedUnderAuthority: 'assignee',
  decisionSource: 'ui',
  outcomeRef: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:12:00.000Z',
};

const DECIDED_STATES = [
  { state: 'approved', outcomeRef: 'done', label: 'Approved' },
  { state: 'changes_requested', outcomeRef: null, label: 'Changes requested' },
] as const;

const VERBS: GateVerb[] = [
  { decision: 'request_changes', label: 'Request changes', variant: 'secondary', confirms: false },
  { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
];

/** A port that declares its render status — the shape `DesignResultPanel` has. */
function ReportingPort({ status }: { status: PortRenderStatus }) {
  useReportPortRenderStatus(status);
  return <div data-testid="the-port">the panel&apos;s own empty state</div>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each(DECIDED_STATES)('a DECIDED frame ($state) over a port that FAILED', (decided) => {
  const gate: ApprovalGateDTO = {
    ...DECIDED,
    state: decided.state,
    outcomeRef: decided.outcomeRef,
  };

  function renderFrame() {
    return renderWithIntl(
      <ApprovalGateControl
        gate={gate}
        canDecide
        kindLabel="Design result"
        subjectMeta="version 9840d00e"
        port={<ReportingPort status="failed" />}
        verbs={VERBS}
        consequence="Approving moves MOTIR-4321 to Done."
        confirmConsequences={['records it']}
        filesKept={false}
        onDecide={async () => null}
      />,
    );
  }

  it('renders NO `X` alert — there are no verbs to withhold', () => {
    const { container } = renderFrame();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.textContent).not.toContain('You cannot approve what cannot be shown.');
    expect(container.textContent).not.toContain('Retry above, or ask the agent to republish.');
  });

  it('keeps the record and the port, and still carries no verbs', () => {
    const { container } = renderFrame();
    expect(screen.getByText(decided.label)).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(container.textContent).toContain('version 9840d00e');
    expect(screen.getByTestId('the-port')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe.each(DECIDED_STATES)(
  'the item page: DesignResultSection, $state, subject bytes gone',
  (decided) => {
    it('shows the record and the panel empty state, with no `X` alert', () => {
      const { container } = renderWithIntl(
        <OptimisticStatusProvider serverStatus="in_review">
          <DesignResultSection
            evidence={null}
            isDesignCard
            gate={{ ...DECIDED, state: decided.state, outcomeRef: decided.outcomeRef }}
            canDecide
            subject={{ evidence: null, filesKept: false }}
            itemIdentifier="MOTIR-4321"
            routedToLabel={null}
          />
        </OptimisticStatusProvider>,
      );

      expect(screen.queryByRole('alert')).toBeNull();
      expect(container.textContent).not.toContain('You cannot approve what cannot be shown.');
      // The record strip, and the panel's own nothing-published state in the port.
      expect(screen.getByText('Ada Lovelace')).toBeTruthy();
      expect(container.textContent).toContain('version 9840d00e');
      expect(container.textContent).toContain('No design result published yet');
    });
  },
);
