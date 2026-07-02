import { afterEach, describe, expect, it, vi } from 'vitest';

// Subtask 7.22.1 / MOTIR-1457 — the motir-core entry rework.
//
// Two server-side routing contracts, tested without a DOM (we inspect the
// returned React element / the redirect call, not rendered markup):
//   1. The root `app/page.tsx` unconditionally redirects to /sign-in — the
//      marketing hero relocated out, so the root is now just the login door.
//   2. The onboarding group layout shows the deferred Connect-Motir-AI gate ONLY
//      when the self-host opt-in flag (MOTIR_SELFHOST_CONNECT_GATE) is set AND AI
//      planning isn't configured; otherwise it falls through to the session gate
//      (bouncing a logged-out visitor to /sign-in with `next=/onboarding`) or
//      renders the children when authed. Default (flag off) → onboarding proceeds,
//      so the shared MOTIR_AI env / authed-shell AI affordances stay untouched.

// `redirect()` throws in Next so control never falls through; mirror that with a
// tagged sentinel we can assert on.
class RedirectError extends Error {
  constructor(public to: string) {
    super(`REDIRECT:${to}`);
  }
}
const redirect = vi.fn((to: string) => {
  throw new RedirectError(to);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

const getSession = vi.fn();
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));

const isAiPlanningConfigured = vi.fn();
vi.mock('@/lib/ai/planningConfig', () => ({
  isAiPlanningConfigured: () => isAiPlanningConfigured(),
}));

// Sentinel for ConnectAiGate so we can assert the layout returned IT without
// rendering the real (translation-reading) component.
function ConnectAiGateStub() {
  return null;
}
vi.mock('@/app/_components/ConnectAiGate', () => ({ ConnectAiGate: ConnectAiGateStub }));

import HomePage from '@/app/page';
import OnboardingGroupLayout from '@/app/(onboarding)/layout';

afterEach(() => {
  vi.clearAllMocks();
});

describe('root page (7.22.1)', () => {
  it('redirects to /sign-in — no marketing hero at root', () => {
    expect(() => HomePage()).toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/sign-in');
  });
});

describe('onboarding layout self-host gate (7.22.1)', () => {
  const children = 'ONBOARDING_CHILDREN';
  const FLAG = 'MOTIR_SELFHOST_CONNECT_GATE';
  const prevFlag = process.env[FLAG];

  afterEach(() => {
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
  });

  it('shows the deferred Connect-Motir-AI gate when the self-host flag is set and AI is not configured', async () => {
    process.env[FLAG] = '1';
    isAiPlanningConfigured.mockReturnValue(false);

    const result = await OnboardingGroupLayout({ children });

    // The self-host branch returns <ConnectAiGate /> and never touches the session.
    expect(result).toMatchObject({ type: ConnectAiGateStub });
    expect(getSession).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does NOT gate (proceeds to the session check) when the flag is off, even if AI is unconfigured', async () => {
    delete process.env[FLAG];
    isAiPlanningConfigured.mockReturnValue(false);
    getSession.mockResolvedValue({ user: { id: 'u1' } });

    const result = await OnboardingGroupLayout({ children });

    // Default: no gate — onboarding proceeds. The MOTIR_AI env is never consulted
    // for the shell's sake, so a self-host that opted in but HAS AI still reaches
    // discovery; here the flag is simply off.
    expect(result).toBe(children);
  });

  it('bounces a logged-out visitor to /sign-in preserving next=/onboarding', async () => {
    delete process.env[FLAG];
    getSession.mockResolvedValue(null);

    await expect(OnboardingGroupLayout({ children })).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/sign-in?next=%2Fonboarding');
  });

  it('renders the children for an authed visitor', async () => {
    delete process.env[FLAG];
    getSession.mockResolvedValue({ user: { id: 'u1' } });

    const result = await OnboardingGroupLayout({ children });

    expect(result).toBe(children);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('with the flag set but AI configured, still reaches discovery (no gate)', async () => {
    process.env[FLAG] = '1';
    isAiPlanningConfigured.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { id: 'u1' } });

    const result = await OnboardingGroupLayout({ children });

    expect(result).toBe(children);
  });
});
