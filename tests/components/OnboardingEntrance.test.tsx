// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The onboarding ENTRANCE fork (Subtask 7.22.4 / MOTIR-1462), re-laid by
// MOTIR-8253 onto the vibe layout (`design/onboarding-entrance/
// onboarding-entrance--vibe-layout.mock.html`, design-notes.md § "2026-10-11"
// and Revisions 1–2): a full-width hero whose control is the idea box, and ONE
// import section band under it. This unit renders the two designed panels and
// asserts the fork's shape + destinations; the routing itself (Start →
// /onboarding/discovery, the import door → /onboarding/migrate) is proven end to
// end in tests/e2e/onboarding-entrance.spec.ts.
//
// `startPlanningAction` is a `'use server'` action that imports the `server-only`
// pendingIdea seam, which throws in happy-dom — so we mock the actions module and
// assert what the FORM hands it. The brand bar's language control calls
// `useRouter()` and the `setLocale` server action, so both are mocked too (the
// control has its own suite, `auth-language-control.test.tsx`). (getByRole /
// getByText THROW when absent, so the query itself is the assertion — the repo
// has no jest-dom matchers.)
const { startPlanningAction } = vi.hoisted(() => ({
  startPlanningAction: vi.fn(async (_form: FormData) => {}),
}));
vi.mock('@/app/(onboarding)/onboarding/actions', () => ({ startPlanningAction }));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import {
  OnboardingEntrance,
  ONBOARDING_IDEA_CONTROL_ID,
} from '@/components/onboarding/OnboardingEntrance';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';

afterEach(() => {
  cleanup();
  startPlanningAction.mockClear();
});

function ideaBox(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'What are you building?' }) as HTMLTextAreaElement;
}

describe('OnboardingEntrance', () => {
  it('renders the default panel: the hero, the idea box + Start, and the import section', () => {
    const { container } = renderWithIntl(<OnboardingEntrance carriedIdea={null} />);

    const h1 = screen.getByRole('heading', { level: 1, name: 'Vibe the project' });
    const hero = container.querySelector('section[data-onboarding-hero]')!;
    expect(hero.contains(h1)).toBe(true);

    // The "See how Motir works" explainer opens in a NEW TAB (design Revision 1),
    // and its accessible name says so.
    const how = screen.getByRole('link', { name: /see how motir works/i });
    expect(how.getAttribute('href')).toBe('/onboarding/how-it-works');
    expect(how.getAttribute('target')).toBe('_blank');
    expect(how.getAttribute('rel')).toBe('noopener');
    expect(how.textContent).toContain('(opens in a new tab)');
    expect(how.querySelector('.sr-only')!.textContent!.trim()).toBe('(opens in a new tab)');

    // The idea box is empty and labelled "What are you building?".
    expect(ideaBox().value).toBe('');
    expect(ideaBox().name).toBe('idea');

    // Primary CTA is a submit button (drives the form → startPlanningAction).
    const start = screen.getByRole('button', { name: /^start$/i }) as HTMLButtonElement;
    expect(start.type).toBe('submit');

    // The hint now sits INSIDE the idea card's footer (motir.co's place for it).
    // (`closest` rather than `form.contains(…)`: happy-dom's HTMLFormElement
    // answers `contains` false for its own descendants.)
    const form = ideaBox().closest('form')!;
    const hint = screen.getByText('A few sentences is enough. Motir asks about the rest.');
    expect(hint.closest('form')).toBe(form);
    expect(start.closest('form')).toBe(form);

    // The wave lines gather round the idea control: the hero's control slot
    // carries the id and holds the form.
    expect(form.parentElement!.id).toBe(ONBOARDING_IDEA_CONTROL_ID);
    expect(form.closest('section[data-onboarding-hero]')).toBe(hero);

    // The import door is ONE section band under the hero, with a link to the
    // migrate wizard — not a row inside the hero.
    const band = screen.getByRole('region', { name: 'Already have a project?' });
    expect(band.hasAttribute('data-section-band')).toBe(true);
    expect(hero.contains(band)).toBe(false);
    screen.getByRole('heading', { level: 2, name: 'Already have a project?' });
    const migrateLink = screen.getByRole('link', { name: /we can vibe it too/i });
    expect(band.contains(migrateLink)).toBe(true);
    expect(migrateLink.getAttribute('href')).toBe('/onboarding/migrate');
  });

  it('draws no eyebrow chip, no "OR" divider and no centred column (MOTIR-8250 F1/F2)', () => {
    const { container } = renderWithIntl(<OnboardingEntrance carriedIdea={null} />);
    expect(screen.queryByText('Welcome to Motir')).toBeNull();
    expect(screen.queryByText('Build with AI')).toBeNull();
    expect(screen.queryByText('OR')).toBeNull();
    expect(container.querySelectorAll('.lucide-sparkles')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('max-w-[41.25rem]');
  });

  it('heads the page with the onboarding brand bar: the real lockup, then the language control', () => {
    const { container } = renderWithIntl(<OnboardingEntrance carriedIdea={null} />);
    const bar = container.querySelector('header[data-onboarding-brand-bar]')!;
    expect(bar).not.toBeNull();
    const home = screen.getByRole('link', { name: 'Motir' });
    expect(bar.contains(home)).toBe(true);
    expect(home.querySelector('.brand-lockup svg path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);

    // Revision 2 — the language control at the bar's trailing end, after the lockup.
    const language = screen.getByRole('combobox');
    expect(bar.contains(language)).toBe(true);
    expect(home.compareDocumentPosition(language) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('focuses the idea box on mount', () => {
    renderWithIntl(<OnboardingEntrance carriedIdea={null} />);
    expect(document.activeElement).toBe(ideaBox());
  });

  it('⌘/Ctrl + Enter submits the idea to startPlanningAction; a bare Enter does not', async () => {
    renderWithIntl(<OnboardingEntrance carriedIdea={null} />);
    const box = ideaBox();
    fireEvent.change(box, { target: { value: 'A booking app for a hair salon.' } });

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(startPlanningAction).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    });
    expect(startPlanningAction).toHaveBeenCalledTimes(1);
    const sent = startPlanningAction.mock.calls[0]![0];
    expect(sent.get('idea')).toBe('A booking app for a hair salon.');

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    });
    expect(startPlanningAction).toHaveBeenCalledTimes(2);
  });

  it('renders the carried-over panel: pre-filled idea, Continue CTA, NO import section', () => {
    const idea = 'A leave-tracking app for a 20-person startup.';
    renderWithIntl(<OnboardingEntrance carriedIdea={idea} />);

    screen.getByRole('heading', { level: 1, name: 'Ready when you are' });
    screen.getByText('Carried over from your idea');

    // The explainer link shows in the carried-over panel too.
    expect(screen.getByRole('link', { name: /see how motir works/i }).getAttribute('target')).toBe(
      '_blank',
    );

    // The preserved idea pre-fills the box.
    expect(ideaBox().value).toBe(idea);

    // The CTA becomes "Continue with this idea".
    screen.getByRole('button', { name: /continue with this idea/i });

    // Arriving with an idea in hand = starting fresh: the import section is dropped.
    expect(screen.queryByRole('region', { name: 'Already have a project?' })).toBeNull();
    expect(screen.queryByRole('link', { name: /we can vibe it too/i })).toBeNull();
    expect(screen.queryByText('OR')).toBeNull();
  });
});
