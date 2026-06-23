// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { AiPaywall, resolveAiPaywall } from '@/components/ai/AiPaywall';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';

// Component + policy test for the AI-boundary paywall (Subtask 8.1.8, design
// panel 7). resolveAiPaywall is the pure decision (which face to show, or none);
// the render assertions prove each face composes the design's copy + the upgrade
// CTA's destination route.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

function access(over: Partial<AiAccessDTO> = {}): AiAccessDTO {
  return {
    applicable: true,
    organizationId: 'org_1',
    organizationName: 'moooon',
    canManageBilling: true,
    hasPaidAiPlan: true,
    balance: 0,
    tierName: 'Standard',
    tierAllotment: 2000,
    renewsAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

afterEach(cleanup);

describe('resolveAiPaywall (policy)', () => {
  it('shows nothing when not triggered and not blocked', () => {
    expect(resolveAiPaywall(access({ balance: 1420 }), false)).toBeNull();
  });

  it('shows nothing off-cloud (not applicable), even on a reactive trigger', () => {
    expect(resolveAiPaywall(access({ applicable: false }), true)).not.toBeNull();
    // applicable:false → the fallback owner prompt fires only on a real trigger,
    // never proactively:
    expect(resolveAiPaywall(access({ applicable: false }), false)).toBeNull();
  });

  it('a paid org out of credits → out_of_credits / owner', () => {
    expect(resolveAiPaywall(access({ hasPaidAiPlan: true, balance: 0 }), false)).toMatchObject({
      reason: 'out_of_credits',
      variant: 'owner',
    });
  });

  it('a free org that never bought AI → tier_gate / owner', () => {
    expect(resolveAiPaywall(access({ hasPaidAiPlan: false, balance: 0 }), false)).toMatchObject({
      reason: 'tier_gate',
      variant: 'owner',
    });
  });

  it('a non-owner is always the member variant', () => {
    expect(resolveAiPaywall(access({ canManageBilling: false }), true)).toMatchObject({
      variant: 'member',
    });
  });

  it('a reactive trigger with no resolvable org falls back to a generic owner prompt', () => {
    expect(resolveAiPaywall(null, true)).toMatchObject({
      reason: 'out_of_credits',
      variant: 'owner',
      organizationName: null,
    });
  });
});

describe('AiPaywall (render)', () => {
  it('out-of-credits owner: pauses, NAMES the limit, links Upgrade to the billing route', () => {
    render(<AiPaywall access={access({ hasPaidAiPlan: true, balance: 0 })} />);
    expect(screen.getByText("Planning is paused — you're out of credits")).toBeTruthy();
    // AC1: the limit is NAMED (tier + allotment).
    expect(screen.getByText(/2,000 Standard credits/)).toBeTruthy();
    const upgrade = screen.getByRole('link', { name: /Upgrade plan/ });
    expect(upgrade.getAttribute('href')).toBe('/settings/organization/billing');
    expect(screen.getByRole('link', { name: /Buy credit top-up/ })).toBeTruthy();
  });

  it('tier-gate owner: "AI is a paid feature" with a See-plans CTA', () => {
    render(<AiPaywall access={access({ hasPaidAiPlan: false, balance: 0 })} />);
    expect(screen.getByText('AI planning is a paid feature')).toBeTruthy();
    const cta = screen.getByRole('link', { name: 'See Motir AI plans' });
    expect(cta.getAttribute('href')).toBe('/settings/organization/billing');
  });

  it('member variant: routed to an owner, no actionable navigation CTA', () => {
    render(<AiPaywall access={access({ canManageBilling: false, balance: 0 })} />);
    expect(screen.getByText('AI is out of credits for this org')).toBeTruthy();
    // "Ask an owner" is presentational guidance — a button, not a link.
    expect(screen.getByRole('button', { name: 'Ask an owner to upgrade' })).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders nothing when AI is available (not blocked)', () => {
    const { container } = render(<AiPaywall access={access({ balance: 1420 })} />);
    expect(container.textContent).toBe('');
  });
});
