// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';
import { MotirAiUnavailableError } from '@/lib/ai/errors';

// MOTIR-8255 — the onboarding direction-doc page gains its first brand position
// (design/ai-chat/design-notes.md § 2026-10-12, Panel 6): a slim row with the
// lockup at 24 px, not a link, above the doc in the same `max-w-[60rem]` column.
// It is added on the `(onboarding)` wrapper only, so the in-shell
// `/direction/[tier]` — which renders the same shared `DirectionDocFullPage` —
// gains nothing. The shared component is stubbed to record the props it gets.

const { notFound, redirect } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  notFound,
  redirect,
}));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: vi.fn() }));

const docProps = vi.fn();
vi.mock('@/app/(authed)/direction/[tier]/_components/DirectionDocFullPage', () => ({
  DirectionDocFullPage: (p: {
    tier: string;
    error: boolean;
    origin?: string;
    doc?: unknown;
    availableDocs?: unknown;
  }) => {
    docProps(p);
    return <article data-testid="doc">{p.error ? 'error' : p.tier}</article>;
  },
}));
const { getSession, getActiveProject } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
const getPreplanState = vi.fn();
vi.mock('@/lib/services/aiPreplanService', () => ({
  aiPreplanService: { getPreplanState: (...a: unknown[]) => getPreplanState(...a) },
}));
vi.mock('@/lib/onboarding/preplanClient', () => ({
  findTierDoc: (_s: unknown, tier: string) => ({ kind: tier }),
  producedTierKinds: () => ['vision'],
}));

import OnboardingDirectionDocPage from '@/app/(onboarding)/onboarding/direction/[tier]/page';
import DirectionDocPage from '@/app/(authed)/direction/[tier]/page';

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue({ projectId: 'p1', workspaceId: 'w1' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPage(
  Page: (a: { params: Promise<{ tier: string }> }) => Promise<React.ReactElement>,
) {
  const el = await Page({ params: Promise.resolve({ tier: 'vision' }) });
  return renderWithIntl(el);
}

describe('the onboarding direction-doc page', () => {
  it('renders the lockup in a brand row above the doc, which keeps origin="onboarding"', async () => {
    getPreplanState.mockResolvedValue({ catalog: null });
    const { container, getByTestId } = await renderPage(OnboardingDirectionDocPage);
    const row = container.querySelector('[data-onboarding-brand-bar]') as HTMLElement;
    expect(row).not.toBeNull();
    const lockup = row.querySelector('.brand-lockup') as HTMLElement;
    expect(lockup.style.getPropertyValue('--brand-size')).toBe('24px');
    expect(lockup.querySelector('svg path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(lockup.querySelector('.brand-word')!.textContent).toBe('Motir');
    // not a link, and no second Back: the doc's own Back returns to /onboarding
    expect(row.querySelector('a')).toBeNull();
    // its trailing end is the language control (MOTIR-8286)
    expect(row.querySelector('[role="combobox"]')).not.toBeNull();
    // the row comes first in the doc's own column
    const column = row.parentElement as HTMLElement;
    expect(column.className).toContain('max-w-[60rem]');
    expect(row.nextElementSibling).toBe(getByTestId('doc'));
    expect(docProps).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'vision', origin: 'onboarding', error: false }),
    );
  });

  it('keeps the brand row on the error state, which renders as before', async () => {
    getPreplanState.mockRejectedValue(new MotirAiUnavailableError('down'));
    const { container, getByTestId } = await renderPage(OnboardingDirectionDocPage);
    expect(container.querySelector('[data-onboarding-brand-bar]')).not.toBeNull();
    expect(getByTestId('doc').textContent).toBe('error');
    expect(docProps).toHaveBeenCalledWith(
      expect.objectContaining({ error: true, origin: 'onboarding' }),
    );
  });
});

describe('the onboarding direction-doc page — its gates (MOTIR-8256)', () => {
  const page = (tier: string) => OnboardingDirectionDocPage({ params: Promise.resolve({ tier }) });

  it('hands the doc and the produced tiers to the shared page when the state loads', async () => {
    getPreplanState.mockResolvedValue({ catalog: null });
    await renderPage(OnboardingDirectionDocPage);
    expect(docProps).toHaveBeenCalledWith(
      expect.objectContaining({ doc: { kind: 'vision' }, availableDocs: ['vision'] }),
    );
  });

  it('404s an unknown tier', async () => {
    await expect(page('not-a-tier')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('sends a signed-out reader to sign-in', async () => {
    getSession.mockResolvedValue(null);
    await expect(page('vision')).rejects.toThrow('NEXT_REDIRECT /sign-in');
  });

  it('sends a reader with no active project to the no-project landing', async () => {
    getActiveProject.mockResolvedValue(null);
    await expect(page('vision')).rejects.toThrow(/NEXT_REDIRECT \//);
    expect(redirect).not.toHaveBeenCalledWith('/sign-in');
  });

  it('rethrows an error that is not the planner being unavailable', async () => {
    getPreplanState.mockRejectedValue(new Error('boom'));
    await expect(page('vision')).rejects.toThrow('boom');
  });
});

describe('the in-shell direction-doc page', () => {
  it('renders no onboarding brand row', async () => {
    getPreplanState.mockResolvedValue({ catalog: null });
    const { container } = await renderPage(DirectionDocPage);
    expect(container.querySelector('[data-onboarding-brand-bar]')).toBeNull();
    expect(container.querySelector('.brand-lockup')).toBeNull();
  });
});
