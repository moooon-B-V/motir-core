// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO, DesignGateSubjectDTO } from '@/lib/dto/designEvidence';

// THE GUARD FOR *THE RECORD BAND SAYS WHETHER THE FILES WERE KEPT WITHOUT A
// SERVER ROUND TRIP* (Bug MOTIR-5265).
//
// The record band's `Files kept` line used to read ONLY `DesignResultSection`'s
// `subject` prop — a server prop that arrives on the RSC apply MOTIR-5118
// measured being intermittently lost. MOTIR-5212 gave the status rail a second,
// in-browser route; this line had none, so `approval-gate-repaint.spec.ts:136`
// and `design-approval.spec.ts` failed whenever the apply was dropped.
//
// "The refresh deferred" means what it means in
// `approval-gate-status-rail-optimistic.test.tsx`: no fresh server render with a
// `subject` ever arrives in this suite, which is the defect's own condition.
//
// ⚠️ PROVEN ABLE TO GO RED: against the unmodified `DesignResultSection.tsx`
// (`filesKept={subject ? subject.filesKept : null}`), test 1 fails on
// `Files kept` never appearing. The failure is quoted in the pull request.

const { decideSpy, refreshSpy } = vi.hoisted(() => ({ decideSpy: vi.fn(), refreshSpy: vi.fn() }));

vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction: decideSpy,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

import { DesignResultSection } from '@/app/(authed)/items/[key]/_components/DesignResultSection';
import { OptimisticStatusProvider } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

const decided = (state: ApprovalGateDTO['state'], outcomeRef: string | null): ApprovalGateDTO => ({
  ...AWAITING,
  state,
  decidedById: 'u_reviewer',
  decidedAt: '2026-09-08T05:00:00.000Z',
  decidedByLabel: 'Ada Lovelace',
  decidedUnderAuthority: 'reporter',
  decisionSource: 'ui',
  outcomeRef,
});

/** A note is the smallest subject the port can SHOW, so the verbs render. */
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

function section(gate: ApprovalGateDTO, subject: DesignGateSubjectDTO | null) {
  return (
    <OptimisticStatusProvider serverStatus="in_progress">
      <DesignResultSection
        evidence={PUBLISHED}
        isDesignCard
        gate={gate}
        canDecide
        subject={subject}
        itemIdentifier="MOTIR-4321"
        routedToLabel={null}
      />
    </OptimisticStatusProvider>
  );
}

async function approve(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByText('Approving this will:');
  fireEvent.click(screen.getByRole('button', { name: 'Yes, Approve' }));
}

describe('the record band says whether the files were kept, from the decide response', () => {
  it('APPROVING with the pin written shows Files kept while the refresh is still outstanding', async () => {
    decideSpy.mockResolvedValue({ ok: true, gate: decided('approved', 'done'), filesKept: true });
    render(section(AWAITING, null));

    await approve();

    await waitFor(() => expect(screen.getByText('Files kept')).toBeTruthy());
    expect(screen.queryByText('Files not kept')).toBeNull();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('APPROVING with the pin ABSENT says Files not kept — never an unconditional yes', async () => {
    // The republish-took-the-row case `DesignGateSubjectDTO.filesKept` names:
    // the decision stands and its bytes were not the ones pinned.
    decideSpy.mockResolvedValue({ ok: true, gate: decided('approved', 'done'), filesKept: false });
    render(section(AWAITING, null));

    await approve();

    await waitFor(() => expect(screen.getByText('Files not kept')).toBeTruthy());
    expect(screen.queryByText('Files kept')).toBeNull();
  });

  it('REQUESTING CHANGES renders no files line at all', async () => {
    decideSpy.mockResolvedValue({
      ok: true,
      gate: decided('changes_requested', null),
      filesKept: null,
    });
    render(section(AWAITING, null));

    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));

    await waitFor(() => expect(decideSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Approving this will:')).toBeNull());
    expect(screen.queryByText('Files kept')).toBeNull();
    expect(screen.queryByText('Files not kept')).toBeNull();
  });

  it('A SERVER RENDER THAT DISAGREES WINS — the server subject replaces the response value', async () => {
    decideSpy.mockResolvedValue({ ok: true, gate: decided('approved', 'done'), filesKept: true });
    const { rerender } = render(section(AWAITING, null));

    await approve();
    await waitFor(() => expect(screen.getByText('Files kept')).toBeTruthy());

    rerender(section(decided('approved', 'done'), { evidence: PUBLISHED, filesKept: false }));

    await waitFor(() => expect(screen.getByText('Files not kept')).toBeTruthy());
    expect(screen.queryByText('Files kept')).toBeNull();
  });

  it('a refusal applies nothing', async () => {
    decideSpy.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_NOT_AUTHORISED', decidedByLabel: null },
    });
    render(section(AWAITING, null));

    await approve();

    await waitFor(() => expect(decideSpy).toHaveBeenCalled());
    expect(screen.queryByText('Files kept')).toBeNull();
    expect(screen.queryByText('Files not kept')).toBeNull();
  });
});
