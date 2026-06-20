// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DiscoveryChatRail } from '@/components/onboarding/DiscoveryChatRail';
import type { ChatTurn } from '@/lib/onboarding/discoveryLoop';

afterEach(() => cleanup());

const turns: ChatTurn[] = [
  { id: 't0', role: 'user', text: 'An invoicing tool for freelancers' },
  { id: 't1', role: 'assistant', text: 'Who is it for?' },
];

const baseProps = {
  turns,
  working: null,
  isStreaming: false,
  pendingAsk: null,
  canSkip: false,
  error: null,
  onSend: vi.fn(),
  onDismissError: vi.fn(),
};

describe('DiscoveryChatRail', () => {
  it('renders the conversation turns', () => {
    renderWithIntl(<DiscoveryChatRail {...baseProps} onSend={vi.fn()} />);
    expect(screen.getByText('An invoicing tool for freelancers')).toBeTruthy();
    expect(screen.getByText('Who is it for?')).toBeTruthy();
  });

  it('shows the drafting indicator while the conductor works', () => {
    renderWithIntl(
      <DiscoveryChatRail
        {...baseProps}
        working={{ phase: 'drafting', tier: 'vision' }}
        isStreaming
      />,
    );
    expect(screen.getByText('Drafting now…')).toBeTruthy();
  });

  it('submits a free-form turn through onSend', () => {
    const onSend = vi.fn();
    renderWithIntl(<DiscoveryChatRail {...baseProps} onSend={onSend} />);
    const input = screen.getByLabelText('Reply, or ask a question…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'It chases late payers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('It chases late payers');
  });

  it('renders the blocking validate-early decision and sends the canned reply', () => {
    const onSend = vi.fn();
    renderWithIntl(
      <DiscoveryChatRail
        {...baseProps}
        pendingAsk={{ recommendation: 'prove it' }}
        onSend={onSend}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Prove demand first/ }));
    expect(onSend).toHaveBeenCalledWith(
      "Let's prove demand first — build the marketing site and waitlist before the product.",
    );
  });

  it('hides the validate-early decision while a turn is streaming', () => {
    renderWithIntl(
      <DiscoveryChatRail {...baseProps} pendingAsk={{ recommendation: 'prove it' }} isStreaming />,
    );
    expect(screen.queryByRole('button', { name: /Prove demand first/ })).toBeNull();
  });

  it('offers an optional-tier Skip as a chat decision', () => {
    const onSend = vi.fn();
    renderWithIntl(<DiscoveryChatRail {...baseProps} canSkip onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /Skip it/ }));
    expect(onSend).toHaveBeenCalledWith("Let's skip that step and move on.");
  });
});
