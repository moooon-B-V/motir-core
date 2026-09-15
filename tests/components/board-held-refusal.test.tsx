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
  type BoardHeldRefusal,
} from '@/app/(authed)/boards/_components/BoardHeldRefusal';
import { heldLineFromRefusal, readHeldRefusal } from '@/components/issues/heldRefusal';
import type { ApprovalGatePendingPayloadDTO } from '@/lib/dto/approvalGate';

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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('readHeldRefusal — the ONE branch', () => {
  it('reads the gate off a 409 APPROVAL_GATE_PENDING', async () => {
    expect(
      await readHeldRefusal(json(409, { code: 'APPROVAL_GATE_PENDING', gate: gate() })),
    ).toEqual(gate());
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
      workItemId: 'wi_a',
      itemKey: 'PROD-7',
      line: heldLineFromRefusal('done', 'Done', gate({ canDecide: false })),
    });
    expect(screen.getByTestId('card-a').textContent).toContain('is waiting on Ada Lovelace.');
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();

    renderCards({
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

describe('a card outside any board', () => {
  it('draws nothing, and the default context has nothing to close', () => {
    render(<BoardCardHeldRefusal workItemId="wi_a" />);
    expect(screen.queryByTestId('status-held-notice')).toBeNull();
    expect(NO_BOARD_HELD_REFUSAL.held).toBeNull();
    expect(() => NO_BOARD_HELD_REFUSAL.close()).not.toThrow();
  });
});
