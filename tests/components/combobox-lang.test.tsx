// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';

// MOTIR-7758 — the additive Combobox props the signed-out language control needs:
// a per-option `lang`, a trigger-only leading glyph, a busy trigger that stays
// enabled, and an end-aligned menu. Each is optional; a caller that passes none
// of them renders exactly as before (the other combobox-* suites hold that).

afterEach(cleanup);

const OPTIONS: ComboboxOption<string>[] = [
  { value: 'en', label: 'English', lang: 'en' },
  { value: 'ja', label: '日本語', lang: 'ja' },
  { value: 'plain', label: 'No lang' },
];

describe('Combobox — option lang (MOTIR-7758)', () => {
  it('renders an option’s lang on its row, and on the trigger label while selected', () => {
    render(<Combobox label="Language" options={OPTIONS} value="ja" onChange={() => {}} autoOpen />);
    const rows = screen.getAllByRole('option');
    expect(rows.map((r) => r.getAttribute('lang'))).toEqual(['en', 'ja', null]);
    const label = [...screen.getByRole('combobox').querySelectorAll('span')].find(
      (s) => s.textContent === '日本語',
    )!;
    expect(label.getAttribute('lang')).toBe('ja');
  });

  it('leaves the trigger label without lang when the selected option has none', () => {
    render(<Combobox label="Language" options={OPTIONS} value="plain" onChange={() => {}} />);
    const label = [...screen.getByRole('combobox').querySelectorAll('span')].find(
      (s) => s.textContent === 'No lang',
    )!;
    expect(label.hasAttribute('lang')).toBe(false);
  });
});

describe('Combobox — trigger-only glyph, busy, end alignment (MOTIR-7758)', () => {
  it('draws triggerIcon on the trigger only, aria-hidden', () => {
    render(
      <Combobox
        label="Language"
        options={OPTIONS}
        value="en"
        onChange={() => {}}
        autoOpen
        triggerIcon={<svg data-testid="glyph" />}
      />,
    );
    const glyphs = screen.getAllByTestId('glyph');
    expect(glyphs).toHaveLength(1);
    expect(screen.getByRole('combobox').contains(glyphs[0]!)).toBe(true);
    expect(glyphs[0]!.parentElement!.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks a busy trigger aria-busy with a spinner in the chevron slot, still enabled', () => {
    const { rerender } = render(
      <Combobox label="Language" options={OPTIONS} value="en" onChange={() => {}} />,
    );
    const t = screen.getByRole('combobox');
    expect(t.hasAttribute('aria-busy')).toBe(false);
    expect(t.querySelector('[data-combobox-busy]')).toBeNull();
    rerender(<Combobox label="Language" options={OPTIONS} value="en" onChange={() => {}} busy />);
    expect(t.getAttribute('aria-busy')).toBe('true');
    expect(t.querySelector('[data-combobox-busy]')).not.toBeNull();
    expect((t as HTMLButtonElement).disabled).toBe(false);
  });

  it('pins an end-aligned portaled menu by its right edge', () => {
    render(
      <Combobox
        label="Language"
        options={OPTIONS}
        value="en"
        onChange={() => {}}
        autoOpen
        align="end"
      />,
    );
    const menu = screen.getByRole('listbox').closest('[data-menu-surface]') as HTMLElement;
    expect(menu.style.right).not.toBe('');
    expect(menu.style.left).toBe('');
  });

  it('keeps the default menu pinned by its left edge', () => {
    render(<Combobox label="Language" options={OPTIONS} value="en" onChange={() => {}} autoOpen />);
    const menu = screen.getByRole('listbox').closest('[data-menu-surface]') as HTMLElement;
    expect(menu.style.left).not.toBe('');
    expect(menu.style.right).toBe('');
  });
});
