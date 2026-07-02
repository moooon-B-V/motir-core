import { afterEach, describe, expect, it, vi } from 'vitest';

// Subtask 7.22.1 / MOTIR-1457 — the motir-core entry rework.
//
// Two server-side routing contracts, tested without a DOM (we inspect the
// returned React element / the redirect call, not rendered markup):
//   1. The root `app/page.tsx` unconditionally redirects to /sign-in — the
//      marketing hero relocated out, so the root is now just the login door.
//   2. The onboarding group layout gates on `isAiPlanningConfigured()`: a
//      self-host (unconfigured) deployment gets the deferred Connect-Motir-AI
//      gate; a connected deployment falls through to the session gate (bouncing
//      a logged-out visitor to /sign-in with `next=/onboarding`) or renders the
//      children when authed.

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

  it('shows the deferred Connect-Motir-AI gate when AI planning is not configured (self-host)', async () => {
    isAiPlanningConfigured.mockReturnValue(false);

    const result = await OnboardingGroupLayout({ children });

    // The self-host branch returns <ConnectAiGate /> and never touches the session.
    expect(result).toMatchObject({ type: ConnectAiGateStub });
    expect(getSession).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('bounces a logged-out visitor to /sign-in preserving next=/onboarding when configured', async () => {
    isAiPlanningConfigured.mockReturnValue(true);
    getSession.mockResolvedValue(null);

    await expect(OnboardingGroupLayout({ children })).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/sign-in?next=%2Fonboarding');
  });

  it('renders the children for an authed visitor on a connected deployment', async () => {
    isAiPlanningConfigured.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { id: 'u1' } });

    const result = await OnboardingGroupLayout({ children });

    expect(result).toBe(children);
    expect(redirect).not.toHaveBeenCalled();
  });
});
