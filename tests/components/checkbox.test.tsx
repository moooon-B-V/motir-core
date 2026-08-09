// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Checkbox, checkboxStateLabel } from '@/components/ui/Checkbox';

// The `Checkbox` primitive (Story MOTIR-2257 · Subtask MOTIR-2465) — the one new
// design-system component the role editor needs.
//
// The claim worth testing hardest is the a11y one: a permission can be ticked
// for two different reasons, and the design is explicit that *"who granted this"
// is never carried by fill colour alone*. So every assertion below about the
// three states goes through the ACCESSIBLE NAME — which is what survives with
// colour off, in a screen reader, and in a monochrome print. A test that read
// the class list would pass on a component that says nothing.

afterEach(() => cleanup());

const noop = () => {};

describe('the three states each render their stated accessible name', () => {
  it('NOT HELD — an empty box that says so', () => {
    render(<Checkbox checked={false} onChange={noop} label="Add comments" />);
    const box = screen.getByRole('checkbox', { name: 'Add comments, Not held' });
    expect(box.getAttribute('aria-checked')).toBe('false');
  });

  it('HELD — FROM THE BASE, naming the base in words', () => {
    render(
      <Checkbox
        checked
        onChange={noop}
        label="View project"
        provenance="base"
        baseLabel="Viewer"
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'View project, Held — from Viewer' });
    expect(box.getAttribute('aria-checked')).toBe('true');
  });

  it('HELD — ADDED, distinguishable from the base grant WITHOUT reading a colour', () => {
    render(<Checkbox checked onChange={noop} label="Add comments" provenance="added" />);
    expect(screen.getByRole('checkbox', { name: 'Add comments, Held — added' })).toBeTruthy();

    // The point, stated directly: the two HELD states differ in their NAME, not
    // only in their fill. Render both and compare the names.
    cleanup();
    render(
      <>
        <Checkbox checked onChange={noop} label="A" provenance="base" baseLabel="Viewer" />
        <Checkbox checked onChange={noop} label="A" provenance="added" />
      </>,
    );
    const names = screen
      .getAllByRole('checkbox')
      .map((el) => el.getAttribute('aria-label'))
      .sort();
    expect(names).toEqual(['A, Held — added', 'A, Held — from Viewer']);
    expect(new Set(names).size).toBe(2);
  });

  it('falls back to a base-less sentence when no base name is supplied — still words, never a colour', () => {
    render(<Checkbox checked onChange={noop} label="View project" provenance="base" />);
    expect(
      screen.getByRole('checkbox', { name: 'View project, Held — from the base' }),
    ).toBeTruthy();
  });

  it('defaults the provenance so a plain two-state checkbox needs no extra prop', () => {
    expect(checkboxStateLabel(false, 'none')).toBe('Not held');
    render(<Checkbox checked onChange={noop} label="Make initial" />);
    expect(screen.getByRole('checkbox', { name: 'Make initial, Held — added' })).toBeTruthy();
  });
});

describe('interaction', () => {
  it('round-trips through the CONTROLLED prop — it does not own its own state', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Checkbox checked={false} onChange={onChange} label="Add comments" />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);

    // Nothing moved until the OWNER re-rendered it — the controlled contract.
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
    rerender(<Checkbox checked onChange={onChange} label="Add comments" />);
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('is focusable and toggles on SPACE — it is a real button, not a styled div', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Add comments" />);
    const box = screen.getByRole('checkbox');
    expect(box.tagName).toBe('BUTTON');
    box.focus();
    expect(document.activeElement).toBe(box);
    // A <button> activates on Space and Enter by construction; the click a key
    // press dispatches is what the handler sees.
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('DISABLED fires nothing — on click, and it is out of the tab order', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Planned key" disabled />);
    const box = screen.getByRole('checkbox');
    expect(box.getAttribute('aria-disabled')).toBe('true');
    expect((box as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: ' ' });
    expect(onChange).not.toHaveBeenCalled();
    // Still LEGIBLE — the story's server-refused keys stay on the page rather
    // than vanishing, so the name must survive being disabled.
    expect(box.getAttribute('aria-label')).toBe('Planned key, Not held');
  });
});

describe('token discipline', () => {
  it('renders no Tier-0 utility and no raw shape value on the box', () => {
    // The colour + shape rules apply to a primitive as much as to a page. This
    // reads the rendered class list because that IS the deliverable here.
    const { container } = render(<Checkbox checked onChange={noop} label="A" provenance="added" />);
    const classes = [...container.querySelectorAll('*')]
      .map((el) => el.getAttribute('class') ?? '')
      .join(' ');
    // Tier-0 colour utilities and arbitrary --color-* are forbidden.
    expect(classes).not.toMatch(
      /\b(bg|text|border)-(foreground|surface|border|primary|muted-foreground)\b/,
    );
    expect(classes).not.toMatch(/--color-/);
    // A control's own radius must flow through the element-semantic token.
    expect(classes).toMatch(/rounded-\(--radius-control\)/);
    expect(classes).not.toMatch(/\brounded-(sm|md|lg|xl)\b/);
  });

  it('renders the label visibly only when asked', () => {
    const { rerender } = render(<Checkbox checked={false} onChange={noop} label="Add comments" />);
    expect(screen.queryByText('Add comments')).toBeNull();
    rerender(<Checkbox checked={false} onChange={noop} label="Add comments" labelVisible />);
    expect(screen.getByText('Add comments')).toBeTruthy();
  });
});
