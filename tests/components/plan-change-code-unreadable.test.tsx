// @vitest-environment happy-dom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  CodeUnreadableAskNotice,
  CodeUnreadableDeclinedTurn,
} from '@/components/planning/CodeUnreadableTurn';

// THE OUTAGE FACE OF A PLANNING TURN (Story MOTIR-8136 · MOTIR-8141), drawn on its own in
// both faces and in the retry states: information register (a `status` notice), the exact
// catalogue words, and Try again only where the rail passes it.

afterEach(() => cleanup());

const PLAN_BODY =
  "I can't read your code right now, so I haven't changed your plan. Motir is on it.";
const MARKER = 'Nothing was written — your plan is unchanged.';
const ASK_NOTICE =
  "I couldn't read your code for this answer. Treat anything about the code here as unconfirmed.";

describe('CodeUnreadableDeclinedTurn', () => {
  it('draws the notice, the marker line and an enabled Try again', () => {
    const onRetry = vi.fn();
    renderWithIntl(<CodeUnreadableDeclinedTurn retry={{ onRetry, disabled: false }} />);
    expect(screen.getByRole('status').textContent).toContain(PLAN_BODY);
    expect(screen.getByTestId('plan-change-code-unreadable-marker').textContent).toBe(MARKER);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables Try again while a run is busy', () => {
    renderWithIntl(<CodeUnreadableDeclinedTurn retry={{ onRetry: vi.fn(), disabled: true }} />);
    expect(
      (screen.getByTestId('plan-change-code-unreadable-retry') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('keeps the notice and marker but no button on an earlier turn', () => {
    renderWithIntl(<CodeUnreadableDeclinedTurn retry={null} />);
    expect(screen.getByRole('status').textContent).toContain(PLAN_BODY);
    expect(screen.getByTestId('plan-change-code-unreadable-marker')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-code-unreadable-retry')).toBeNull();
  });
});

describe('CodeUnreadableAskNotice', () => {
  it('draws the answer notice as a status', () => {
    renderWithIntl(<CodeUnreadableAskNotice />);
    expect(screen.getByRole('status').textContent).toContain(ASK_NOTICE);
  });
});
