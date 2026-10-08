// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';

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
import type { PlanHeldByPlanDTO } from '@/lib/dto/plans';
import type { BoardPlanHoldSummaryDto } from '@/lib/dto/boards';

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

const plan = (over: Partial<PlanHeldByPlanDTO> = {}): PlanHeldByPlanDTO => ({
  kind: 'plan',
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
            pln_a: {
              kind: 'plan',
              planId: 'pln_a',
              sessionId: null,
              anchorKey: 'PROD-10',
              title: 'Import',
              heldCount: 3,
            },
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

  it('an open SESSION hold names the session, in both the marker and the sibling count (MOTIR-7640)', () => {
    renderFooter({
      kind: 'plan',
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      plan: {
        kind: 'session',
        itemKey: 'PROD-7',
        workItemId: 'wi_a',
        planId: null,
        planStatus: null,
        sessionId: 'pcs_1',
        anchorKey: 'PROD-10',
        holderId: 'u_ada',
        holderName: 'Ada Lovelace',
        heldByViewer: false,
      },
      siblings: 2,
    });
    const footer = screen.getByTestId('footer');
    expect(footer.textContent).toContain('Session · PROD-10');
    expect(footer.textContent).toContain('2 other items on this board are in this session.');
    expect(footer.querySelector('[data-plan-footer]')?.getAttribute('data-plan-footer')).toBe(
      'session:pcs_1',
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
    const holds: Record<string, BoardPlanHoldSummaryDto> = {
      a: {
        kind: 'plan',
        planId: 'a',
        sessionId: null,
        anchorKey: 'PROD-1',
        title: 'T',
        heldCount: 1,
      },
      b: {
        kind: 'plan',
        planId: 'b',
        sessionId: null,
        anchorKey: null,
        title: 'Import rewrite',
        heldCount: 1,
      },
      c: { kind: 'plan', planId: 'c', sessionId: null, anchorKey: null, title: '  ', heldCount: 1 },
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

// Story MOTIR-6575 · MOTIR-6682 — the MARK refusal, per
// `design/boards/board-card--obsolescence.mock.html` panel 3: a marked card dragged
// out of the done category returns, and ONE line opens UNDER it (the gate slot)
// with the mark's own glyph and an Open item door to the item page's field.
describe('the MARK refusal (MOTIR-6682)', () => {
  it('reads the mark off a 409 MARKED_CARD_CANNOT_REOPEN; an off-enum mark is not a held refusal', async () => {
    expect(
      await readHeldRefusal(
        json(409, {
          code: 'MARKED_CARD_CANNOT_REOPEN',
          error: 'x',
          key: 'PROD-1',
          mark: 'outdated',
        }),
      ),
    ).toEqual({ code: 'MARKED_CARD_CANNOT_REOPEN', mark: 'outdated' });
    expect(
      await readHeldRefusal(json(409, { code: 'MARKED_CARD_CANNOT_REOPEN', mark: 'stale' })),
    ).toBeNull();
    expect(await readHeldRefusal(json(409, { code: 'MARKED_CARD_CANNOT_REOPEN' }))).toBeNull();
  });

  it('draws the one line and Open item ONLY under the refused card', () => {
    renderCards({ kind: 'mark', workItemId: 'wi_a', itemKey: 'PROD-1', mark: 'deprecated' });
    const a = screen.getByTestId('card-a');
    expect(within(screen.getByTestId('card-b')).queryByTestId('status-held-notice')).toBeNull();
    const notice = within(a).getByTestId('status-held-notice');
    expect(notice.textContent).toBe(
      'This item is marked Deprecated. Clear the mark to reopen this item.Open item',
    );
    expect(within(notice).getByText('Deprecated').tagName).toBe('STRONG');
    const door = within(notice).getByRole('link', { name: 'Open item' });
    expect(door.getAttribute('href')).toBe('/items/PROD-1#obsolescence-field');
    expect(door.className).not.toContain('--el-accent');
  });

  it('never draws in the plan footer slot', () => {
    render(
      <BoardHeldRefusalProvider
        value={{
          held: { kind: 'mark', workItemId: 'wi_a', itemKey: 'PROD-1', mark: 'outdated' },
          close: vi.fn(),
        }}
      >
        <BoardCardHeldRefusal workItemId="wi_a" slot="footer" />
      </BoardHeldRefusalProvider>,
    );
    expect(screen.queryByTestId('status-held-notice')).toBeNull();
  });

  it('closes on Esc', () => {
    const close = renderCards({
      kind: 'mark',
      workItemId: 'wi_a',
      itemKey: 'PROD-1',
      mark: 'outdated',
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalled();
  });

  it('renders in zh', () => {
    render(
      <BoardHeldRefusalProvider
        value={{
          held: { kind: 'mark', workItemId: 'wi_a', itemKey: 'PROD-1', mark: 'outdated' },
          close: vi.fn(),
        }}
      >
        <BoardCardHeldRefusal workItemId="wi_a" />
      </BoardHeldRefusalProvider>,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByTestId('status-held-notice').textContent).toContain(
      '此工作项已标记为已过时。清除标记后才能重新打开此工作项。',
    );
    screen.getByRole('link', { name: '打开工作项' });
  });
});
