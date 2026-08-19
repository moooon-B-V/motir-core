// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';

// MOTIR-3080 — THE LEADING-VISUAL SLOT BLOCKIFIES WHAT IT IS GIVEN.
//
// `StatusPicker`'s status dot is a plain `<span>` with `h-2.5 w-2.5`, handed to
// this slot as an option's `icon`. The wrapper is a flex item of its row, so the
// WRAPPER is blockified — but its child is not, so the dot stayed
// `display: inline`, where width and height do not apply. It rendered 2 × 18
// instead of 10 × 10, which is the mark three cards of palette work
// (MOTIR-1273 / -2073 / -2075) had been measuring the hue of.
//
// ⚠️ WHAT THIS FILE CAN AND CANNOT PROVE, stated because the gap is the whole
// reason the bug shipped. happy-dom does no LAYOUT: `getBoundingClientRect()` is
// zeros here, so a box cannot be measured at this tier, and the markup was never
// what was wrong. What IS checkable here is the mechanism — the slot is a flex
// CONTAINER, so a non-replaced child becomes a flex item and takes its size. The
// measurement itself is a browser fact and lives in
// `tests/e2e/issue-detail-flow.spec.ts`, which reads the real used value.

afterEach(cleanup);

const DOT = (
  <span data-testid="dot" aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full border" />
);

const OPTIONS: ComboboxOption<string>[] = [
  { value: 'todo', label: 'To Do', icon: DOT },
  { value: 'in_progress', label: 'In Progress', icon: DOT },
];

/** The slot wrapper an icon is rendered into — its parent element. */
function slotOf(icon: HTMLElement): HTMLElement {
  return icon.parentElement!;
}

describe('the Combobox icon slot (MOTIR-3080)', () => {
  it('makes each OPTION row’s icon slot a flex container, so a plain span takes its size', () => {
    render(<Combobox label="Status" options={OPTIONS} value="todo" onChange={() => {}} autoOpen />);
    const dots = screen.getAllByTestId('dot');
    // Both option rows plus the trigger's selected value.
    expect(dots.length).toBeGreaterThanOrEqual(2);
    for (const dot of dots) {
      expect(slotOf(dot).className, 'the slot blockifies its child').toContain('inline-flex');
      // …and never squeezes it — the row is a flex line and the dot is 10px.
      expect(slotOf(dot).className).toContain('shrink-0');
    }
  });

  it('makes the TRIGGER’s icon slot the same container — the selected value’s dot too', () => {
    render(<Combobox label="Status" options={OPTIONS} value="in_progress" onChange={() => {}} />);
    // Closed: the only dot on screen is the trigger's.
    const dot = screen.getByTestId('dot');
    expect(slotOf(dot).className).toContain('inline-flex');
    expect(slotOf(dot).getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves the icon itself untouched — the slot adds a box, not a style', () => {
    // The caller's classes are what decide the dot's SIZE and colour; the slot's
    // job is only to let them apply. A slot that restyled its child would make
    // every caller's icon its business.
    render(<Combobox label="Status" options={OPTIONS} value="todo" onChange={() => {}} />);
    const dot = screen.getByTestId('dot');
    expect(dot.className).toBe('h-2.5 w-2.5 shrink-0 rounded-full border');
  });
});
