// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

vi.mock('next/navigation', () => ({
  usePathname: () => '/boards',
  useSearchParams: () => new URLSearchParams(),
}));

import {
  BoardCardHeldRefusal,
  BoardHeldRefusalProvider,
  NO_BOARD_HELD_REFUSAL,
  planHoldName,
  type BoardHeldRefusal,
} from '@/app/(authed)/boards/_components/BoardHeldRefusal';
import { planRowDestination } from '@/lib/planning/planDestination';
import { heldLineFromRefusal, readHeldRefusal } from '@/components/issues/heldRefusal';
import type { ApprovalGatePendingPayloadDTO } from '@/lib/dto/approvalGate';
import type { PlanHoldDTO } from '@/lib/dto/plans';

// THE BOARD REFUSES ON THE CARD (Story MOTIR-4887 · Subtask MOTIR-5529;
// `design/boards/design-notes.md` § panel 2b). A dnd-kit drag is not driven in
// happy-dom anywhere in this suite — it is the acceptance E2E's (MOTIR-5531) — so
// what is pinned here is the two halves the drag path composes: the branch on the
// 409 body's `code`, and the held line drawn ON the refused card and closed by
// Esc / a click outside.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const gate = (
  over: Partial<ApprovalGatePendingPayloadDTO> = {},
): ApprovalGatePendingPayloadDTO => ({
  itemKey: 'PROD-7',
  kind: 'design_result',
  waitingOn: 'decision',
  gateRaised: true,
  canDecide: true,
  routedToLabel: 'Ada Lovelace',
  ...over,
});

const plan = (over: Partial<PlanHoldDTO> = {}): PlanHoldDTO => ({
  itemKey: 'PROD-7',
  workItemId: 'wi_a',
  planId: 'pln_a',
  planStatus: 'planned',
  sessionId: 'pcs_1',
  anchorKey: 'PROD-10',
  ...over,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('readHeldRefusal — the ONE branch', () => {
  it('reads the gate off a 409 APPROVAL_GATE_PENDING, tagged by its code', async () => {
    expect(
      await readHeldRefusal(json(409, { code: 'APPROVAL_GATE_PENDING', gate: gate() })),
    ).toEqual({ code: 'APPROVAL_GATE_PENDING', gate: gate() });
  });

  it('reads the plan off a 409 PLAN_TARGET_HELD, tagged by its code (MOTIR-6268)', async () => {
    expect(
      await readHeldRefusal(json(409, { code: 'PLAN_TARGET_HELD', error: 'held', plan: plan() })),
    ).toEqual({ code: 'PLAN_TARGET_HELD', plan: plan() });
  });

  it('a 409 with any OTHER code, or a held code without its payload, is null', async () => {
    expect(
      await readHeldRefusal(json(409, { code: 'SOMETHING_ELSE', plan: plan(), gate: gate() })),
    ).toBeNull();
    expect(await readHeldRefusal(json(409, { code: 'PLAN_TARGET_HELD' }))).toBeNull();
    expect(await readHeldRefusal(json(409, { code: 'APPROVAL_GATE_PENDING' }))).toBeNull();
  });

  it('every other refusal keeps the toast: ILLEGAL_BOARD_MOVE, a 422, a body without the code', async () => {
    expect(await readHeldRefusal(json(409, { code: 'ILLEGAL_BOARD_MOVE', error: 'x' }))).toBeNull();
    expect(
      await readHeldRefusal(json(422, { code: 'APPROVAL_GATE_PENDING', gate: gate() })),
    ).toBeNull();
    expect(await readHeldRefusal(new Response('not json', { status: 409 }))).toBeNull();
  });

  it('does not consume the body — the caller can still read it', async () => {
    const res = json(409, { code: 'ILLEGAL_BOARD_MOVE' });
    await readHeldRefusal(res);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_BOARD_MOVE');
  });
});

function renderCards(held: BoardHeldRefusal | null, close = vi.fn()) {
  render(
    <BoardHeldRefusalProvider value={{ held, close }}>
      <div data-testid="card-a">
        <BoardCardHeldRefusal workItemId="wi_a" />
      </div>
      <div data-testid="card-b">
        <BoardCardHeldRefusal workItemId="wi_b" />
      </div>
    </BoardHeldRefusalProvider>,
  );
  return close;
}

describe('BoardCardHeldRefusal — on the returned card', () => {
  it('draws the line ONLY under the refused card, with Review & approve over the board when decidable', () => {
    renderCards({
      kind: 'gate',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      line: heldLineFromRefusal('done', 'Done', gate()),
    });

    const a = screen.getByTestId('card-a');
    expect(a.textContent).toContain(
      "Status can't be moved to Done directly — a design approval is waiting.",
    );
    expect(screen.getByTestId('card-b').textContent).toBe('');
    expect(screen.getByRole('link', { name: 'Review & approve' }).getAttribute('href')).toBe(
      '/boards?approval=PROD-7&approvalKind=design_result',
    );
  });

  it('a look-only reader gets the name and no button; a merge hold never has one', () => {
    renderCards({
      kind: 'gate',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      line: heldLineFromRefusal('done', 'Done', gate({ canDecide: false })),
    });
    expect(screen.getByTestId('card-a').textContent).toContain('is waiting on Ada Lovelace.');
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();

    renderCards({
      kind: 'gate',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      line: heldLineFromRefusal('done', 'Done', gate({ waitingOn: 'merge', canDecide: true })),
    });
    expect(screen.getByTestId('card-a').textContent).toContain(
      'merging the pull request moves it.',
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('closes on Esc and on a click outside, not on a click inside', () => {
    const close = renderCards({
      kind: 'gate',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      line: heldLineFromRefusal('done', 'Done', gate()),
    });
    fireEvent.mouseDown(screen.getByTestId('status-held-notice'));
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('BoardCardHeldRefusal — the PLAN refusal, in the footer slot (MOTIR-6268)', () => {
  function renderFooter(held: BoardHeldRefusal | null, close = vi.fn()) {
    render(
      <BoardHeldRefusalProvider
        value={{
          held,
          close,
          planHolds: {
            pln_a: { planId: 'pln_a', anchorKey: 'PROD-10', title: 'Import', heldCount: 3 },
          },
          projectName: 'Motir',
        }}
      >
        <div data-testid="under">
          <BoardCardHeldRefusal workItemId="wi_a" />
        </div>
        <div data-testid="footer">
          <BoardCardHeldRefusal workItemId="wi_a" slot="footer" />
        </div>
      </BoardHeldRefusalProvider>,
    );
    return close;
  }

  it('draws the plan name, the sibling count and the shipped plan line — only in the footer slot', () => {
    renderFooter({
      kind: 'plan',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      plan: plan(),
      siblings: 2,
    });
    const footer = screen.getByTestId('footer');
    expect(footer.textContent).toContain('Plan · PROD-10');
    expect(footer.textContent).toContain('2 other items on this board are in this plan.');
    expect(footer.textContent).toContain("Status can't be changed while a plan is open.");
    expect(footer.textContent).toContain('This plan is waiting for approval.');
    expect(screen.getByTestId('under').textContent).toBe('');
    expect(screen.getByRole('link', { name: 'Review plan' }).getAttribute('href')).toBe(
      planRowDestination({ ...plan(), host: '/boards' }).href,
    );
  });

  it('one sibling reads in the singular, none in its own sentence', () => {
    renderFooter({
      kind: 'plan',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      plan: plan(),
      siblings: 1,
    });
    expect(screen.getByTestId('footer').textContent).toContain(
      '1 other item on this board is in this plan.',
    );
    cleanup();
    renderFooter({
      kind: 'plan',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      plan: plan(),
      siblings: 0,
    });
    expect(screen.getByTestId('footer').textContent).toContain(
      'No other item on this board is in this plan.',
    );
  });

  it('a gate refusal never draws in the footer slot', () => {
    renderFooter({
      kind: 'gate',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      line: heldLineFromRefusal('done', 'Done', gate()),
    });
    expect(screen.getByTestId('footer').textContent).toBe('');
    expect(screen.getByTestId('under').textContent).toContain('Status can');
  });

  it('closes on Esc and on a click outside, not on a click inside', () => {
    const close = renderFooter({
      kind: 'plan',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      plan: plan(),
      siblings: 2,
    });
    fireEvent.mouseDown(screen.getByTestId('status-held-notice'));
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('planHoldName — the {name} rule', () => {
  it('anchor key, else title, else the project name', () => {
    const holds = {
      a: { planId: 'a', anchorKey: 'PROD-1', title: 'T', heldCount: 1 },
      b: { planId: 'b', anchorKey: null, title: 'Import rewrite', heldCount: 1 },
      c: { planId: 'c', anchorKey: null, title: '  ', heldCount: 1 },
    };
    expect(planHoldName({ planId: 'a', anchorKey: null }, holds, 'Motir')).toEqual({
      name: 'PROD-1',
      isKey: true,
    });
    expect(planHoldName({ planId: 'b', anchorKey: null }, holds, 'Motir')).toEqual({
      name: 'Import rewrite',
      isKey: false,
    });
    expect(planHoldName({ planId: 'c', anchorKey: null }, holds, 'Motir')).toEqual({
      name: 'Motir',
      isKey: false,
    });
    // A plan the projection did not name falls back to the card's own anchor.
    expect(planHoldName({ planId: 'z', anchorKey: 'PROD-9' }, holds, 'Motir').name).toBe('PROD-9');
  });
});

describe('a card outside any board', () => {
  it('draws nothing, and the default context has nothing to close', () => {
    render(<BoardCardHeldRefusal workItemId="wi_a" />);
    expect(screen.queryByTestId('status-held-notice')).toBeNull();
    expect(NO_BOARD_HELD_REFUSAL.held).toBeNull();
    expect(() => NO_BOARD_HELD_REFUSAL.close()).not.toThrow();
  });
});
