// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DiscoveryOnboarding } from '@/components/onboarding/DiscoveryOnboarding';

// MOTIR-1488 — the onboarding window must carry a "Save & exit" affordance on
// every step that returns the user to the app WITHOUT losing progress (the tier
// state is persisted server-side). An unsent composer message is the only thing
// exit could drop, so a light confirm guards that case only.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

// The mount-time Server Action that clears the preserved-idea cookie — `'use
// server'` + next/headers, unusable in a unit render.
vi.mock('@/app/(onboarding)/onboarding/actions', () => ({
  clearPendingIdeaAction: vi.fn(),
}));

const okJson = (body: unknown) => ({ ok: true, json: async () => body });

// A FRESH visit (carries an idea) paints the hub immediately — no resume-hydration
// placeholder — so the chat rail + top bar are on screen at once.
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/api/ai/pre-plan')) {
        return Promise.resolve(okJson({ session: null, docs: [], catalog: null }));
      }
      if (u.includes('/api/canvas-layout')) {
        return Promise.resolve(okJson({ layout: { positions: [] } }));
      }
      if (u.includes('/api/ai/access')) return Promise.resolve({ ok: false });
      return Promise.resolve(okJson({}));
    }),
  );
}

const EXIT = 'Save & exit';
const CONFIRM_TITLE = 'Leave onboarding?';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
});

describe('DiscoveryOnboarding — Save & exit (MOTIR-1488)', () => {
  it('shows a "Save & exit" affordance and, with no unsent text, returns to the app directly', async () => {
    stubFetch();
    renderWithIntl(<DiscoveryOnboarding initialIdea="An invoicing app" projectName="PayFlow" />);

    const exit = await screen.findByRole('button', { name: EXIT });
    expect(exit).toBeTruthy();
    // The project name is shown in the bar.
    expect(screen.getByText(/PayFlow/)).toBeTruthy();

    fireEvent.click(exit);
    // No confirm (nothing unsent) — a direct navigation to the app home.
    expect(screen.queryByText(CONFIRM_TITLE)).toBeNull();
    expect(push).toHaveBeenCalledWith('/dashboard');
  });

  it('confirms before discarding an UNSENT composer message, then leaves on confirm', async () => {
    stubFetch();
    renderWithIntl(<DiscoveryOnboarding initialIdea="An invoicing app" projectName="PayFlow" />);

    await screen.findByRole('button', { name: EXIT });
    // Type an unsent message into the composer (controlled — lifted to the shell).
    const input = screen.getByLabelText('Reply, or ask a question…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wait — one more thing' } });

    fireEvent.click(screen.getByRole('button', { name: EXIT }));
    // A guard appears instead of navigating.
    expect(await screen.findByText(CONFIRM_TITLE)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(push).toHaveBeenCalledWith('/dashboard');
  });

  it('keeps planning (no navigation) when the exit guard is dismissed', async () => {
    stubFetch();
    renderWithIntl(<DiscoveryOnboarding initialIdea="An invoicing app" projectName="PayFlow" />);

    await screen.findByRole('button', { name: EXIT });
    const input = screen.getByLabelText('Reply, or ask a question…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hold on' } });
    fireEvent.click(screen.getByRole('button', { name: EXIT }));

    await screen.findByText(CONFIRM_TITLE);
    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));
    await waitFor(() => expect(screen.queryByText(CONFIRM_TITLE)).toBeNull());
    expect(push).not.toHaveBeenCalled();
  });
});
