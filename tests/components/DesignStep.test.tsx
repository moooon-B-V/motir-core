// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import enMessages from '@/messages/en.json';
import { defaultLocale } from '@/lib/i18n/locales';
import { ThemeProvider } from '@/lib/contexts/theme-context';
import { DesignStep } from '@/components/onboarding/DesignStep';
import { DEFAULT_STYLE_ID, STYLE_IDS, STYLE_REGISTRY } from '@/lib/theme/styles';

// The onboarding design step (Subtask 7.3.27 / MOTIR-1040). It composes the
// shipped three-axis runtime: picking an axis flips the live `<html>` attribute
// through `useTheme()` (the page IS the example). No jest-dom (project
// convention) — assertions read DOM attributes / text / spy calls directly.

// A non-default style to exercise the live flip (default is warm-editorial).
const OTHER_STYLE = STYLE_IDS.find((id) => id !== DEFAULT_STYLE_ID)!;

function renderStep(props: { onBack?: () => void; onUseDesign?: () => void } = {}) {
  const onBack = props.onBack ?? vi.fn();
  const onUseDesign = props.onUseDesign ?? vi.fn();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={defaultLocale} messages={enMessages}>
        <ThemeProvider signedIn={false}>{children}</ThemeProvider>
      </NextIntlClientProvider>
    );
  }
  render(<DesignStep onBack={onBack} onUseDesign={onUseDesign} />, { wrapper: Wrapper });
  return { onBack, onUseDesign };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-style');
});

afterEach(() => cleanup());

describe('DesignStep (MOTIR-1040)', () => {
  it('renders the title and all three axis pickers', () => {
    renderStep();
    expect(screen.getByText("Design your product's look")).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Style' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Palette' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Typography' })).toBeTruthy();
  });

  it('flips the live <html> style attribute when a style chip is picked', () => {
    renderStep();
    // The provider applies the default on mount.
    expect(document.documentElement.getAttribute('data-style')).toBe(DEFAULT_STYLE_ID);

    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[OTHER_STYLE].name }));

    // The whole page restyles live — the page IS the example.
    expect(document.documentElement.getAttribute('data-style')).toBe(OTHER_STYLE);
    expect(localStorage.getItem('motir.theme.style')).toBe(OTHER_STYLE);
  });

  it('Skip resets the axes to default and returns to the hub', () => {
    const { onBack } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[OTHER_STYLE].name }));
    expect(document.documentElement.getAttribute('data-style')).toBe(OTHER_STYLE);

    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));

    expect(document.documentElement.getAttribute('data-style')).toBe(DEFAULT_STYLE_ID);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('"Use this design" confirms and moves on, keeping the chosen look', () => {
    const { onUseDesign } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[OTHER_STYLE].name }));

    fireEvent.click(screen.getByRole('button', { name: 'Use this design' }));

    expect(onUseDesign).toHaveBeenCalledTimes(1);
    // The look is NOT reset — confirming keeps the pick applied.
    expect(document.documentElement.getAttribute('data-style')).toBe(OTHER_STYLE);
  });

  it('draws the Fine-tune knobs affordance disabled (its panel is MOTIR-1246/1247)', () => {
    renderStep();
    const fineTune = screen.getByRole('button', { name: /Fine-tune/ }) as HTMLButtonElement;
    expect(fineTune.disabled).toBe(true);
  });
});
