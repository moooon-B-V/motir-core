// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type {
  DevelopmentGateActions,
  DevelopmentGateRead,
} from '@/components/github/DevelopmentGateFrame';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import {
  AWAITING_MERGE_GATE,
  CORE_PR,
  GATEWAY_PR,
  coreRepo,
  gatewayRepo,
  recordDto,
} from '../helpers/howToTestFixtures';

// THE DEVELOPMENT FRAME GETS ITS VERBS (Story MOTIR-4909 · Subtask MOTIR-5484;
// `design/github/design-notes.md` §20 *The verbs and their states*, Panels 12p–12w).
//
// The block is mounted whole — the real rows, the real How to test, the real frame — and only
// the SERVER ACTIONS are fakes, handed in as the item page hands the real ones. Every state
// the card names is driven here: at rest, confirm, the press's merged / queued / refused
// outcomes, Retry on one row, the reload that has lost the refusal's reason, a bystander, and
// a withdrawal by a push.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pra = en.approvalGate.pullRequestApproval;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

const CORE_SHA = '3f2a91c0000000000000000000000000000000aa';
const GATEWAY_SHA = 'aa11bb2000000000000000000000000000000000';
const CORE_V = `moooon/motir-core#131@${CORE_SHA}`;
const GATEWAY_V = `moooon/motir-gateway#57@${GATEWAY_SHA}`;
const CORE_NAME = 'moooon/motir-core · #131';
const GATEWAY_NAME = 'moooon/motir-gateway · #57';

const AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  subjectVersion: [CORE_V, GATEWAY_V].sort().join(','),
};
const APPROVED: ApprovalGateDTO = {
  ...AWAITING,
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-15T14:22:00.000Z',
  outcomeRef: 'approved',
};
const TWO_REPO_STORY = recordDto({ repos: [coreRepo(), gatewayRepo()] });

function fakeActions(overrides: Partial<Record<keyof DevelopmentGateActions, unknown>> = {}) {
  return {
    decide: vi.fn(),
    approveAndMerge: vi.fn(),
    retryMember: vi.fn(),
    ...overrides,
  } as unknown as DevelopmentGateActions & {
    decide: ReturnType<typeof vi.fn>;
    approveAndMerge: ReturnType<typeof vi.fn>;
    retryMember: ReturnType<typeof vi.fn>;
  };
}

function renderFrame(
  read: Partial<DevelopmentGateRead> & { gate: ApprovalGateDTO },
  actions?: DevelopmentGateActions,
) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-12"
      manualLinkable
      howToTest={TWO_REPO_STORY}
      mergeGate={{ canDecide: true, routedToLabel: 'Mara S.', members: [], ...read }}
      gateActions={actions}
    />,
  );
}

const rowOf = (title: string) => screen.getByText(title).closest('li')!;
const proceedLabel = fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge });

async function pressApproveAndMerge() {
  fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
  fireEvent.click(screen.getByRole('button', { name: proceedLabel }));
  await waitFor(() => expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy());
}

describe('at rest and confirming (Panels 12p, 12q)', () => {
  it('offers Approve and merge and Request changes, and NAMES both pull requests', () => {
    renderFrame({ gate: AWAITING }, fakeActions());
    expect(screen.getByRole('button', { name: pra.verb.approveAndMerge })).toBeTruthy();
    expect(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges })).toBeTruthy();
    const pair = fill(pra.list.pair, { a: CORE_NAME, b: GATEWAY_NAME });
    expect(
      screen.getByText(fill(pra.consequence.named, { prs: pair, key: 'ACME-12' })),
    ).toBeTruthy();
  });

  it('COUNTS three or more in the consequence line, and the confirm step still lists every one', () => {
    const AI_V = 'moooon/motir-ai#88@bb22cc3000000000000000000000000000000000';
    renderFrame(
      { gate: { ...AWAITING, subjectVersion: [CORE_V, GATEWAY_V, AI_V].sort().join(',') } },
      fakeActions(),
    );
    expect(
      screen.getByText(fill(pra.consequence.counted, { count: 3, key: 'ACME-12' })),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
    for (const name of ['moooon/motir-ai · #88', CORE_NAME, GATEWAY_NAME]) {
      expect(screen.getByText(fill(pra.confirm.mergeOrQueue, { pr: name }))).toBeTruthy();
    }
    expect(
      screen.getByText('record that you approved these 3 commits, with the time;'),
    ).toBeTruthy();
    expect(screen.getByText(fill(pra.confirm.movesToApproved, { key: 'ACME-12' }))).toBeTruthy();
  });

  it('sits FLUSH in the Development card — no chrome of its own, the port keeping its floor, ceiling and Expand', () => {
    renderFrame({ gate: AWAITING }, fakeActions());
    const port = screen.getByRole('group', { name: en.approvalGate.port.label });
    const frame = port.parentElement!;
    expect(frame.className).toBe('flex flex-col overflow-hidden');
    expect(frame.className).not.toContain('rounded-(--radius-card)');
    // Out of the card body's padding, so the bands meet the card's edges.
    expect(frame.parentElement!.className).toContain('-mx-(--spacing-card-padding)');
    expect(port.className).toContain('min-h-[12.25rem]');
    expect(port.className).toContain('max-h-[34rem]');
    expect(screen.getByRole('button', { name: en.approvalGate.port.expand })).toBeTruthy();
  });
});

describe('the press (Panels 12s, 12t, 12u)', () => {
  it('records the approval, then shows each row merged or Queued to merge — the card stays Approved', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: true,
        gate: APPROVED,
        members: [
          {
            subjectVersion: CORE_V,
            mergeGateId: 'mg-1',
            pullRequestId: CORE_PR.id,
            outcome: 'merged',
          },
          {
            subjectVersion: GATEWAY_V,
            mergeGateId: 'mg-2',
            pullRequestId: GATEWAY_PR.id,
            outcome: 'enqueued',
          },
        ],
      }),
    });
    renderFrame({ gate: AWAITING }, actions);
    await pressApproveAndMerge();

    expect(actions.approveAndMerge).toHaveBeenCalledWith({
      gateId: AWAITING.id,
      identifier: 'ACME-12',
    });
    expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.merged)).toBeTruthy();
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.queued)).toBeTruthy();
    // The CI pill has nothing left to say once the press reported.
    expect(
      within(rowOf(CORE_PR.title)).queryByText(en.github.development.ciState.passing),
    ).toBeNull();
    expect(
      screen.getByText(fill(pra.queued.why, { key: 'ACME-12', pr: GATEWAY_NAME })),
    ).toBeTruthy();
    expect(screen.getByText('2 commits')).toBeTruthy();
    expect(screen.getByText(/Approved by you just now · 2 pull requests/)).toBeTruthy();
    // The verbs are gone: the approval is committed, and there is nothing left to press.
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('one refused: the approval stands, the refusal is named in place, and Retry merge repaints only that row', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: true,
        gate: APPROVED,
        members: [
          {
            subjectVersion: CORE_V,
            mergeGateId: 'mg-1',
            pullRequestId: CORE_PR.id,
            outcome: 'merged',
          },
          {
            subjectVersion: GATEWAY_V,
            mergeGateId: 'mg-2',
            pullRequestId: GATEWAY_PR.id,
            outcome: 'refused',
            refusal: { tag: 'MERGE_CONFLICT' },
          },
        ],
      }),
      retryMember: vi.fn().mockResolvedValue({
        ok: true,
        member: {
          subjectVersion: GATEWAY_V,
          mergeGateId: 'mg-2',
          pullRequestId: GATEWAY_PR.id,
          outcome: 'merged',
        },
      }),
    });
    renderFrame({ gate: AWAITING }, actions);
    await pressApproveAndMerge();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(fill(pra.refused.title, { pr: GATEWAY_NAME }));
    expect(alert.textContent).toContain(en.approvalGate.refusal.mergeConflict.title);
    expect(alert.textContent).toContain(fill(pra.refused.stands, { other: CORE_NAME }));
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.refused)).toBeTruthy();
    expect(
      within(rowOf(CORE_PR.title)).queryByRole('button', { name: pra.outcome.retry }),
    ).toBeNull();

    fireEvent.click(
      within(rowOf(GATEWAY_PR.title)).getByRole('button', { name: pra.outcome.retry }),
    );
    await waitFor(() =>
      expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.merged)).toBeTruthy(),
    );
    expect(actions.retryMember).toHaveBeenCalledWith({
      approvalGateId: APPROVED.id,
      mergeGateId: 'mg-2',
      identifier: 'ACME-12',
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.merged)).toBeTruthy();
  });

  it('a refusal of the APPROVAL itself is drawn by the frame, and no row reports a merge', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: false,
        refusal: { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Ada L.' },
      }),
    });
    renderFrame({ gate: AWAITING }, actions);
    fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
    fireEvent.click(screen.getByRole('button', { name: proceedLabel }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain(
      fill(en.approvalGate.refusal.alreadyDecided.byName, { name: 'Ada L.' }),
    );
    expect(screen.queryByText(pra.outcome.merged)).toBeNull();
    expect(screen.queryByText(pra.outcome.merging)).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('after a reload (Panels 12s, 12u′)', () => {
  it('reads Queued to merge and Not merged yet with Retry merge — and never a refusal reason', () => {
    renderFrame(
      {
        gate: APPROVED,
        members: [
          { subjectVersion: CORE_V, awaitingMergeGateId: null, queued: true },
          { subjectVersion: GATEWAY_V, awaitingMergeGateId: 'mg-2', queued: false },
        ],
      },
      fakeActions(),
    );
    expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.queued)).toBeTruthy();
    const gateway = rowOf(GATEWAY_PR.title);
    expect(within(gateway).getByText(pra.outcome.notMergedYet)).toBeTruthy();
    expect(within(gateway).getByRole('button', { name: pra.outcome.retry })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByText(fill(pra.notMergedYet.why, { pr: GATEWAY_NAME, host: pra.host })),
    ).toBeTruthy();
    expect(screen.getByText(/Approved by Ada L\. · 2 pull requests/)).toBeTruthy();
  });

  it('a gate that still awaits reports no outcome on any row', () => {
    renderFrame(
      {
        gate: AWAITING,
        members: [{ subjectVersion: CORE_V, awaitingMergeGateId: 'mg-1', queued: false }],
      },
      fakeActions(),
    );
    expect(screen.queryByText(pra.outcome.notMergedYet)).toBeNull();
    expect(
      within(rowOf(CORE_PR.title)).getByText(en.github.development.ciState.passing),
    ).toBeTruthy();
  });
});

describe('who else sees it (Panels 12w, 12v)', () => {
  it('a bystander sees the port and who it waits on, and no verb — not even Retry', () => {
    renderFrame(
      {
        gate: APPROVED,
        canDecide: false,
        members: [{ subjectVersion: GATEWAY_V, awaitingMergeGateId: 'mg-2', queued: false }],
      },
      fakeActions(),
    );
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.notMergedYet)).toBeTruthy();
    expect(screen.queryByRole('button', { name: pra.outcome.retry })).toBeNull();

    cleanup();
    renderFrame({ gate: AWAITING, canDecide: false }, fakeActions());
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(document.body.textContent).toContain('Mara S.');
  });

  it('a withdrawn gate is state G, naming the pull request whose head a push moved', () => {
    const MOVED_CORE_V = 'moooon/motir-core#131@0000000000000000000000000000000000000001';
    renderFrame(
      {
        gate: {
          ...AWAITING,
          state: 'superseded',
          subjectVersion: [MOVED_CORE_V, GATEWAY_V].sort().join(','),
        },
      },
      fakeActions(),
    );
    expect(screen.getByText(en.approvalGate.state.withdrawn)).toBeTruthy();
    expect(screen.getByText(fill(pra.withdrawn.port, { pr: CORE_NAME }))).toBeTruthy();
    expect(screen.getByText(pra.withdrawn.portCite)).toBeTruthy();
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
  });
});
