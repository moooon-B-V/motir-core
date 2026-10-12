// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  OnboardingLinkOut,
  OnboardingSection,
  WARM_CTA,
  WarmButton,
} from '@/components/onboarding/layout';

// MOTIR-8256 (Story MOTIR-8238's integration gate), case 4 — the branches of the
// shared onboarding primitives the screen specs never take, so the per-file
// floor in `vitest.config.ts` holds on what the primitives promise rather than
// on what today's screens happen to pass.

afterEach(cleanup);

describe('the onboarding primitives — the optional branches', () => {
  it('OnboardingLinkOut renders no body paragraph when it has none', () => {
    const { container } = render(
      <OnboardingLinkOut
        title="How Motir works"
        cta="Read it on motir.co"
        href="https://motir.co/how-it-works"
        newTabLabel="(opens in a new tab)"
      />,
    );
    screen.getByRole('region', { name: 'How Motir works' });
    expect(container.querySelector('section p')).toBeNull();
  });

  it('OnboardingSection renders children without a lede, and no body at all with neither', () => {
    const { container, rerender } = render(
      <OnboardingSection title="Say it">
        <a href="/x">We can vibe it too</a>
      </OnboardingSection>,
    );
    screen.getByRole('link', { name: 'We can vibe it too' });
    expect(container.querySelector('section p')).toBeNull();
    rerender(<OnboardingSection title="Say it">{false}</OnboardingSection>);
    expect(container.querySelector('section .justify-items-start')).toBeNull();
  });

  it('WarmButton paints only the primary variant warm', () => {
    render(
      <>
        <WarmButton>Default</WarmButton>
        <WarmButton variant="primary">Primary</WarmButton>
        <WarmButton variant="secondary">Secondary</WarmButton>
      </>,
    );
    const warm = WARM_CTA.split(' ');
    for (const name of ['Default', 'Primary']) {
      expect(screen.getByRole('button', { name }).className.split(/\s+/)).toEqual(
        expect.arrayContaining(warm),
      );
    }
    expect(screen.getByRole('button', { name: 'Secondary' }).className).not.toContain(
      '--el-cta-warm',
    );
  });
});
