// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type {
  DevelopmentGateActions,
  DevelopmentGateRead,
} from '@/components/github/DevelopmentGateFrame';
import { announceGateDecided } from '@/lib/approvals/decidedGates';
import type {
  ApprovalGateDTO,
  PullRequestApprovalMemberDTO,
  PullRequestQueueExitDTO,
} from '@/lib/dto/approvalGate';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';

// THE ITEM PAGE'S DEVELOPMENT SECTION HANDS THE DECISION OVER (Bug MOTIR-6323;
// `design/work-items/design-notes.md` § *The item page HANDS THE DECISION OVER*, planning
// flag 2).
//
// The block is mounted whole, as the item page mounts it: `handOver` set and ONLY
// `retryMember` among the actions — the page holds neither decision door. The approval
// overlay's own half (every verb, the confirm step, the press's outcomes) is
// `development-gate-verbs.test.tsx`'s, which mounts the frame with all three actions.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
  usePathname: () => '/items/ACME-12',
  useSearchParams: () => new URLSearchParams('tab=activity'),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pra = en.approvalGate.pullRequestApproval;

const CORE_SHA = '3f2a91c0000000000000000000000000000000aa';
const GATEWAY_SHA = 'aa11bb2000000000000000000000000000000000';
const CORE_V = `moooon/motir-core#131@${CORE_SHA}`;
const GATEWAY_V = `moooon/motir-gateway#57@${GATEWAY_SHA}`;

// A gate id of this file's own: the decided-gate store is module state and lives for the
// test file, so a shared fixture id would carry an announcement into the next test.
let gateSeq = 0;
const awaiting = (): ApprovalGateDTO => ({
  ...AWAITING_MERGE_GATE,
  id: `gate-hands-over-${++gateSeq}`,
  subjectVersion: [CORE_V, GATEWAY_V].sort().join(','),
});
const approvedFrom = (gate: ApprovalGateDTO): ApprovalGateDTO => ({
  ...gate,
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-15T14:22:00.000Z',
  outcomeRef: 'approved',
});

function exit(): PullRequestQueueExitDTO {
  return {
    rawReason: 'CI_FAILURE',
    disposition: 'failure',
    headSha: GATEWAY_SHA,
    exitedAt: '2026-09-15T15:00:00.000Z',
    requeuedAt: null,
    failingCheckName: 'CI complete',
    failingCheckUrl: 'https://github.com/moooon/motir-gateway/actions/runs/1/job/2',
  };
}

/** The core member clean; the gateway member as `over` says. */
function members(over: Partial<PullRequestApprovalMemberDTO>): PullRequestApprovalMemberDTO[] {
  const base: PullRequestApprovalMemberDTO = {
    subjectVersion: CORE_V,
    pullRequestId: CORE_PR.id,
    queued: false,
    retryable: false,
    exit: null,
    exitAtApprovedHead: false,
    requeueable: false,
    refusal: null,
    retryDecidesGateId: null,
  };
  return [base, { ...base, subjectVersion: GATEWAY_V, pullRequestId: GATEWAY_PR.id, ...over }];
}

/** What the item page hands the frame: `retryMember` alone. */
const pageActions = (retryMember = vi.fn()) =>
  ({ retryMember }) as unknown as DevelopmentGateActions;

function renderPage(
  read: Partial<DevelopmentGateRead> & { gate: ApprovalGateDTO },
  { routedToViewer = true, actions = pageActions() } = {},
) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-12"
      manualLinkable
      howToTest={recordDto()}
      mergeGate={{
        canDecide: true,
        routedToLabel: 'Mara S.',
        members: [],
        stamp: 'v1.stamp-on-screen',
        ...read,
      }}
      gateActions={actions}
      handOver={{ routedToViewer }}
    />,
  );
}

const door = () =>
  screen.queryByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove });
const anyVerb = () =>
  screen.queryByRole('button', { name: pra.verb.approveAndMerge }) ??
  screen.queryByRole('button', { name: en.approvalGate.verb.requestChanges });
const rowOf = (title: string) => screen.getByText(title).closest('li')!;

describe('an awaiting question this reader may decide', () => {
  it('draws the block and ONE door into the overlay — no frame, no verb', () => {
    renderPage({ gate: awaiting() });

    expect(anyVerb()).toBeNull();
    expect(screen.queryByRole('group', { name: en.approvalGate.port.label })).toBeNull();
    // The block itself is unchanged: both rows and How to test are on the page.
    expect(screen.getByText(CORE_PR.title)).toBeTruthy();
    expect(screen.getByText(GATEWAY_PR.title)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'How to test' })).toBeTruthy();
    // The band: the question, in the pull requests' own words, and the door.
    expect(screen.getByText(pra.cta.body)).toBeTruthy();
    expect(screen.getByText(en.approvalGate.state.awaitingYou)).toBeTruthy();
    const href = door()!.getAttribute('href')!;
    const query = new URL(href, 'https://motir.test').searchParams;
    expect(query.get('tab')).toBe('activity');
    expect([...query.values()]).toEqual(
      expect.arrayContaining(['ACME-12', 'pull_request_approval']),
    );
  });

  it('names the person it is routed to when that is somebody else', () => {
    renderPage({ gate: awaiting() }, { routedToViewer: false });
    expect(screen.getByText('Mara S.')).toBeTruthy();
    expect(door()).toBeTruthy();
  });

  it('opens the overlay on the LEADING kind, and says so in the band', () => {
    renderPage({ gate: { ...awaiting(), kind: 'design_result' } });
    expect(screen.getByText(pra.cta.bodyDesign)).toBeTruthy();
    expect(door()!.getAttribute('href')).toContain('design_result');
  });

  it('a RE-ASKED question keeps the row’s *Left the queue* and offers no Queue again — that press is an approval', () => {
    renderPage({
      gate: awaiting(),
      members: members({ exit: exit(), exitAtApprovedHead: true, requeueable: true }),
    });
    const gateway = rowOf(GATEWAY_PR.title);
    expect(within(gateway).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(within(gateway).queryByRole('button', { name: pra.outcome.queueAgain })).toBeNull();
    expect(door()).toBeTruthy();
  });

  it('gives way the moment the overlay announces its decision — no door over a decided question', async () => {
    const gate = awaiting();
    renderPage({ gate });
    expect(door()).toBeTruthy();

    act(() => announceGateDecided({ gate: approvedFrom(gate), filesKept: null }));

    await waitFor(() => expect(door()).toBeNull());
    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
    expect(anyVerb()).toBeNull();
  });
});

describe('every other state keeps the frame, with no decision verb', () => {
  it('a reader who may only look: state B, waiting on the person named', () => {
    renderPage({ gate: awaiting(), canDecide: false });
    expect(door()).toBeNull();
    expect(anyVerb()).toBeNull();
    expect(screen.getByRole('group', { name: en.approvalGate.port.label })).toBeTruthy();
    expect(screen.getByText(/Mara S\./)).toBeTruthy();
  });

  it('an APPROVED gate keeps *Retry merge* — it carries out the decision already made', async () => {
    const retryMember = vi.fn().mockResolvedValue({
      ok: true,
      member: {
        subjectVersion: GATEWAY_V,
        pullRequestId: GATEWAY_PR.id,
        outcome: 'merged',
      },
    });
    const gate = approvedFrom(awaiting());
    renderPage(
      { gate, members: members({ retryable: true }) },
      { actions: pageActions(retryMember) },
    );
    expect(door()).toBeNull();
    expect(anyVerb()).toBeNull();

    fireEvent.click(
      within(rowOf(GATEWAY_PR.title)).getByRole('button', { name: pra.outcome.retry }),
    );
    await waitFor(() => expect(retryMember).toHaveBeenCalledTimes(1));
    expect(retryMember).toHaveBeenCalledWith(
      expect.objectContaining({ approvalGateId: gate.id, pullRequestId: GATEWAY_PR.id }),
    );
  });
});
