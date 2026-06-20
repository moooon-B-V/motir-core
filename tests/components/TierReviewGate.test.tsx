// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { TierReviewGate } from '@/components/onboarding/TierReviewGate';
import type { DirectionDocView } from '@/lib/onboarding/directionDoc';

afterEach(() => cleanup());

const doc: DirectionDocView = {
  kind: 'discovery',
  contentMd: '# Discovery (Tier 1)\n\nA focused invoicing tool for freelancers.',
  version: 1,
};

describe('TierReviewGate', () => {
  it('renders the embedded read-only doc + the Continue gate', () => {
    renderWithIntl(
      <TierReviewGate
        doc={doc}
        availableKinds={['vision']}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    // the step header + the doc body (834's DirectionDocView, embedded)
    expect(screen.getByText('Pre-plan · building your direction')).toBeTruthy();
    expect(screen.getByText(/A focused invoicing tool/)).toBeTruthy();
    // the gate note makes "Continue = navigation, nothing locks" explicit
    expect(screen.getByText(/nothing locks until your plan generates/)).toBeTruthy();
  });

  it('fires Continue and Back', () => {
    const onContinue = vi.fn();
    const onBack = vi.fn();
    renderWithIntl(
      <TierReviewGate doc={doc} availableKinds={[]} onBack={onBack} onContinue={onContinue} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Looks good — continue/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Back' })[0]!);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('disables Continue while a turn is in flight', () => {
    renderWithIntl(
      <TierReviewGate doc={doc} availableKinds={[]} onBack={vi.fn()} onContinue={vi.fn()} busy />,
    );
    const cont = screen.getByRole('button', { name: /Looks good — continue/ }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
  });
});
