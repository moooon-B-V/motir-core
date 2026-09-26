// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { announceGateDecided } from '@/lib/approvals/decidedGates';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO, DesignGateSubjectDTO } from '@/lib/dto/designEvidence';

// THE GUARD FOR *THE RECORD BAND SAYS WHETHER THE FILES WERE KEPT WITHOUT A
// SERVER ROUND TRIP* (Bug MOTIR-5265), RE-HOMED ONTO THE PATH THE DECISION TAKES
// NOW (Story MOTIR-5215 · Subtask MOTIR-5229).
//
// The record band's `Files kept` line reads the section's `subject` prop — a
// server prop that arrives on the RSC apply MOTIR-5118 measured being
// intermittently lost. MOTIR-5265 gave it an in-browser route from the section's
// own decide response. The decision is now made in the approval OVERLAY, which
// announces the decided row AND the kind's files-kept answer
// (`lib/approvals/decidedGates.ts`, MOTIR-5570); the section draws that answer
// until the server's `subject` arrives, which then wins.
//
// "The refresh deferred" means what it means in
// `approval-gate-status-rail-optimistic.test.tsx`: no fresh server render with a
// `subject` arrives unless a case delivers one, which is the defect's own
// condition.
//
// ⚠️ PROVEN ABLE TO GO RED: with the section's `filesKept` reading only
// `subject` (`filesKept={subject ? subject.filesKept : null}`), test 1 fails on
// `Files kept` never appearing.
//
// The decided-gate store is module-level, as it is in the product, so every case
// uses its own gate id.

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/MOTIR-4321',
  useSearchParams: () => new URLSearchParams(),
}));

import { DesignResultSection } from '@/app/(authed)/items/[key]/_components/DesignResultSection';
import { OptimisticStatusProvider } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';

afterEach(cleanup);

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
    confirmedRecord: null,
    refusalVerdict: null,
    replanOwed: null,
    chosenOption: null,
    createdAt: '2026-09-08T04:00:00.000Z',
    updatedAt: '2026-09-08T04:00:00.000Z',
  };
}

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

/** A reachable note FILE is the smallest subject the port can SHOW (MOTIR-5498). */
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
        routedToViewer
      />
    </OptimisticStatusProvider>
  );
}

describe('the record band says whether the files were kept, from the overlay’s decision', () => {
  it('APPROVING with the pin written shows Files kept while the server render is outstanding', () => {
    const gate = awaiting('gate-kept-yes');
    render(section(gate, null));

    act(() => announceGateDecided({ gate: decided(gate, 'approved', 'done'), filesKept: true }));

    expect(screen.getByText('Files kept')).toBeTruthy();
    expect(screen.queryByText('Files not kept')).toBeNull();
  });

  it('APPROVING with the pin ABSENT says Files not kept — never an unconditional yes', () => {
    const gate = awaiting('gate-kept-no');
    render(section(gate, null));

    act(() => announceGateDecided({ gate: decided(gate, 'approved', 'done'), filesKept: false }));

    expect(screen.getByText('Files not kept')).toBeTruthy();
    expect(screen.queryByText('Files kept')).toBeNull();
  });

  it('REQUESTING CHANGES renders no files line at all', () => {
    const gate = awaiting('gate-kept-changes');
    render(section(gate, null));

    act(() =>
      announceGateDecided({ gate: decided(gate, 'changes_requested', null), filesKept: null }),
    );

    expect(screen.getByText('Changes requested', { exact: true })).toBeTruthy();
    expect(screen.queryByText('Files kept')).toBeNull();
    expect(screen.queryByText('Files not kept')).toBeNull();
  });

  it('A SERVER RENDER THAT DISAGREES WINS — the server subject replaces the announced value', () => {
    const gate = awaiting('gate-kept-disagree');
    const { rerender } = render(section(gate, null));

    act(() => announceGateDecided({ gate: decided(gate, 'approved', 'done'), filesKept: true }));
    expect(screen.getByText('Files kept')).toBeTruthy();

    rerender(section(decided(gate, 'approved', 'done'), { evidence: PUBLISHED, filesKept: false }));

    expect(screen.getByText('Files not kept')).toBeTruthy();
    expect(screen.queryByText('Files kept')).toBeNull();
  });

  it('no announcement applies nothing — the band still invites, and no files line exists', () => {
    render(section(awaiting('gate-kept-none'), null));

    expect(screen.getByRole('link', { name: 'Review & approve' })).toBeTruthy();
    expect(screen.queryByText('Files kept')).toBeNull();
    expect(screen.queryByText('Files not kept')).toBeNull();
  });
});
