// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type {
  DevelopmentGateActions,
  DevelopmentGateRead,
} from '@/components/github/DevelopmentGateFrame';
import { OptimisticStatusProvider } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';
import type {
  ApprovalGateDTO,
  PullRequestApprovalMemberDTO,
  PullRequestQueueExitDTO,
} from '@/lib/dto/approvalGate';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';

// EVERY UN-LANDED CLASS, AS THE ROW DRAWS IT (Story MOTIR-5799 · MOTIR-5806;
// `design/github/design-notes.md` § 28, `approve-and-merge--ejected--reasked.mock.html`
// panels 1–4; `docs/decisions/approval-gates.md` § 4 FOURTH AMENDMENT, point 2).
//
// One approval authorizes ONE merge or enqueue action, and what the row offers after one
// that did not land is decided by the REASON's class:
//
//   · RETRYABLE — *Queue again* / *Retry merge*, and pressing it IS the new approval;
//   · BLOCKED BY A SETTING — *Retry merge*, with the setting NAMED;
//   · CAN'T LAND — no verb at all; `motir fix` is the way forward.
//
// The block is mounted whole from a fixture read, as `development-ejection` mounts it;
// only the server actions are fakes.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pra = en.approvalGate.pullRequestApproval;
const GATEWAY_SHA = 'aa11bb2000000000000000000000000000000000';
const CORE_SHA = '3f2a91c0000000000000000000000000000000aa';
const CORE_V = `moooon/motir-core#131@${CORE_SHA}`;
const GATEWAY_V = `moooon/motir-gateway#57@${GATEWAY_SHA}`;

/** The RE-ASKED gate: awaiting, over the same two commits — what the row's press decides. */
const REASKED: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  subjectVersion: [CORE_V, GATEWAY_V].sort().join(','),
  state: 'awaiting',
};
const STORY = recordDto();

function queueExit(over: Partial<PullRequestQueueExitDTO> = {}): PullRequestQueueExitDTO {
  return {
    rawReason: 'CI_FAILURE',
    disposition: 'failure',
    headSha: GATEWAY_SHA,
    exitedAt: '2026-09-19T15:00:00.000Z',
    requeuedAt: null,
    failingCheckName: 'CI complete',
    failingCheckUrl: 'https://github.com/moooon/motir-gateway/actions/runs/1/job/2',
    ...over,
  };
}

/** The core member merged; the gateway member as `over` says. */
function members(over: Partial<PullRequestApprovalMemberDTO>): PullRequestApprovalMemberDTO[] {
  return [
    {
      subjectVersion: CORE_V,
      pullRequestId: CORE_PR.id,
      queued: false,
      retryable: false,
      exit: null,
      exitAtApprovedHead: false,
      requeueable: false,
      refusal: null,
      retryDecidesGateId: REASKED.id,
    },
    {
      subjectVersion: GATEWAY_V,
      pullRequestId: GATEWAY_PR.id,
      queued: false,
      retryable: false,
      exit: null,
      exitAtApprovedHead: true,
      requeueable: false,
      refusal: null,
      retryDecidesGateId: REASKED.id,
      ...over,
    },
  ];
}

const repairOffer = (): WorkItemRepairViewDto => ({
  state: 'offer',
  command: 'motir fix ACME-12',
  failing: [
    {
      repo: 'moooon/motir-gateway',
      number: 57,
      url: 'https://github.com/moooon/motir-gateway/pull/57',
      ci: 'passing',
      failingChecks: [],
      queueExit: {
        rawReason: 'CI_FAILURE',
        exitedAt: '2026-09-19T15:00:00.000Z',
        headSha: GATEWAY_SHA,
        failingCheckName: 'CI complete',
        failingCheckUrl: 'https://github.com/moooon/motir-gateway/actions/runs/1/job/2',
      },
    },
  ],
  runTargetKey: null,
  attempts: null,
  startedAt: null,
  holder: null,
});

function fakeActions(retryMember: ReturnType<typeof vi.fn> = vi.fn()) {
  return {
    decide: vi.fn(),
    approveAndMerge: vi.fn(),
    retryMember,
  } as unknown as DevelopmentGateActions;
}

function renderBlock(
  read: Partial<DevelopmentGateRead>,
  opts: { repair?: WorkItemRepairViewDto | null; status?: string } = {},
  actions: DevelopmentGateActions = fakeActions(),
) {
  return render(
    <OptimisticStatusProvider serverStatus={opts.status ?? 'in_review'}>
      <DevelopmentSectionBody
        pullRequests={[{ ...CORE_PR, state: 'merged' }, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        manualLinkable
        howToTest={STORY}
        repair={opts.repair ?? null}
        mergeGate={{
          gate: REASKED,
          canDecide: true,
          routedToLabel: null,
          stamp: 'v1.stamp-on-screen',
          ...read,
        }}
        gateActions={actions}
      />
    </OptimisticStatusProvider>,
  );
}

const gatewayRow = () => screen.getByText(GATEWAY_PR.title).closest('li')!;
const rowButton = (name: string) => within(gatewayRow()).queryByRole('button', { name });
const fixPart = () => screen.getByRole('group', { name: en.github.development.fix.aria.part });

describe('the row draws the class, and offers only what that class allows', () => {
  it('RETRYABLE, a queue failure: Left the queue, Queue again, and `motir fix` beside it', () => {
    renderBlock(
      { members: members({ exit: queueExit(), requeueable: true }) },
      { repair: repairOffer() },
    );

    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(rowButton(pra.outcome.queueAgain)).toBeTruthy();
    expect(fixPart().textContent).toContain('motir fix ACME-12');
  });

  it('RETRYABLE, a neutral removal: the same verb, and NO `motir fix` — no code change is implied', () => {
    renderBlock(
      {
        members: members({
          exit: queueExit({
            rawReason: 'MANUAL',
            disposition: 'neutral',
            failingCheckName: null,
            failingCheckUrl: null,
          }),
          requeueable: true,
        }),
      },
      // The claim refuses a neutral removal (`repair_not_code`, MOTIR-5803), so the page
      // is handed no repair view at all.
      { repair: null },
    );

    expect(within(gatewayRow()).getByText(pra.outcome.removedFromQueue)).toBeTruthy();
    expect(rowButton(pra.outcome.queueAgain)).toBeTruthy();
    expect(screen.queryByText(/motir fix ACME-12/)).toBeNull();
  });

  it('CAN’T LAND, a conflict: no verb at all, the cannot-merge pill, and `motir fix` alone', () => {
    renderBlock(
      {
        members: members({
          exit: queueExit({
            rawReason: 'MERGE_CONFLICT',
            failingCheckName: null,
            failingCheckUrl: null,
          }),
        }),
      },
      { repair: repairOffer(), status: 'implemented' },
    );

    expect(within(gatewayRow()).getByText(pra.outcome.cannotLandConflict)).toBeTruthy();
    expect(rowButton(pra.outcome.queueAgain)).toBeNull();
    expect(rowButton(pra.outcome.retry)).toBeNull();
    expect(fixPart().textContent).toContain('motir fix ACME-12');
  });

  it('CAN’T LAND, a host refusal on red checks: the same shape, worded for the checks', () => {
    renderBlock({
      members: members({
        refusal: {
          code: 'checks_not_green',
          landingClass: 'cant_land',
          refusedAt: '2026-09-19T15:10:00.000Z',
          permission: null,
        },
      }),
    });

    expect(within(gatewayRow()).getByText(pra.outcome.cannotLandChecks)).toBeTruthy();
    expect(rowButton(pra.outcome.retry)).toBeNull();
  });

  it('BLOCKED BY A SETTING: the setting is NAMED and Retry merge is offered', () => {
    renderBlock({
      members: members({
        requeueable: true,
        refusal: {
          code: 'app_permission_missing',
          landingClass: 'setting',
          refusedAt: '2026-09-19T15:10:00.000Z',
          permission: 'contents: write',
        },
      }),
    });

    expect(
      within(gatewayRow()).getByText(
        pra.outcome.settingNamed.replace('{setting}', 'contents: write'),
      ),
    ).toBeTruthy();
    expect(rowButton(pra.outcome.retry)).toBeTruthy();
  });

  it('BLOCKED BY A SETTING with no permission named: the general sentence, and still the verb', () => {
    renderBlock({
      members: members({
        requeueable: true,
        refusal: {
          code: 'branch_protected',
          landingClass: 'setting',
          refusedAt: '2026-09-19T15:10:00.000Z',
          permission: null,
        },
      }),
    });

    expect(within(gatewayRow()).getByText(pra.outcome.setting)).toBeTruthy();
    expect(rowButton(pra.outcome.retry)).toBeTruthy();
  });

  it('the row’s press DECIDES the re-asked gate — the gate it was handed, with this read’s stamp', () => {
    const retryMember = vi.fn().mockResolvedValue({ ok: true, member: { outcome: 'enqueued' } });
    renderBlock(
      { members: members({ exit: queueExit(), requeueable: true }) },
      {},
      fakeActions(retryMember),
    );

    fireEvent.click(rowButton(pra.outcome.queueAgain)!);

    expect(retryMember).toHaveBeenCalledWith({
      approvalGateId: REASKED.id,
      pullRequestId: GATEWAY_PR.id,
      identifier: 'ACME-12',
      stamp: 'v1.stamp-on-screen',
    });
  });
});
