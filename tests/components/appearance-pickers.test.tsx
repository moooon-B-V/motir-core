// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  PalettePicker,
  StylePicker,
  ThemeSegmentedControl,
  TypePicker,
} from '@/components/theme/AppearancePickers';
import { STYLE_IDS, STYLE_REGISTRY } from '@/lib/theme/styles';
import { PALETTE_IDS, PALETTE_REGISTRY } from '@/lib/theme/palettes';
import { TYPE_IDS, TYPE_REGISTRY } from '@/lib/theme/typography';
import type { ThemePattern } from '@/lib/theme/types';

// Subtask 7.3.58 — the shared three-axis pickers (reused by the Appearance pane
// and the onboarding design wizard). They are CONTROLLED + registry-driven, so the
// contract under test is: every registry entry renders as a radio chip, the active
// id carries aria-checked, and clicking a chip reports that id via onChange. No
// jest-dom (project convention) — assertions read DOM attributes directly.

afterEach(cleanup);

describe('StylePicker', () => {
  it('renders one radio per registered style, marks the active one, and reports a pick', () => {
    const onChange = vi.fn();
    render(<StylePicker value="warm-editorial" onChange={onChange} label="Style" />);

    const group = screen.getByRole('radiogroup', { name: 'Style' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(STYLE_IDS.length);

    const active = screen.getByRole('radio', { name: STYLE_REGISTRY['warm-editorial'].name });
    expect(active.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: STYLE_REGISTRY['neo-brutalism'].name }));
    expect(onChange).toHaveBeenCalledWith('neo-brutalism');
  });
});

describe('PalettePicker', () => {
  it('renders one radio per palette and reports a pick', () => {
    const onChange = vi.fn();
    render(<PalettePicker value="motir" onChange={onChange} label="Palette" />);

    expect(screen.getAllByRole('radio')).toHaveLength(PALETTE_IDS.length);
    fireEvent.click(screen.getByRole('radio', { name: PALETTE_REGISTRY['cobalt'].name }));
    expect(onChange).toHaveBeenCalledWith('cobalt');
  });
});

describe('TypePicker', () => {
  it('renders one radio per type pairing and reports a pick', () => {
    const onChange = vi.fn();
    render(<TypePicker value="motir" onChange={onChange} label="Typography" />);

    expect(screen.getAllByRole('radio')).toHaveLength(TYPE_IDS.length);
    fireEvent.click(screen.getByRole('radio', { name: TYPE_REGISTRY['grotesk'].name }));
    expect(onChange).toHaveBeenCalledWith('grotesk');
  });
});

describe('ThemeSegmentedControl', () => {
  const labels: Record<ThemePattern, string> = { light: 'Light', dark: 'Dark', system: 'System' };

  it('renders the three patterns, marks the active one, and reports a pick', () => {
    const onChange = vi.fn();
    render(
      <ThemeSegmentedControl value="system" onChange={onChange} label="Theme" labels={labels} />,
    );

    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(onChange).toHaveBeenCalledWith('dark');
  });

  it('arrow keys move the selection (radiogroup keyboard contract)', () => {
    const onChange = vi.fn();
    render(
      <ThemeSegmentedControl value="light" onChange={onChange} label="Theme" labels={labels} />,
    );

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Light' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('dark');
  });
});
