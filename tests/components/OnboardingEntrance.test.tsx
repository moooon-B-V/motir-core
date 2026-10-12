// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The onboarding ENTRANCE fork (Subtask 7.22.4 / MOTIR-1462). The card's UI AC:
// "/onboarding renders the two-option fork (per 7.22.3) and routes: start-fresh →
// discovery (seeded); existing → 7.15 wizard / 7.17." This unit renders the two
// designed panels and asserts the fork's shape + destinations; the routing itself
// (Start planning → /onboarding/discovery, Migrate → /onboarding/migrate) is proven
// end-to-end in tests/e2e/onboarding-entrance.spec.ts.
//
// `startPlanningAction` is a `'use server'` action that imports the `server-only`
// pendingIdea seam, which throws in happy-dom — so we mock the actions module.
// The form's action is opaque to this render (nothing submits here); the unit
// only checks the composed UI. (getByRole/getByText THROW when absent, so the
// query itself is the assertion — the repo has no jest-dom matchers.)
vi.mock('@/app/(onboarding)/onboarding/actions', () => ({
  startPlanningAction: vi.fn(),
}));

import { OnboardingEntrance } from '@/components/onboarding/OnboardingEntrance';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';

afterEach(cleanup);

describe('OnboardingEntrance', () => {
  it('renders the default panel: idea box + Start + the secondary import row', () => {
    renderWithIntl(<OnboardingEntrance carriedIdea={null} />);

    screen.getByRole('heading', { name: 'Vibe the project' });
    screen.getByText('Welcome to Motir');

    // The "See how Motir works" explainer link is part of the header.
    expect(screen.getByRole('link', { name: /see how motir works/i }).getAttribute('href')).toBe(
      '/onboarding/how-it-works',
    );

    // The idea box is empty and labelled "What are you building?".
    const idea = screen.getByRole('textbox', {
      name: 'What are you building?',
    }) as HTMLTextAreaElement;
    expect(idea.value).toBe('');

    // Primary CTA is a submit button (drives the form → startPlanningAction).
    const start = screen.getByRole('button', { name: /^start$/i }) as HTMLButtonElement;
    expect(start.type).toBe('submit');

    // The secondary migrate row is a real link to the migrate wizard.
    screen.getByText('OR');
    const migrateLink = screen.getByRole('link', {
      name: /already have a project\?/i,
    });
    expect(migrateLink.getAttribute('href')).toBe('/onboarding/migrate');
  });

  it('heads the page with the onboarding brand bar: the real lockup, not a Sparkles tile', () => {
    // MOTIR-8252 — the inline lavender tile + `Sparkles` + bare "Motir" became
    // `OnboardingBrandBar`. The entrance's ONE remaining `Sparkles` is the
    // eyebrow chip's own icon (which the entrance code card, MOTIR-8253, retires
    // with the eyebrow).
    const { container } = renderWithIntl(<OnboardingEntrance carriedIdea={null} />);
    const bar = container.querySelector('header[data-onboarding-brand-bar]')!;
    expect(bar).not.toBeNull();
    const home = screen.getByRole('link', { name: 'Motir' });
    expect(bar.contains(home)).toBe(true);
    expect(home.querySelector('.brand-lockup svg path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);

    const sparkles = container.querySelectorAll('.lucide-sparkles');
    expect(sparkles).toHaveLength(1);
    expect(sparkles[0]!.parentElement!.textContent).toBe('Welcome to Motir');
  });

  it('renders the carried-over panel: pre-filled idea, Continue CTA, NO migrate row', () => {
    const idea = 'A leave-tracking app for a 20-person startup.';
    renderWithIntl(<OnboardingEntrance carriedIdea={idea} />);

    screen.getByRole('heading', { name: 'Ready when you are' });
    screen.getByText('Carried over from your idea');

    // The explainer link shows in the carried-over panel too.
    screen.getByRole('link', { name: /see how motir works/i });

    // The preserved idea pre-fills the box.
    expect(
      (screen.getByRole('textbox', { name: 'What are you building?' }) as HTMLTextAreaElement)
        .value,
    ).toBe(idea);

    // The CTA becomes "Continue with this idea".
    screen.getByRole('button', { name: /continue with this idea/i });

    // Arriving with an idea in hand = starting fresh: the migrate path is dropped.
    expect(screen.queryByRole('link', { name: /already have a project\?/i })).toBeNull();
    expect(screen.queryByText('OR')).toBeNull();
  });
});
