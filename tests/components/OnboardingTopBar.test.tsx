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

afterEach(cleanup);

describe('OnboardingTopBar', () => {
  it('renders the BrandMark lockup and no Sparkles tile', () => {
    const { container } = renderWithIntl(
      <OnboardingTopBar projectName="Leave tracker" stepLabel="Building" onExit={() => {}} />,
    );
    const bar = screen.getByRole('banner', { name: 'Onboarding' });
    const lockup = bar.querySelector('.brand-lockup') as HTMLElement;
    expect(lockup).not.toBeNull();
    expect(lockup.style.getPropertyValue('--brand-size')).toBe('28px');
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
});
