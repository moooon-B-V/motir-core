// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AWAITING_MERGE_GATE, CORE_PR, recordDto } from '../helpers/howToTestFixtures';
import type { DevelopmentGateActions } from '@/components/github/DevelopmentGateFrame';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type {
  ApprovalGateDTO,
  ApprovalGateOverlayReadDTO,
  ApprovalOverlayStatusDTO,
} from '@/lib/dto/approvalGate';

// A DESIGN SENT BACK IS A VERDICT (Story MOTIR-6070 · Subtask MOTIR-6427), built to
// `design/work-items/approval-control--design-verdict.mock.html` and its notes'
// § *The DESIGN VERDICT*. What these hold in place, each of which fails silently:
//
//   · on a design, Request changes asks for a reason AND a verdict — two tiles, nothing
//     pre-selected — and refuses a press missing either IN PLACE, reporting both at once;
//   · the press carries `refusalVerdict` beside `noteMd`; no other kind grows the group;
//   · the record names the verdict (chip) and the decided row leads with it;
//   · the overlay header's status chip repaints to To Do from `statusWritten`, and the
//     item page's rail does through the decided-gate bridge;
//   · a Re-plan ASKS, naming the design card's PARENT; Not now leaves the door; a Revise
//     asks nothing and draws no door.

let params = new URLSearchParams();
const pathname = '/workbench';
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));

const { shallowPush, shallowReplace } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  shallowReplace: vi.fn(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace }));

const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));

const { decideApprovalGateAction, approveAndMergeAction } = vi.hoisted(() => ({
  decideApprovalGateAction: vi.fn(),
  approveAndMergeAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction,
  approveAndMergeAction,
  retryApproveAndMergeMemberAction: vi.fn(),
}));

vi.mock('@/app/(authed)/items/[key]/_components/DesignResultPanel', () => ({
  DesignResultPanel: () => <div data-testid="design-port" />,
}));

const { DevelopmentSectionBody } = await import('@/components/github/DevelopmentSection');
const { ApprovalGateControl } = await import('@/components/approvals/ApprovalGateControl');
const { useRefusalVerb, RefusalReasonCell } = await import('@/components/approvals/RefusalReason');
const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
const { DesignResultSection } =
  await import('@/app/(authed)/items/[key]/_components/DesignResultSection');
const { announceGateDecided } = await import('@/lib/approvals/decidedGates');
const { OptimisticStatusProvider, useDisplayedStatus } =
  await import('@/app/(authed)/items/[key]/_components/OptimisticStatusProvider');
const { DecidedGateStatusBridge } =
  await import('@/app/(authed)/items/[key]/_components/DecidedGateStatusBridge');

type RefusalSubject = import('@/components/approvals/RefusalReason').RefusalSubject;
type DesignRefusalFacts = import('@/components/approvals/RefusalReason').DesignRefusalFacts;

const reason = en.approvalGate.reason;
const verdict = reason.verdict;
const ask = en.approvalGate.replanAsk;
const REASON = 'The empty state needs the illustration, not a line of text.';

const GATE: ApprovalGateDTO = {
  id: 'gate-d1',
  workItemId: 'wi-51',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: '3f9a21c07d',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-26T09:00:00.000Z',
  updatedAt: '2026-09-26T09:00:00.000Z',
};

const sentBack = (refusalVerdict: ApprovalGateDTO['refusalVerdict'], id = GATE.id) => ({
  ...GATE,
  id,
  state: 'changes_requested' as const,
  decidedById: 'user-1',
  decidedAt: '2026-09-26T10:14:00.000Z',
  decidedByLabel: 'Yue',
  decisionSource: 'ui' as const,
  noteMd: REASON,
  refusalVerdict,
  outcomeRef: 'todo',
});

const FACTS: DesignRefusalFacts = { replanKey: 'ACME-50', returnStatusLabel: 'To Do' };

function Frame({
  gate = GATE,
  subject = 'design',
  facts = FACTS,
  onDecide,
}: {
  gate?: ApprovalGateDTO;
  subject?: RefusalSubject;
  facts?: DesignRefusalFacts;
  onDecide: (...args: unknown[]) => Promise<GateRefusal | null>;
}) {
  const refusalVerb = useRefusalVerb();
  return (
    <ApprovalGateControl
      gate={gate}
      canDecide
      kindLabel="Design result"
      subjectMeta="version 3f9a21c0"
      port={<div>the subject</div>}
      verbs={[
        refusalVerb(subject, 'ACME-51', {}, facts),
        { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
      ]}
      consequence="Approving moves ACME-51 to Done."
      confirmConsequences={['records it']}
      onDecide={onDecide as never}
    />
  );
}

const openBand = () =>
  fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
const group = () => screen.queryByRole('radiogroup', { name: verdict.legend });
const tile = (label: string) =>
  within(group()!).getByRole('radio', { name: new RegExp(`^${label}`) }) as HTMLInputElement;
const proceed = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: reason.proceed }));
  });
};

beforeEach(() => {
  params = new URLSearchParams();
  shallowPush.mockReset();
  shallowReplace.mockReset();
  fetchApprovalGateOverlay.mockReset();
  decideApprovalGateAction.mockReset();
  approveAndMergeAction.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

describe('the design band asks for a VERDICT beside the reason (panels 1–2)', () => {
  it('draws the two tiles under the reason, NOTHING pre-selected, each saying where the card goes', () => {
    renderWithIntl(<Frame onDecide={vi.fn(async () => null)} />);
    openBand();

    expect(screen.getByLabelText(reason.label)).toBeTruthy();
    expect(group()!.getAttribute('aria-required')).toBe('true');
    expect(tile(verdict.revise.label).checked).toBe(false);
    expect(tile(verdict.replan.label).checked).toBe(false);
    expect(
      screen.getByText('ACME-51 goes back to To Do, and the next run starts from your reason.'),
    ).toBeTruthy();
    // The Re-plan line names the PARENT, which is where the planner opens.
    expect(
      screen.getByText('ACME-51 goes back to To Do, and Motir AI then offers to re-plan ACME-50.'),
    ).toBeTruthy();
    // The shipped *stays* line is FALSE on a design and is dropped; the record line stays.
    expect(screen.getByText(reason.consequence.versionBack)).toBeTruthy();
    expect(screen.queryByText('Leave ACME-51 where it is — nothing moves yet.')).toBeNull();
  });

  it('a reason with NO verdict is refused in place — the group invalid, its own error, nothing sent', async () => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame onDecide={onDecide} />);
    openBand();
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: REASON } });
    await proceed();

    expect(group()!.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(verdict.required)).toBeTruthy();
    expect(screen.queryByText(reason.required)).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
    // Focus goes to the verdict group's first tile — the reason is fine.
    expect(document.activeElement).toBe(tile(verdict.revise.label));

    // Picking a tile clears it at once.
    fireEvent.click(tile(verdict.replan.label));
    expect(screen.queryByText(verdict.required)).toBeNull();
    expect(group()!.getAttribute('aria-invalid')).toBeNull();
  });

  it('BOTH missing — ONE press reports both, and focus goes to the reason first', async () => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame onDecide={onDecide} />);
    openBand();
    await proceed();

    expect(screen.getByText(reason.required)).toBeTruthy();
    expect(screen.getByText(verdict.required)).toBeTruthy();
    expect(screen.getByLabelText(reason.label).getAttribute('aria-invalid')).toBe('true');
    expect(group()!.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText(reason.label));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('a verdict with NO reason is refused under the reason alone', async () => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame onDecide={onDecide} />);
    openBand();
    fireEvent.click(tile(verdict.revise.label));
    await proceed();
    expect(screen.getByText(reason.required)).toBeTruthy();
    expect(screen.queryByText(verdict.required)).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it.each([
    [verdict.revise.label, 'revise'],
    [verdict.replan.label, 're_plan'],
  ] as const)('%s + a reason sends BOTH with the press', async (label, value) => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame onDecide={onDecide} />);
    openBand();
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: `  ${REASON}  ` } });
    fireEvent.click(tile(label));
    expect(tile(label).checked).toBe(true);
    await proceed();
    expect(onDecide).toHaveBeenCalledWith('request_changes', undefined, REASON, value);
  });

  it('the door’s `refusal_verdict_required` is answered under the verdict, in place', async () => {
    const onDecide = vi.fn(
      async () =>
        ({
          tag: 'APPROVAL_GATE_VERB_NOT_OFFERED',
          reason: 'refusal_verdict_required',
        }) as GateRefusal,
    );
    renderWithIntl(<Frame onDecide={onDecide} />);
    openBand();
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: REASON } });
    fireEvent.click(tile(verdict.revise.label));
    await proceed();
    expect(screen.getByText(verdict.required)).toBeTruthy();
    expect(screen.queryByText(reason.required)).toBeNull();
  });

  it('the door’s `refusal_verdict_not_offered` is the frame’s refusal, in its own words', async () => {
    const onDecide = vi.fn(
      async () =>
        ({
          tag: 'APPROVAL_GATE_VERB_NOT_OFFERED',
          reason: 'refusal_verdict_not_offered',
        }) as GateRefusal,
    );
    renderWithIntl(<Frame onDecide={onDecide} />);
    openBand();
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: REASON } });
    fireEvent.click(tile(verdict.revise.label));
    await proceed();
    expect(screen.getByRole('alert').textContent).toContain(
      en.approvalGate.refusal.verbNotOffered.verdict.title,
    );
  });

  it('a project with NO initial To-do keeps the shipped *stays* line and names no status', () => {
    renderWithIntl(
      <Frame
        facts={{ replanKey: 'ACME-50', returnStatusLabel: null }}
        onDecide={vi.fn(async () => null)}
      />,
    );
    openBand();
    expect(screen.getByText('Leave ACME-51 where it is — nothing moves yet.')).toBeTruthy();
    expect(group()).toBeTruthy();
    expect(screen.queryByText(/goes back to/)).toBeNull();
  });

  it.each(['version', 'commits', 'decision'] as const)(
    'the %s band grows NO verdict group',
    (subject) => {
      renderWithIntl(<Frame subject={subject} onDecide={vi.fn(async () => null)} />);
      openBand();
      expect(screen.getByLabelText(reason.label)).toBeTruthy();
      expect(group()).toBeNull();
    },
  );

  it('speaks zh', () => {
    renderWithIntl(<Frame onDecide={vi.fn(async () => null)} />, {
      messages: zh as unknown as typeof en,
      locale: 'zh',
    });
    fireEvent.click(screen.getByRole('button', { name: zh.approvalGate.verb.requestChanges }));
    expect(
      screen.getByRole('radiogroup', { name: zh.approvalGate.reason.verdict.legend }),
    ).toBeTruthy();
    expect(screen.getByText('ACME-51 退回到To Do，下一次运行将从你的理由开始。')).toBeTruthy();
  });
});

describe('the verdict on the RECORD and the ROW (panel 4)', () => {
  it.each([
    ['revise', reason.record.verdict.revise],
    ['re_plan', reason.record.verdict.replan],
  ] as const)('a design sent back with %s names it on the record', (value, words) => {
    renderWithIntl(<Frame gate={sentBack(value)} onDecide={vi.fn(async () => null)} />);
    expect(screen.getByTestId('refusal-verdict').textContent).toBe(words);
    expect(screen.getByText(`“${REASON}”`)).toBeTruthy();
  });

  it('a refusal with no verdict (GitHub, or before the verdict existed) shows no chip', () => {
    renderWithIntl(<Frame gate={sentBack(null)} onDecide={vi.fn(async () => null)} />);
    expect(screen.queryByTestId('refusal-verdict')).toBeNull();
  });

  it('the decided row LEADS with the verdict, and its title carries verdict · version · reason', () => {
    renderWithIntl(<RefusalReasonCell reason={REASON} version="3f9a21c07d" verdict="re_plan" />);
    const cell = screen.getByTestId('refusal-reason-cell');
    expect(cell.textContent).toBe(`${verdict.replan.label} · “${REASON}”`);
    expect(cell.getAttribute('title')).toBe(`${verdict.replan.label} — on 3f9a21c0 — ${REASON}`);
  });

  it('a row with no verdict is unchanged', () => {
    renderWithIntl(<RefusalReasonCell reason={REASON} version="3f9a21c07d" />);
    expect(screen.getByTestId('refusal-reason-cell').textContent).toBe(`“${REASON}”`);
  });
});

// ── the approval overlay — the design press site ─────────────────────────────────────

const STATUSES: ApprovalOverlayStatusDTO[] = [
  { key: 'todo', label: 'To Do', category: 'todo', isInitial: true },
  { key: 'in_progress', label: 'In Progress', category: 'in_progress', isInitial: false },
  { key: 'in_review', label: 'In Review', category: 'in_progress', isInitial: false },
  { key: 'done', label: 'Done', category: 'done', isInitial: false },
];

function read(overrides: Partial<ApprovalGateOverlayReadDTO> = {}): ApprovalGateOverlayReadDTO {
  return {
    workItem: {
      id: 'wi-51',
      identifier: 'ACME-51',
      title: 'Empty state for the exports list',
      status: 'in_review',
      parentIdentifier: 'ACME-50',
    },
    statuses: STATUSES,
    gate: GATE,
    canDecide: true,
    canReplan: true,
    routedToLabel: 'Yue',
    stamp: 'v1.stamp',
    movedSince: [],
    earlierApproval: null,
    subject: {
      state: 'resolved',
      kind: 'design_result',
      evidence: { id: 'ev-1' } as never,
      filesKept: false,
    },
    ...overrides,
  };
}

async function openOverlay(r: ApprovalGateOverlayReadDTO = read()) {
  params = new URLSearchParams('tab=approvals&approval=ACME-51&approvalKind=design_result');
  fetchApprovalGateOverlay.mockResolvedValue(r);
  renderWithIntl(<ApprovalOverlay />);
  await act(async () => {});
  return screen.getByRole('dialog');
}

async function sendBack(dialog: HTMLElement, label: string) {
  fireEvent.click(
    within(dialog).getByRole('button', { name: en.approvalGate.verb.requestChanges }),
  );
  fireEvent.change(within(dialog).getByLabelText(reason.label), { target: { value: REASON } });
  fireEvent.click(
    within(within(dialog).getByRole('radiogroup', { name: verdict.legend })).getByRole('radio', {
      name: new RegExp(`^${label}`),
    }),
  );
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: reason.proceed }));
  });
}

const headerChip = (dialog: HTMLElement, label: string) =>
  within(dialog).queryAllByText(label, { exact: true });
const theAsk = () => screen.queryByTestId('refusal-replan-ask');
const theDoor = () => screen.queryByTestId('refusal-replan-door');

describe('the approval overlay — a design sent back', () => {
  it('names the tiles with the PARENT and the project’s own To-do label', async () => {
    const dialog = await openOverlay();
    fireEvent.click(
      within(dialog).getByRole('button', { name: en.approvalGate.verb.requestChanges }),
    );
    expect(
      within(dialog).getByText(
        'ACME-51 goes back to To Do, and Motir AI then offers to re-plan ACME-50.',
      ),
    ).toBeTruthy();
  });

  it('REVISE: sends the verdict, repaints the header chip to To Do, and asks NOTHING', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: sentBack('revise'),
      filesKept: false,
      statusWritten: 'todo',
    });
    const dialog = await openOverlay();
    // The header carries the card's status before the press (panel 5b).
    expect(headerChip(dialog, 'In Review')).toHaveLength(1);

    await sendBack(dialog, verdict.revise.label);

    expect(decideApprovalGateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        gateId: GATE.id,
        decision: 'request_changes',
        noteMd: REASON,
        refusalVerdict: 'revise',
      }),
    );
    expect(headerChip(dialog, 'To Do')).toHaveLength(1);
    expect(headerChip(dialog, 'In Review')).toHaveLength(0);
    expect(within(dialog).getByTestId('refusal-verdict').textContent).toBe(
      reason.record.verdict.revise,
    );
    expect(theAsk()).toBeNull();
    expect(theDoor()).toBeNull();
    expect(shallowReplace).not.toHaveBeenCalled();
  });

  it('RE-PLAN: the band ASKS, naming the parent; Not now leaves the door, which names it too', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: sentBack('re_plan'),
      filesKept: false,
      statusWritten: 'todo',
    });
    const dialog = await openOverlay();
    await sendBack(dialog, verdict.replan.label);

    expect(decideApprovalGateAction).toHaveBeenCalledWith(
      expect.objectContaining({ refusalVerdict: 're_plan' }),
    );
    expect(headerChip(dialog, 'To Do')).toHaveLength(1);
    expect(screen.getByRole('group', { name: ask.title.replace('{key}', 'ACME-50') })).toBeTruthy();
    expect(document.activeElement?.textContent).toContain(ask.yes);
    expect(shallowReplace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: en.planningWorkspace.handoff.notNow }));
    expect(theAsk()).toBeNull();
    const door = theDoor()!;
    expect(door.getAttribute('aria-label')).toBe(
      en.approvalGate.replanDoor.aria.replace('{item}', 'ACME-50'),
    );
    expect(document.activeElement).toBe(door);
    // The overlay stays open on the decided record.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('RE-PLAN, then yes: ONE replace to the seeded planner for this gate', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: sentBack('re_plan'),
      filesKept: false,
      statusWritten: 'todo',
    });
    const dialog = await openOverlay();
    await sendBack(dialog, verdict.replan.label);
    fireEvent.click(screen.getByRole('button', { name: ask.yes }));
    expect(shallowReplace).toHaveBeenCalledTimes(1);
    const href = shallowReplace.mock.calls[0]![0] as string;
    expect(href).toContain(GATE.id);
    expect(href).not.toContain('approval=');
  });

  it('a parentless design card asks about ITSELF', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: sentBack('re_plan'),
      filesKept: false,
      statusWritten: 'todo',
    });
    const dialog = await openOverlay(
      read({
        workItem: {
          id: 'wi-51',
          identifier: 'ACME-51',
          title: 'Empty state for the exports list',
          status: 'in_review',
          parentIdentifier: null,
        },
      }),
    );
    await sendBack(dialog, verdict.replan.label);
    expect(screen.getByRole('group', { name: ask.title.replace('{key}', 'ACME-51') })).toBeTruthy();
  });

  it('a decision that wrote no status leaves the header chip where it was', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: sentBack('revise'),
      filesKept: false,
      statusWritten: null,
    });
    const dialog = await openOverlay();
    await sendBack(dialog, verdict.revise.label);
    expect(headerChip(dialog, 'In Review')).toHaveLength(1);
  });
});

// ── Workflow B — a design that LEADS the Development frame ─────────────────────────────

describe('a design leading the Development frame (Workflow B) is sent back with a verdict', () => {
  it('asks for the verdict, sends it, and the Re-plan ask names the parent', async () => {
    const awaiting: ApprovalGateDTO = { ...AWAITING_MERGE_GATE, ...GATE, id: 'gate-wb-1' };
    const decide = vi.fn(async () => ({
      ok: true,
      gate: sentBack('re_plan', 'gate-wb-1'),
      filesKept: null,
      statusWritten: 'todo',
    }));
    renderWithIntl(
      <DevelopmentSectionBody
        pullRequests={[CORE_PR]}
        itemIdentifier="ACME-51"
        mergeGate={{
          gate: awaiting,
          canDecide: true,
          routedToLabel: 'Yue',
          members: [],
          stamp: 'v1.stamp',
        }}
        gateActions={
          {
            decide,
            approveAndMerge: vi.fn(),
            retryMember: vi.fn(),
          } as unknown as DevelopmentGateActions
        }
        gateLayout="fill"
        canReplan
        designRefusal={FACTS}
      />,
    );
    openBand();
    // The DESIGN band, not the commits' one.
    expect(screen.queryByText(reason.consequence.commitsBack)).toBeNull();
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: REASON } });
    fireEvent.click(tile(verdict.replan.label));
    await proceed();
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ noteMd: REASON, refusalVerdict: 're_plan' }),
    );
    expect(screen.getByRole('group', { name: ask.title.replace('{key}', 'ACME-50') })).toBeTruthy();
  });
});

// ── the item page — the design section's record and the status rail ────────────────────

describe('the item page with a refused design gate', () => {
  function section(gate: ApprovalGateDTO, canReplan = true) {
    return renderWithIntl(
      <DesignResultSection
        evidence={null}
        isDesignCard
        gate={gate}
        canDecide={false}
        subject={null}
        itemIdentifier="ACME-51"
        routedToLabel="Yue"
        routedToViewer
        canReplan={canReplan}
        replanKey="ACME-50"
      />,
    );
  }

  it('a Re-plan record quotes the reason, names the verdict and keeps the door on the PARENT', () => {
    section(sentBack('re_plan', 'gate-page-1'));
    expect(screen.getByText(`“${REASON}”`)).toBeTruthy();
    expect(screen.getByTestId('refusal-verdict').textContent).toBe(reason.record.verdict.replan);
    expect(theDoor()!.getAttribute('aria-label')).toBe(
      en.approvalGate.replanDoor.aria.replace('{item}', 'ACME-50'),
    );
    // Never the ask: that is the presser's, in the overlay.
    expect(theAsk()).toBeNull();
  });

  it('a Revise record has no door, ever', () => {
    section(sentBack('revise', 'gate-page-2'));
    expect(screen.getByTestId('refusal-verdict').textContent).toBe(reason.record.verdict.revise);
    expect(theDoor()).toBeNull();
  });

  it('a reader who may not plan sees no door', () => {
    section(sentBack('re_plan', 'gate-page-3'), false);
    expect(theDoor()).toBeNull();
  });

  it('the status rail repaints to To Do when the overlay announces the refusal', () => {
    function Rail() {
      return <span data-testid="rail">{useDisplayedStatus('unused')}</span>;
    }
    render(
      <OptimisticStatusProvider serverStatus="in_review">
        <DecidedGateStatusBridge gateId="gate-page-4" />
        <Rail />
      </OptimisticStatusProvider>,
    );
    expect(screen.getByTestId('rail').textContent).toBe('in_review');
    act(() =>
      announceGateDecided({
        gate: sentBack('revise', 'gate-page-4'),
        filesKept: false,
        statusWritten: 'todo',
      }),
    );
    expect(screen.getByTestId('rail').textContent).toBe('todo');
  });
});

// ── Story gate MOTIR-6428 — the overlay's Development-frame arm repaints too ─────────────

describe('the overlay’s Development frame repaints the header chip from what a press wrote', () => {
  /** The overlay read for a card whose Development block holds the gate (Workflow B). */
  function developmentRead(
    gate: ApprovalGateDTO,
    designLeads: boolean,
  ): ApprovalGateOverlayReadDTO {
    return read({
      gate,
      subject: {
        state: 'resolved',
        kind: 'pull_request_approval',
        pullRequests: [CORE_PR],
        repoDelivery: [],
        deliveries: [],
        howToTest: recordDto(),
        acceptanceEvidence: null,
        acceptanceGate: null,
        designEvidence: designLeads ? ({ id: 'ev-1' } as never) : null,
        isDesignCard: designLeads,
        members: [],
        mergeSubjectVersion: null,
      },
    });
  }

  it('a design leading the frame, sent back with Revise → the chip reads To Do', async () => {
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: sentBack('revise'),
      filesKept: false,
      statusWritten: 'todo',
    });
    const dialog = await openOverlay(developmentRead(GATE, true));
    expect(headerChip(dialog, 'In Review')).toHaveLength(1);

    await sendBack(dialog, verdict.revise.label);

    expect(decideApprovalGateAction).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'request_changes', refusalVerdict: 'revise' }),
    );
    expect(headerChip(dialog, 'To Do')).toHaveLength(1);
  });

  it('Approve and merge whose approval wrote a status → the chip reads it', async () => {
    const merge: ApprovalGateDTO = { ...AWAITING_MERGE_GATE, workItemId: 'wi-51' };
    approveAndMergeAction.mockResolvedValue({
      ok: true,
      gate: {
        ...merge,
        state: 'approved',
        decidedById: 'user-1',
        decidedByLabel: 'Yue',
        decidedAt: '2026-09-26T10:14:00.000Z',
        outcomeRef: 'done',
      },
      members: [],
    });
    const dialog = await openOverlay(developmentRead(merge, false));
    const pra = en.approvalGate.pullRequestApproval;
    fireEvent.click(within(dialog).getByRole('button', { name: pra.verb.approveAndMerge }));
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: en.approvalGate.confirm.proceed.replace('{verb}', pra.verb.approveAndMerge),
        }),
      );
    });
    expect(approveAndMergeAction).toHaveBeenCalledTimes(1);
    expect(headerChip(dialog, 'Done')).toHaveLength(1);
  });

  it('an APPROVE the door does not offer is the frame’s plain VERB_NOT_OFFERED refusal', async () => {
    const onDecide = vi.fn(async () => ({ tag: 'APPROVAL_GATE_VERB_NOT_OFFERED' }) as GateRefusal);
    renderWithIntl(<Frame onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: en.approvalGate.confirm.proceed.replace('{verb}', 'Approve'),
        }),
      );
    });
    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).toContain(en.approvalGate.refusal.verbNotOffered.title);
    expect(alert).not.toContain(en.approvalGate.refusal.verbNotOffered.verdict.title);
  });
});
