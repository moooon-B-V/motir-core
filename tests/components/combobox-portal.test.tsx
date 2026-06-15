// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { useState } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';

afterEach(cleanup);

const OPTIONS: ComboboxOption<string>[] = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
];

// Mirror the issue-list table's clipping wrapper (IssueListTable.tsx:90 /
// TreeTable.tsx:448): a SHORT card with `overflow-hidden`. Before the fix the
// Combobox menu was an absolutely-positioned descendant of this card, so a short
// table clipped it (bug-inline-edit-clipped-when-table-short). The menu must now
// be portaled OUT of this overflow ancestor.
function Host() {
  const [value, setValue] = useState<string | null>('in_progress');
  return (
    <div data-testid="clip-card" className="overflow-hidden" style={{ height: 60 }}>
      <Combobox label="Status" options={OPTIONS} value={value} onChange={setValue} />
    </div>
  );
}

describe('Combobox — menu portaling (bug-inline-edit-clipped-when-table-short)', () => {
  it('renders the open menu outside the overflow-hidden ancestor (portaled to body)', () => {
    render(<Host />);
    const card = screen.getByTestId('clip-card');

    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    const listbox = screen.getByRole('listbox', { name: 'Status' });
    // The whole menu panel is the listbox's parent; it must NOT live inside the
    // clipping card, and it must be anchored with position:fixed (viewport
    // coords) rather than the old absolute-inside-the-scroller positioning.
    expect(card.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);

    const panel = listbox.parentElement as HTMLElement;
    expect(panel.style.position).toBe('fixed');
  });

  it('still commits a selection clicked inside the portaled menu', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    // A click lands on the portaled option; the click-outside guard must treat
    // the portaled menu as "inside" so it does not pre-close before commit.
    fireEvent.click(screen.getByRole('option', { name: 'Done' }));

    expect(screen.queryByRole('listbox')).toBeNull(); // menu closed after pick
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toContain('Done');
  });

  // Regression for the E2E failure on PR #444: inside a focus-trapping dialog the
  // menu must render INLINE (a body-portaled menu lands outside the dialog's focus
  // scope → focus-trap war → unstable / un-clickable; and the dialog's centering
  // transform breaks a fixed child's viewport coords). Pickers in the create-issue
  // modal must keep working.
  function DialogHost() {
    const [value, setValue] = useState<string | null>('todo');
    return (
      <div role="dialog">
        <Combobox label="Status" options={OPTIONS} value={value} onChange={setValue} />
      </div>
    );
  }

  it('renders inline (not portaled) inside a dialog, and still commits', () => {
    render(<DialogHost />);
    const dialog = screen.getByRole('dialog');

    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    const listbox = screen.getByRole('listbox', { name: 'Status' });
    // Inline: the menu stays WITHIN the dialog subtree (not portaled to body).
    expect(dialog.contains(listbox)).toBe(true);
    expect((listbox.parentElement as HTMLElement).style.position).not.toBe('fixed');

    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toContain('In Progress');
  });

  // Regression for bug-combobox-menu-clipped-inside-modal: inside a Modal's
  // overflow-hidden panel the inline menu cannot escape, so a long option list
  // opened near the bottom of a short modal used to be CLIPPED (only the first
  // 1–2 options reachable — the Add-widget Statistic-type picker). The inline
  // menu must now CLAMP its listbox height to the dialog's available space and
  // FLIP above when that side is taller, so it always fits + scrolls internally.
  // happy-dom does no layout, so we drive getBoundingClientRect with explicit
  // rects to exercise the clamp geometry (the same posture as the swimlane /
  // detail-overflow geometry tests — measured, not CSS-asserted).
  function rect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 360,
      width: 360,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  const TALL_OPTIONS: ComboboxOption<string>[] = Array.from({ length: 8 }, (_, i) => ({
    value: `s${i}`,
    label: `Statistic ${i}`,
  }));

  // A hard-clipping dialog panel = the centered Modal (`overflow-hidden`).
  function TallDialogHost() {
    const [value, setValue] = useState<string | null>(null);
    return (
      <div role="dialog" style={{ overflowY: 'hidden' }}>
        <Combobox
          label="Statistic type"
          options={TALL_OPTIONS}
          value={value}
          onChange={setValue}
          searchable
        />
      </div>
    );
  }

  it('clamps the inline menu height + flips above when the modal clips it', () => {
    render(<TallDialogHost />);
    const dialog = screen.getByRole('dialog');
    const trigger = screen.getByRole('combobox', { name: 'Statistic type' });

    // A short modal (height 320) whose trigger sits in the lower half: ~76px
    // below the trigger inside the panel, ~188px above it. The unclamped 16rem
    // (256px) menu would overflow the panel's bottom edge and be clipped.
    dialog.getBoundingClientRect = () => rect(100, 420);
    trigger.getBoundingClientRect = () => rect(300, 332);

    fireEvent.click(trigger);
    // Re-measure with the mocked rects in place (the open-time layout effect ran
    // against happy-dom's zero rects; the resize listener recomputes).
    fireEvent.resize(window);

    const listbox = screen.getByRole('listbox', { name: 'Statistic type' });
    const panel = listbox.parentElement as HTMLElement;

    // Flipped ABOVE (188px > 76px) so it opens into the taller side…
    expect(panel.className).toContain('bottom-full');
    expect(panel.className).not.toContain('top-full');

    // …and clamped to fit that side (≤ the ~188px of room above the trigger),
    // with overflow-y-auto so it scrolls internally rather than being clipped.
    const maxH = parseInt(listbox.style.maxHeight, 10);
    expect(maxH).toBeGreaterThan(0);
    expect(maxH).toBeLessThanOrEqual(188);
    expect(listbox.className).toContain('overflow-y-auto');
  });

  // Regression for the CI break the first fix caused: the Advanced-filter
  // builder is an ANCHORED Popover with role="dialog" whose outer box does NOT
  // clip (only an inner overflow-y-auto body). Clamping/flipping against that
  // small content-sized box shoved the operator menu up under the popover's own
  // header, which intercepted the option click. A non-clipping dialog must keep
  // the original inline behaviour: menu opens BELOW, never flips.
  function PopoverDialogHost() {
    const [value, setValue] = useState<string | null>(null);
    return (
      // The Advanced-filter shape: an overflow-hidden popover whose body is an
      // overflow-y-auto SCROLL region (the combobox's nearest clip scrolls, so
      // the menu can be scrolled into view — no clamp/flip).
      <div role="dialog" style={{ overflow: 'hidden' }}>
        <div style={{ overflowY: 'auto', maxHeight: 200 }}>
          <Combobox label="Operator" options={TALL_OPTIONS} value={value} onChange={setValue} />
        </div>
      </div>
    );
  }

  it('leaves a non-clipping popover-dialog menu below the trigger (no flip)', () => {
    render(<PopoverDialogHost />);
    const dialog = screen.getByRole('dialog');
    const trigger = screen.getByRole('combobox', { name: 'Operator' });

    // Same lower-half geometry that flips inside a clipping Modal — but this
    // dialog doesn't clip, so the menu must stay anchored below regardless.
    dialog.getBoundingClientRect = () => rect(100, 420);
    trigger.getBoundingClientRect = () => rect(300, 332);

    fireEvent.click(trigger);
    fireEvent.resize(window);

    const listbox = screen.getByRole('listbox', { name: 'Operator' });
    const panel = listbox.parentElement as HTMLElement;
    expect(panel.className).toContain('top-full');
    expect(panel.className).not.toContain('bottom-full');
  });

  // Regression for bug-combobox-menu-clipped-inside-popover: a `role="dialog"`
  // ancestor whose `overflow` is VISIBLE — the shape `Popover.Content` takes
  // when its `overflowVisible` prop is set so a Combobox menu can render past
  // the popover's edge. The clamp+flip logic must NOT engage here (it would
  // clamp against the next clip box up, which on a triage popover is uselessly
  // small): the menu must render at its full natural height (max-h-64), inline
  // below the trigger, free to extend past the popover's edge.
  function OverflowVisibleDialogHost() {
    const [value, setValue] = useState<string | null>(null);
    return (
      // Triage promote-sprint shape: a `role="dialog"` ancestor with no clip.
      // The clip-box walk in `nearestClipBox` skips this and either finds a
      // further-up clip OR returns null — both branches leave the menu at the
      // default max-h-64 with no flip.
      <div role="dialog" style={{ overflow: 'visible' }}>
        <Combobox
          label="Sprint"
          options={TALL_OPTIONS}
          value={value}
          onChange={setValue}
          searchable
        />
      </div>
    );
  }

  it('keeps a Popover-with-overflow-visible dialog menu at its natural height (no clamp)', () => {
    render(<OverflowVisibleDialogHost />);
    const trigger = screen.getByRole('combobox', { name: 'Sprint' });
    fireEvent.click(trigger);
    fireEvent.resize(window);

    const listbox = screen.getByRole('listbox', { name: 'Sprint' });
    const panel = listbox.parentElement as HTMLElement;

    // No flip — menu stays below the trigger…
    expect(panel.className).toContain('top-full');
    expect(panel.className).not.toContain('bottom-full');

    // …and the listbox keeps the default 256px cap (max-h-64), NOT clamped
    // down to the 80px floor a tiny clip box would have forced.
    expect(listbox.style.maxHeight).toBe('256px');
  });
});
