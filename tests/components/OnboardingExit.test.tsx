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
//
// MOTIR-3173 — and the destination is `/home`, the signed-in landing. This file
// already exercised the exit through a real click, and it still went stale: it
// asserted the LITERAL `/dashboard` because that was the landing when MOTIR-1488
// was written, so when MOTIR-2654 and MOTIR-2921 moved both credential flows to
// `/home`, the assertion moved the wrong way — it kept the old destination green.
// A test that pins a literal is a comment with a runner attached unless it also
// says WHY that literal is the answer, so the constant below carries the reason:
// the destination is whatever post-auth lands on (`docs/decisions/home-scope.md`
// §2.3 — `sign-in/page.tsx:78`, `sign-up/page.tsx:80`), and if that moves again,
// this file moves with it rather than holding the product to a retired route.

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

// The app's signed-in landing — where both credential flows default to
// (`docs/decisions/home-scope.md` §2.3) and therefore where a person who steps
// out of onboarding belongs. `/home` resolves the ACTIVE project and renders the
// shipped create-first door when there is none (§2.2), so it is a safe
// destination for an actor who has just described a project and may not have one
// yet.
const HOME = '/home';
// The retired landing. `/dashboard` keeps its route and its own rail entry and is
// reached by navigating to it; nothing lands a reader there any more.
const RETIRED_LANDING = '/dashboard';

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
    expect(push).toHaveBeenCalledWith(HOME);
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
    expect(push).toHaveBeenCalledWith(HOME);
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

describe('the exit destination is the signed-in landing (MOTIR-3173)', () => {
  // Asserted off the RENDERED affordance — a real click on the "Save & exit"
  // button in the top bar — and never off `ONBOARDING_EXIT_PATH`. The bar draws
  // one button, but the exit reaches `router.push` down TWO paths (direct, and
  // through the unsent-draft confirm), and a test reading the constant would
  // prove one thing about both.
  it.each([
    ['with nothing unsent — a direct exit', false],
    ['through the unsent-draft confirm', true],
  ])('lands on the home, not the retired landing: %s', async (_name, viaConfirm) => {
    stubFetch();
    renderWithIntl(<DiscoveryOnboarding initialIdea="An invoicing app" projectName="PayFlow" />);

    await screen.findByRole('button', { name: EXIT });
    if (viaConfirm) {
      const input = screen.getByLabelText('Reply, or ask a question…') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'wait — one more thing' } });
    }
    fireEvent.click(screen.getByRole('button', { name: EXIT }));
    if (viaConfirm) {
      await screen.findByText(CONFIRM_TITLE);
      fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    }

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(HOME);
    // The defect this card closes: the same click used to land here, under a
    // comment calling `/dashboard` "the app's default authed landing".
    expect(push).not.toHaveBeenCalledWith(RETIRED_LANDING);
  });
});
