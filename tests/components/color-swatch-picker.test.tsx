// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ColorSwatchPicker, STATUS_COLOR_SWATCHES } from '@/components/ui/ColorSwatchPicker';

afterEach(() => cleanup());

// A controlled host so arrow-key navigation (which re-derives the tabbable
// swatch from `value`) behaves like the real StatusFormModal usage.
function Host({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <ColorSwatchPicker value={value} onChange={setValue} />
      <span data-testid="value">{value === null ? 'null' : value}</span>
    </>
  );
}

describe('ColorSwatchPicker', () => {
  it('renders one radio per curated swatch inside a labelled radiogroup', () => {
    render(<ColorSwatchPicker value={null} onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Color' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(STATUS_COLOR_SWATCHES.length);
    // Each swatch carries its accessible name.
    expect(within(group).getByRole('radio', { name: 'Blue' })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: 'None (derive from category)' })).toBeTruthy();
  });

  it('selecting a swatch fires onChange with its hex; None fires null', () => {
    const onChange = vi.fn();
    render(<ColorSwatchPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Green' }));
    expect(onChange).toHaveBeenLastCalledWith('#1aae39');
    fireEvent.click(screen.getByRole('radio', { name: 'None (derive from category)' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('marks the matching swatch aria-checked and makes it the only tab stop (roving)', () => {
    render(<ColorSwatchPicker value="#0075de" onChange={() => {}} />);
    const blue = screen.getByRole('radio', { name: 'Blue' });
    expect(blue.getAttribute('aria-checked')).toBe('true');
    expect(blue.getAttribute('tabindex')).toBe('0');
    // A non-selected swatch is out of the tab order.
    expect(screen.getByRole('radio', { name: 'Green' }).getAttribute('tabindex')).toBe('-1');
  });

  it('arrow keys move the selection to the adjacent swatch', () => {
    render(<Host initial={null} />);
    // `null` (the first swatch) is selected; ArrowRight → the next swatch (Grey).
    const none = screen.getByRole('radio', { name: 'None (derive from category)' });
    fireEvent.keyDown(none, { key: 'ArrowRight' });
    expect(screen.getByTestId('value').textContent).toBe('#787671');

    // ArrowLeft from Grey wraps/moves back to None.
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Grey' }), { key: 'ArrowLeft' });
    expect(screen.getByTestId('value').textContent).toBe('null');
  });

  it('disabled disables every swatch', () => {
    render(<ColorSwatchPicker value={null} onChange={() => {}} disabled />);
    for (const radio of screen.getAllByRole('radio')) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
