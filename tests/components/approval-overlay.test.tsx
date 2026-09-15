// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { APPROVAL_GATE_KINDS, withoutApprovalOverlay } from '@/lib/approvals/overlayAddress';
import type {
  ApprovalGateDTO,
  ApprovalGateKindDTO,
  ApprovalGateOverlayReadDTO,
} from '@/lib/dto/approvalGate';

// THE APPROVAL OVERLAY HOST (Story MOTIR-5214 · Subtask MOTIR-5224), built to
// `design/workbench/approval-overlay.mock.html` + `design-notes.md` § 22.
//
// What this file holds in place is not "a dialog renders" — it is the properties
// the overlay is FOR, each of which fails silently:
//
//   · the open state is the ADDRESS and nothing else, so Back closes it;
//   · every close lands on ONE function, which strips exactly two parameters with
//     `shallowPush` and leaves the page underneath alone;
//   · the overlay is TOTAL — every answer the read can give has a drawn arm, and
//     none of them is an empty port or a crash;
//   · the frame is the shared one, and deciding leaves the overlay open on the
//     decided record with the server surfaces refreshed.

let params = new URLSearchParams();
let pathname = '/workbench';
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));

const { decideApprovalGateAction } = vi.hoisted(() => ({ decideApprovalGateAction: vi.fn() }));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({ decideApprovalGateAction }));

const { announceGateDecided } = vi.hoisted(() => ({ announceGateDecided: vi.fn() }));
vi.mock('@/lib/approvals/decidedGates', () => ({ announceGateDecided }));

// The design port has its OWN suite (`design-result-panel.test.ts`); here it
// stands in for itself so every assertion is about the OVERLAY.
vi.mock('@/app/(authed)/items/[key]/_components/DesignResultPanel', () => ({
  DesignResultPanel: ({ evidence }: { evidence: { id: string } | null }) => (
    <div data-testid="design-port" data-evidence={evidence?.id ?? ''} />
  ),
}));

const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');

const GATE: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  subjectVersion: '9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

function readOf(overrides: Partial<ApprovalGateOverlayReadDTO> = {}): ApprovalGateOverlayReadDTO {
  return {
    workItem: { id: 'wi-1', identifier: 'GATE-1', title: 'Draw the row for a published design' },
    gate: GATE,
    canDecide: true,
    routedToLabel: 'Riley Reviewer',
    subject: {
      state: 'resolved',
      kind: 'design_result',
      evidence: { id: 'ev-1' } as never,
      filesKept: false,
    },
    ...overrides,
  };
}

function openAt(key: string, kind: string, host = 'tab=approvals&page=2') {
  pathname = '/workbench';
  params = new URLSearchParams(`${host}&approval=${key}&approvalKind=${kind}`);
}

/** Render, then let the read's microtask land inside an act scope. */
async function renderOverlay(messages?: Record<string, unknown>) {
  const utils = render(<ApprovalOverlay />, messages ? { messages, locale: 'zh' } : {});
  await act(async () => {});
  return utils;
}

beforeEach(() => {
  params = new URLSearchParams();
  pathname = '/workbench';
  fetchApprovalGateOverlay.mockReset();
  decideApprovalGateAction.mockReset();
  announceGateDecided.mockReset();
  shallowPush.mockReset();
  push.mockReset();
  refresh.mockReset();
});

afterEach(cleanup);

describe('the approval overlay is OPENED by its address and nothing else', () => {
  it('renders nothing, and reads nothing, when the address carries no approval', async () => {
    params = new URLSearchParams('tab=approvals');
    await renderOverlay();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchApprovalGateOverlay).not.toHaveBeenCalled();
  });

  it('opens over the page on `?approval=`, naming the kind and the item in its title', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    expect(fetchApprovalGateOverlay).toHaveBeenCalledWith(
      'GATE-1',
      'design_result',
      expect.any(AbortSignal),
    );
    const dialog = screen.getByRole('dialog', { name: 'Design result for GATE-1' });
    expect(within(dialog).getByTestId('design-port').dataset.evidence).toBe('ev-1');
  });

  it('closes when the address stops carrying it — the Back vector, with no call made', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    const { rerender } = await renderOverlay();
    expect(screen.getByRole('dialog')).toBeTruthy();
    params = new URLSearchParams('tab=approvals&page=2');
    rerender(<ApprovalOverlay />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('draws the loading bands while the read is in flight', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockReturnValue(new Promise(() => {}));
    await renderOverlay();
    // The dialog's own accessible name is also "Loading the approval" while the
    // read is in flight, so the busy REGION is found by its state, not its label.
    const busy = screen.getByRole('dialog').querySelector('[aria-busy="true"]');
    expect(busy?.getAttribute('aria-label')).toBe(en.approvalOverlay.loading);
    // Close alone in the exit row — no work item yet.
    expect(screen.queryByRole('link', { name: en.approvalOverlay.openWorkItem })).toBeNull();
  });
});

describe('every close lands on ONE function', () => {
  const closed = '/workbench?tab=approvals&page=2';

  it('the exit row’s Close strips exactly the two parameters, with shallowPush', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith(closed);
    expect(withoutApprovalOverlay(`${closed}&approval=GATE-1&approvalKind=design_result`)).toBe(
      closed,
    );
  });

  it('Esc arrives at the same close', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith(closed);
  });

  it('the not-available arm’s own Close is the same close too', async () => {
    openAt('GATE-1', 'merge');
    await renderOverlay();
    const dialog = screen.getByRole('dialog', { name: en.approvalOverlay.notAvailable.title });
    const closes = within(dialog).getAllByRole('button', { name: /^Close/ });
    fireEvent.click(closes[closes.length - 1]!);
    expect(shallowPush).toHaveBeenCalledWith(closed);
  });
});

describe('the overlay is TOTAL over what the read can answer', () => {
  it('an invalid kind opens on "not available" without asking the server', async () => {
    openAt('GATE-1', 'merge');
    await renderOverlay();
    expect(
      screen.getByRole('dialog', { name: en.approvalOverlay.notAvailable.title }),
    ).toBeTruthy();
    expect(screen.getByText(en.approvalOverlay.notAvailable.body)).toBeTruthy();
    expect(fetchApprovalGateOverlay).not.toHaveBeenCalled();
  });

  it('a 404 is "not available", and the exit row does NOT echo the key back', async () => {
    openAt('ZZZ-99', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(null);
    await renderOverlay();
    expect(screen.getByText(en.approvalOverlay.notAvailable.body)).toBeTruthy();
    expect(screen.queryByText('ZZZ-99')).toBeNull();
    expect(screen.queryByRole('link', { name: en.approvalOverlay.openWorkItem })).toBeNull();
  });

  it('a card with no gate of that kind is "not available" too', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({ gate: null, subject: { state: 'no_gate' } }),
    );
    await renderOverlay();
    expect(
      screen.getByRole('dialog', { name: en.approvalOverlay.notAvailable.title }),
    ).toBeTruthy();
    expect(screen.getByText(en.approvalOverlay.notAvailable.body)).toBeTruthy();
  });

  it('a failed read is "not available" — never a blank dialog or a live frame', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockRejectedValue(new Error('500'));
    await renderOverlay();
    expect(
      screen.getByRole('dialog', { name: en.approvalOverlay.notAvailable.title }),
    ).toBeTruthy();
    expect(screen.getByText(en.approvalOverlay.notAvailable.body)).toBeTruthy();
    expect(screen.queryByTestId('design-port')).toBeNull();
  });

  // Per member of the enum other than the one kind this build registers — the
  // address module's own suite ties that list to `UNREGISTERED_GATE_KINDS`.
  for (const kind of APPROVAL_GATE_KINDS.filter((k) => k !== 'design_result')) {
    it(`draws "not built yet" for ${kind}, with no frame mounted`, async () => {
      openAt('GATE-1', kind);
      fetchApprovalGateOverlay.mockResolvedValue(
        readOf({
          gate: { ...GATE, kind: kind as ApprovalGateKindDTO },
          subject: { state: 'kind_not_built' },
        }),
      );
      await renderOverlay();
      expect(screen.getByText(en.workbench.approvals.notRenderable)).toBeTruthy();
      expect(screen.getByText(en.workbench.approvals.notBuiltYet)).toBeTruthy();
      expect(screen.queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
      expect(
        screen.getByRole('dialog', {
          name: `${en.workbench.approvals.kind[kind as keyof typeof en.workbench.approvals.kind]} for GATE-1`,
        }),
      ).toBeTruthy();
    });
  }

  it('keeps "not built yet" for a RESOLVED approve-and-merge subject until its port is mounted (MOTIR-5439 → MOTIR-5440)', async () => {
    // The read answers the Development block's data now; this host renders it only
    // once MOTIR-5440 lands. Until then it must not mount the design frame over it.
    openAt('GATE-1', 'pull_request_approval');
    fetchApprovalGateOverlay.mockResolvedValue(
      readOf({
        gate: { ...GATE, kind: 'pull_request_approval', subjectId: 'wi-1' },
        subject: {
          state: 'resolved',
          kind: 'pull_request_approval',
          pullRequests: [],
          repoDelivery: [],
          deliveries: [],
          howToTest: {
            state: 'record_missing',
            runTarget: null,
            owedBy: null,
            record: null,
            repos: [],
            history: [],
          },
          designEvidence: null,
          isDesignCard: false,
          members: [],
        },
      }),
    );
    await renderOverlay();
    expect(screen.getByText(en.workbench.approvals.notBuiltYet)).toBeTruthy();
    expect(screen.queryByTestId('design-port')).toBeNull();
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
  });

  it('draws "the design is gone" for a subject that no longer resolves', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf({ subject: { state: 'gone' } }));
    await renderOverlay();
    expect(screen.getByText(en.workbench.approvals.subjectGone)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.approvalOverlay.openWorkItem }));
    expect(push).toHaveBeenCalledWith('/items/GATE-1');
  });
});

describe('the frame, composed at full size', () => {
  it('carries the work item in the exit row — once — and a real link out to it', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay();
    const link = screen.getByRole('link', { name: en.approvalOverlay.openWorkItem });
    expect(link.getAttribute('href')).toBe('/items/GATE-1');
    expect(screen.getByText('Draw the row for a published design')).toBeTruthy();
    // "Design result" is band 1's, and appears exactly once on screen.
    expect(screen.getAllByText(en.approvalGate.designResult.kindLabel)).toHaveLength(1);
  });

  it('gives a reader who may see but not decide the port and no verbs', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf({ canDecide: false }));
    await renderOverlay();
    expect(screen.getByTestId('design-port')).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
  });

  it('decides in place: the decided record, the overlay still open, the server surfaces refreshed', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    decideApprovalGateAction.mockResolvedValue({
      ok: true,
      gate: {
        ...GATE,
        state: 'approved',
        decidedByLabel: 'Riley Reviewer',
        decidedAt: GATE.updatedAt,
      },
      filesKept: true,
    });
    await renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.approve }));
    const proceed = en.approvalGate.confirm.proceed.replace('{verb}', en.approvalGate.verb.approve);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: proceed }));
    });
    expect(decideApprovalGateAction).toHaveBeenCalledWith({
      gateId: 'gate-1',
      decision: 'approve',
      identifier: 'GATE-1',
    });
    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
    expect(screen.getByText(en.approvalGate.record.filesKept)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
    // …and the row underneath is TOLD, because a refresh cannot reach its island.
    // The WHOLE decision: the item page underneath reads its `outcomeRef` and
    // `filesKept` (MOTIR-5570).
    expect(announceGateDecided).toHaveBeenCalledWith({
      gate: expect.objectContaining({ id: 'gate-1', state: 'approved' }),
      filesKept: true,
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('draws a refusal IN PLACE and neither closes nor refreshes on it', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    decideApprovalGateAction.mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Sam Someone' },
    });
    await renderOverlay();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect(announceGateDecided).not.toHaveBeenCalled();
    expect(shallowPush).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('speaks zh — the exit row’s link and the dialog’s name', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    await renderOverlay(zh as unknown as Record<string, unknown>);
    expect(screen.getByRole('link', { name: zh.approvalOverlay.openWorkItem })).toBeTruthy();
    expect(
      screen.getByRole('dialog', { name: `GATE-1 的${zh.workbench.approvals.kind.design_result}` }),
    ).toBeTruthy();
  });
});

describe('the overlay across a CHANGING address (MOTIR-5226)', () => {
  it('a read superseded by a new address never lands on it', async () => {
    let resolveFirst!: (read: ApprovalGateOverlayReadDTO) => void;
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    fetchApprovalGateOverlay.mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = await renderOverlay();

    openAt('GATE-2', 'design_result');
    rerender(<ApprovalOverlay />);
    await act(async () => resolveFirst(readOf()));

    // GATE-1's answer was for an address nobody is on any more.
    expect(screen.queryByRole('dialog', { name: 'Design result for GATE-1' })).toBeNull();
    expect(screen.getByRole('dialog').querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('a FAILED read superseded by a new address does not draw "not available" over it', async () => {
    let rejectFirst!: (err: Error) => void;
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectFirst = reject)),
    );
    fetchApprovalGateOverlay.mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = await renderOverlay();

    openAt('GATE-2', 'design_result');
    rerender(<ApprovalOverlay />);
    await act(async () => rejectFirst(new Error('Approval gate read failed (500)')));

    expect(screen.queryByText(en.approvalOverlay.notAvailable.body)).toBeNull();
    expect(screen.getByRole('dialog').querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('returns focus to whatever opened it — a URL write is not Radix’s Trigger', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'the row';
    document.body.appendChild(opener);
    opener.focus();
    params = new URLSearchParams('tab=approvals');
    fetchApprovalGateOverlay.mockResolvedValue(readOf());
    const { rerender } = await renderOverlay();

    openAt('GATE-1', 'design_result');
    rerender(<ApprovalOverlay />);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: 'Design result for GATE-1' })).toBeTruthy();

    params = new URLSearchParams('tab=approvals&page=2');
    rerender(<ApprovalOverlay />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('names the published design plainly when the gate carries no version', async () => {
    openAt('GATE-1', 'design_result');
    fetchApprovalGateOverlay.mockResolvedValue(readOf({ gate: { ...GATE, subjectVersion: null } }));
    await renderOverlay();

    const dialog = screen.getByRole('dialog', { name: 'Design result for GATE-1' });
    expect(within(dialog).getByText(en.approvalGate.designResult.meta.plain)).toBeTruthy();
  });
});
