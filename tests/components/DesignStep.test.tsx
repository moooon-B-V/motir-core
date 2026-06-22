// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DesignStep } from '@/components/onboarding/DesignStep';
import { DEFAULT_STYLE_ID, STYLE_IDS, STYLE_REGISTRY } from '@/lib/theme/styles';

// The onboarding design step (Subtask 7.3.27 / MOTIR-1040). It designs the USER'S
// PROJECT: the picks scope to THIS PAGE (the section's data-* attributes) — the
// whole wizard page restyles — but NEVER touch Motir's `<html>`. Local state, no
// global `useTheme`. No jest-dom (project convention) — assertions read DOM
// attributes / text / spy calls directly.

const OTHER_STYLE = STYLE_IDS.find((id) => id !== DEFAULT_STYLE_ID)!;

function renderStep(props: { onBack?: () => void; onUseDesign?: () => void } = {}) {
  const onBack = props.onBack ?? vi.fn();
  const onUseDesign = props.onUseDesign ?? vi.fn();
  const { container } = renderWithIntl(<DesignStep onBack={onBack} onUseDesign={onUseDesign} />);
  const page = () => container.querySelector('[data-testid="design-page"]')!;
  return { onBack, onUseDesign, page };
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-style');
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => cleanup());

describe('DesignStep (MOTIR-1040)', () => {
  it('renders the title and all four controls', () => {
    renderStep();
    expect(screen.getByText("Design your project's look")).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Style' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Palette' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Typography' })).toBeTruthy();
  });

  it('defaults the project preview to light + the default axes', () => {
    const { page } = renderStep();
    expect(page().getAttribute('data-theme')).toBe('light');
    expect(page().getAttribute('data-style')).toBe(DEFAULT_STYLE_ID);
  });

  it('scopes a style pick to THIS PAGE — Motir (<html>) is never touched', () => {
    const { page } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[OTHER_STYLE].name }));

    // The wizard page restyles…
    expect(page().getAttribute('data-style')).toBe(OTHER_STYLE);
    // …but Motir's own look (the document root) is untouched.
    expect(document.documentElement.getAttribute('data-style')).toBeNull();
  });

  it('the theme control restyles only the page (dark → section, not <html>)', () => {
    const { page } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(page().getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('Reset returns the project design to its defaults', () => {
    const { page } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY[OTHER_STYLE].name }));
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));

    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));

    expect(page().getAttribute('data-style')).toBe(DEFAULT_STYLE_ID);
    expect(page().getAttribute('data-theme')).toBe('light');
  });

  it('Use this design + Back call their callbacks', () => {
    const { onBack, onUseDesign } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Use this design' }));
    expect(onUseDesign).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows no Fine-tune control (that is a separate subtask)', () => {
    renderStep();
    expect(screen.queryByRole('button', { name: /Fine-tune/ })).toBeNull();
  });
});
