// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';
import { OnboardingTopBar } from '@/components/onboarding/OnboardingTopBar';

// MOTIR-8252 — the discovery chrome's top bar shows the real Motir lockup
// (`BrandMark`, Pattern A of the MOTIR-8250 vibe-layout mock) where it drew a
// lavender tile holding a lucide `Sparkles`. Nothing else in the bar moves: the
// project name, the step label and "Save & exit" (which still fires `onExit`).
// MOTIR-8255 sets the bar's own spec (design/ai-chat § 2026-10-12, F6): the
// lockup at 22 px and a 1 px divider before the project label.

// The language control (MOTIR-8286) reads `useRouter()` and calls the
// `setLocale` server action, so both are stubbed.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: vi.fn() }));

afterEach(cleanup);

describe('OnboardingTopBar', () => {
  it('renders the BrandMark lockup and no Sparkles tile', () => {
    const { container } = renderWithIntl(
      <OnboardingTopBar projectName="Leave tracker" stepLabel="Building" onExit={() => {}} />,
    );
    const bar = screen.getByRole('banner', { name: 'Onboarding' });
    const lockup = bar.querySelector('.brand-lockup') as HTMLElement;
    expect(lockup).not.toBeNull();
    expect(lockup.style.getPropertyValue('--brand-size')).toBe('22px');
    // the divider: decorative, between the lockup and the project label
    const divider = lockup.nextElementSibling as HTMLElement;
    expect(divider.getAttribute('aria-hidden')).toBe('true');
    expect(divider.className).toContain('bg-(--el-border)');
    expect(divider.nextElementSibling!.textContent).toBe('Leave tracker · new project');
    expect(lockup.querySelector('svg path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(lockup.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(lockup.querySelector('.brand-word')!.textContent).toBe('Motir');
    expect(container.querySelector('.lucide-sparkles')).toBeNull();
  });

  it('keeps the project name, the step label and Save & exit', () => {
    const onExit = vi.fn();
    renderWithIntl(
      <OnboardingTopBar projectName="Leave tracker" stepLabel="Building" onExit={onExit} />,
    );
    screen.getByText('Leave tracker · new project');
    screen.getByText('Building');
    fireEvent.click(screen.getByRole('button', { name: 'Save & exit' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('falls back to "New project" with no project name', () => {
    renderWithIntl(<OnboardingTopBar projectName={null} stepLabel="Building" onExit={() => {}} />);
    screen.getByText('New project');
  });

  it('closes its trailing end with the language control, after Save & exit (MOTIR-8286)', () => {
    renderWithIntl(
      <OnboardingTopBar projectName="Leave tracker" stepLabel="Building" onExit={() => {}} />,
    );
    const bar = screen.getByRole('banner', { name: 'Onboarding' });
    const control = screen.getByRole('combobox', { name: /Language/ });
    expect(bar.contains(control)).toBe(true);
    const exit = screen.getByRole('button', { name: 'Save & exit' });
    expect(exit.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
