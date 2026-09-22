// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import { AcceptanceDevelopmentSlot } from '@/components/acceptance/AcceptanceDevelopmentSlot';
import type { DevelopmentGateActions } from '@/components/github/DevelopmentGateFrame';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';

// THE STORY SAYS WHICH QUESTION (Story MOTIR-4949 · Subtask MOTIR-5790;
// `design/work-items/acceptance-panel--approve-and-merge.mock.html`, panels A–C).
//
// On a STORY RUN the story's pull requests are its own, so its acceptance question LEADS
// the Development block: the receipt is the subject, the pull requests and How to test
// sit beneath it, and ONE verb pair presses the ACCEPTANCE gate — whose press also merges
// (MOTIR-5789). The block is mounted whole; only the server actions are fakes.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const acc = en.approvalGate.acceptanceResult;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

const CORE_V = 'moooon/motir-core#131@3f2a91c0000000000000000000000000000000aa';
const GATEWAY_V = 'moooon/motir-gateway#57@aa11bb2000000000000000000000000000000000';
const SET_VERSION = [CORE_V, GATEWAY_V].sort().join(',');
const PAIR = fill(en.approvalGate.pullRequestApproval.list.pair, {
  a: 'moooon/motir-core · #131',
  b: 'moooon/motir-gateway · #57',
});

const ACCEPTANCE_AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-acceptance-1',
  kind: 'acceptance_result',
  subjectId: 'ae-1',
  subjectVersion: 'c0ffee1',
};
const ACCEPTANCE_APPROVED: ApprovalGateDTO = {
  ...ACCEPTANCE_AWAITING,
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-19T15:02:00.000Z',
};
const MERGE_AWAITING: ApprovalGateDTO = { ...AWAITING_MERGE_GATE, subjectVersion: SET_VERSION };

const RECEIPT: AcceptanceEvidenceDTO = {
  id: 'ae-1',
  workItemId: 'wi-acme-12',
  status: 'pending',
  videoUrl: 'https://blob.example/run.webm',
  mimeType: 'video/webm',
  sizeBytes: 1024,
  traceUrl: null,
  chapters: [{ label: 'Run the whole story', tSeconds: 14 }],
  commitSha: 'c0ffee1',
  ciRunUrl: null,
  producedByKey: 'ACME-24',
  approvedById: null,
  approvedAt: null,
  createdAt: '2026-09-19T14:40:00.000Z',
};

/** The two facts the slot takes — what its caller reads off the gate (MOTIR-5792). */
const acceptedOf = (gate: ApprovalGateDTO) =>
  gate.state === 'approved' ? { name: gate.decidedByLabel ?? '', at: gate.decidedAt ?? '' } : null;

function fakeActions() {
  return {
    decide: vi.fn(),
    approveAndMerge: vi.fn(async () => ({
      ok: true,
      gate: { ...ACCEPTANCE_APPROVED },
      members: [],
    })),
    retryMember: vi.fn(),
  } as unknown as DevelopmentGateActions & {
    decide: ReturnType<typeof vi.fn>;
    approveAndMerge: ReturnType<typeof vi.fn>;
  };
}

function storyRun(opts: {
  acceptance: ApprovalGateDTO;
  frameGate: ApprovalGateDTO;
  mergeAwaiting: boolean;
  actions?: DevelopmentGateActions;
}) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-20"
      manualLinkable
      howToTest={recordDto()}
      designResult={
        <AcceptanceDevelopmentSlot
          evidence={RECEIPT}
          accepted={acceptedOf(opts.acceptance)}
          mergeAwaiting={opts.mergeAwaiting}
        />
      }
      mergeGate={{
        gate: opts.frameGate,
        canDecide: true,
        routedToLabel: 'Ada L.',
        members: [],
        stamp: 'stamp-on-screen',
        mergeSubjectVersion: opts.frameGate.kind === 'acceptance_result' ? SET_VERSION : undefined,
      }}
      gateActions={opts.actions}
    />,
  );
}

describe('panel A — a story run, both questions awaiting (MOTIR-5790)', () => {
  it('renders ONE frame: the receipt in the port, the pull requests beneath, ONE verb pair named Approve and merge', () => {
    storyRun({
      acceptance: ACCEPTANCE_AWAITING,
      frameGate: ACCEPTANCE_AWAITING,
      mergeAwaiting: true,
      actions: fakeActions(),
    });
    // Band 1 names the ACCEPTANCE question, not the pull requests.
    expect(screen.getAllByText(acc.kindLabel).length).toBeGreaterThan(0);
    // The receipt is the subject.
    expect(screen.getByTestId('acceptance-development-slot')).toBeTruthy();
    expect(screen.getByText('Run the whole story')).toBeTruthy();
    // ONE pair of verbs.
    expect(
      screen.getAllByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: en.approvalGate.verb.requestChanges }),
    ).toHaveLength(1);
    // The consequence names what merges AND says the video is not merged.
    expect(
      screen.getByText(fill(acc.consequenceMerges, { key: 'ACME-20', prs: PAIR })),
    ).toBeTruthy();
  });

  it('the confirm step records, locks the recording, and merges — the video named as not part of it', () => {
    storyRun({
      acceptance: ACCEPTANCE_AWAITING,
      frameGate: ACCEPTANCE_AWAITING,
      mergeAwaiting: true,
      actions: fakeActions(),
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    );
    expect(screen.getByText(acc.confirm.records)).toBeTruthy();
    expect(screen.getByText(acc.confirm.freezes)).toBeTruthy();
    expect(screen.getByText(fill(acc.confirm.merges, { prs: PAIR }))).toBeTruthy();
  });

  it('pressing the primary presses the ACCEPTANCE gate through the one press — the component calls no merge of its own', async () => {
    const actions = fakeActions();
    storyRun({
      acceptance: ACCEPTANCE_AWAITING,
      frameGate: ACCEPTANCE_AWAITING,
      mergeAwaiting: true,
      actions,
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: fill(en.approvalGate.confirm.proceed, {
          verb: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
        }),
      }),
    );
    await waitFor(() => expect(actions.approveAndMerge).toHaveBeenCalledTimes(1));
    expect(actions.approveAndMerge).toHaveBeenCalledWith({
      gateId: 'gate-acceptance-1',
      identifier: 'ACME-20',
      stamp: 'stamp-on-screen',
    });
    expect(actions.decide).not.toHaveBeenCalled();
  });
});

describe('panels B and C — the acceptance decided, driven by the server gate', () => {
  it('B · approved before green: the slot says it is accepted and that the merge follows with no second press', () => {
    render(
      <AcceptanceDevelopmentSlot
        evidence={RECEIPT}
        accepted={acceptedOf(ACCEPTANCE_APPROVED)}
        mergeAwaiting={false}
      />,
    );
    expect(screen.getByText(/Acceptance approved by Ada L\./)).toBeTruthy();
    expect(screen.getByText(acc.mergeHeld)).toBeTruthy();
  });

  it('hands its sizing to the player — the overlay passes `viewport` so the recording fits its port (MOTIR-6042)', () => {
    const { container } = render(
      <AcceptanceDevelopmentSlot
        evidence={RECEIPT}
        accepted={null}
        mergeAwaiting={false}
        fit="viewport"
      />,
    );
    expect(container.querySelector('video')!.className).toContain('100dvh');
  });

  it('C · merge re-asked alone: the MERGE gate leads, and the slot says the video stands', () => {
    storyRun({
      acceptance: ACCEPTANCE_APPROVED,
      frameGate: MERGE_AWAITING,
      mergeAwaiting: true,
      actions: fakeActions(),
    });
    expect(screen.getByText(/the video stands/)).toBeTruthy();
    expect(screen.queryByText(acc.mergeHeld)).toBeNull();
    // Band 1 is the plain pull-request kind — the acceptance is a line, not a band.
    expect(
      screen.getAllByText(en.approvalGate.pullRequestApproval.kindLabel).length,
    ).toBeGreaterThan(0);
  });
});
