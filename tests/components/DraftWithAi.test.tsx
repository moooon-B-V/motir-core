// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  DraftWithAiButton,
  DraftGateNotice,
  DraftErrorNotice,
} from '@/components/issues/DraftWithAi';

// Component tests use happy-dom + NO jest-dom matchers (prodect convention) — so
// assertions read DOM directly (textContent / attributes), never toBeDisabled().
afterEach(cleanup);

describe('DraftWithAiButton', () => {
  it('idle + connected + no draft → "Draft with AI", enabled, no gate tooltip', () => {
    render(
      <DraftWithAiButton
        phase="idle"
        hasDraft={false}
        aiConfigured
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('Draft with AI');
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.getAttribute('title')).toBeNull();
  });

  it('idle + a prior draft → "Regenerate"', () => {
    render(
      <DraftWithAiButton phase="idle" hasDraft aiConfigured onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(screen.getByRole('button').textContent).toContain('Regenerate');
  });

  it('start fires onStart when clicked', () => {
    const onStart = vi.fn();
    render(
      <DraftWithAiButton
        phase="idle"
        hasDraft={false}
        aiConfigured
        onStart={onStart}
        onStop={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('cloud-gated (not connected) → disabled with the connect tooltip', () => {
    render(
      <DraftWithAiButton
        phase="idle"
        hasDraft={false}
        aiConfigured={false}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.getAttribute('title')).toBe('Connect Motir AI to draft with AI');
  });

  it('drafting → shows "Drafting…", a Stop affordance, and clicking calls onStop', () => {
    const onStop = vi.fn();
    render(
      <DraftWithAiButton
        phase="drafting"
        hasDraft={false}
        aiConfigured
        onStart={vi.fn()}
        onStop={onStop}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Stop' });
    expect(btn.textContent).toContain('Drafting…');
    fireEvent.click(btn);
    expect(onStop).toHaveBeenCalledOnce();
  });
});

describe('DraftGateNotice', () => {
  it('renders the not-configured heading + a Connect Motir AI docs link', () => {
    render(<DraftGateNotice />);
    expect(screen.getByText("AI drafting isn't configured")).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Connect Motir AI' });
    expect(link.getAttribute('href')).toContain('ai-boundary.md');
  });
});

describe('DraftErrorNotice', () => {
  it('renders the failure heading and wires Try again / Dismiss', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<DraftErrorNotice onRetry={onRetry} onDismiss={onDismiss} />);
    expect(screen.getByText("Couldn't finish the draft")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
