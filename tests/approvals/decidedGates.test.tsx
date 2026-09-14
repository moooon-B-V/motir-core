// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { announceGateDecided, useDecidedGateState } from '@/lib/approvals/decidedGates';

// THE DECIDED-GATE SIGNAL (Story MOTIR-5214 · Subtask MOTIR-5225) — how a decision
// made in the approval overlay reaches the To-approve row's client island
// (`design/workbench/design-notes.md` § 22 planning flag 2). The store is
// module-level, as it is in the product, so every case uses its own gate id.

function Probe({ gateId }: { gateId: string }) {
  const state = useDecidedGateState(gateId);
  return <span data-testid={gateId}>{state ?? 'none'}</span>;
}

afterEach(cleanup);

describe('the decided-gate signal (MOTIR-5225)', () => {
  it('reads null for a gate nobody decided', () => {
    render(<Probe gateId="g-none" />);
    expect(screen.getByTestId('g-none').textContent).toBe('none');
  });

  it('wakes a mounted watcher with the state its gate reached — and only that gate', () => {
    render(
      <>
        <Probe gateId="g-a" />
        <Probe gateId="g-b" />
      </>,
    );

    act(() => announceGateDecided('g-a', 'approved'));

    expect(screen.getByTestId('g-a').textContent).toBe('approved');
    expect(screen.getByTestId('g-b').textContent).toBe('none');
  });

  it('does not treat `awaiting` as a decision', () => {
    render(<Probe gateId="g-await" />);
    act(() => announceGateDecided('g-await', 'awaiting'));
    expect(screen.getByTestId('g-await').textContent).toBe('none');
  });

  it('renders null on the server, whatever this tab has seen', () => {
    act(() => announceGateDecided('g-server', 'changes_requested'));
    expect(renderToString(<Probe gateId="g-server" />)).toContain('none');
  });
});
