// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RevisionLog } from '@/components/onboarding/RevisionLog';
import type { PreplanRevisionDTO } from '@/lib/dto/aiPreplan';

afterEach(() => cleanup());

const baseline: PreplanRevisionDTO = {
  version: 1,
  changeReason: null,
  changeKind: 'created',
  diff: null,
  createdAt: '2026-06-20T00:00:00.000Z',
};
const revised: PreplanRevisionDTO = {
  version: 2,
  changeReason: 'you asked to broaden the audience',
  changeKind: 'direct',
  diff: [{ path: 'pitch.headline', kind: 'changed', before: 'Old', after: 'New' }],
  createdAt: '2026-06-21T00:00:00.000Z',
};

describe('RevisionLog', () => {
  it('renders nothing for a baseline-only tier (no revisions yet)', () => {
    const { container } = renderWithIntl(<RevisionLog versions={[baseline]} currentVersion={1} />);
    expect(container.textContent).toBe('');
  });

  it('renders the forward-only timeline newest-first with when / why / kind', () => {
    renderWithIntl(<RevisionLog versions={[revised, baseline]} currentVersion={2} />);
    expect(screen.getByText('Revision history')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('v1')).toBeTruthy();
    expect(screen.getByText('Revised')).toBeTruthy(); // direct revision label
    expect(screen.getByText('First draft')).toBeTruthy(); // baseline label
    expect(screen.getByText('Current')).toBeTruthy(); // v2 is current
    expect(screen.getByText('you asked to broaden the audience')).toBeTruthy();
    // The forward-only assurance copy is present.
    expect(screen.getByText(/only moves forward/i)).toBeTruthy();
  });

  it('expands a revision to reveal its diff', () => {
    renderWithIntl(<RevisionLog versions={[revised, baseline]} currentVersion={2} />);
    // Diff hidden until expanded.
    expect(screen.queryByText('Pitch › Headline')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show what changed/i }));
    expect(screen.getByText('Pitch › Headline')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
  });

  it('has NO rollback / restore / revert / undo CONTROL (forward-only)', () => {
    renderWithIntl(<RevisionLog versions={[revised, baseline]} currentVersion={2} />);
    // No actionable control to reverse a revision — neither a button nor a link.
    // (The copy itself may SAY "no undo"; what must be absent is an affordance.)
    expect(screen.queryByRole('button', { name: /rollback|restore|revert|undo/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /rollback|restore|revert|undo/i })).toBeNull();
    // The only interactive control in the log is the diff expand/collapse toggle.
    const buttons = screen.getAllByRole('button');
    expect(buttons.every((b) => /show what changed|hide changes/i.test(b.textContent ?? ''))).toBe(
      true,
    );
  });
});
