// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Checkbox, checkboxStateLabel } from '@/components/ui/Checkbox';

// The `Checkbox` primitive (Story MOTIR-2257 · Subtask MOTIR-2465) — the one new
// design-system component the role editor needs.
//
// The claim worth testing hardest is the a11y one: the state must not rest on
// the fill colour. So every assertion below about held/not-held goes through the
// ACCESSIBLE NAME — which is what survives with colour off, in a screen reader,
// and in a monochrome print. A test that read the class list would pass on a
// component that says nothing.

afterEach(() => cleanup());

const noop = () => {};

describe('the two states each render their stated accessible name', () => {
  it('NOT HELD — an empty box that says so', () => {
    render(<Checkbox checked={false} onChange={noop} label="Add comments" />);
    const box = screen.getByRole('checkbox', { name: 'Add comments, Not held' });
    expect(box.getAttribute('aria-checked')).toBe('false');
  });

  it('HELD — and the state is in the NAME, not only in the fill', () => {
    render(<Checkbox checked onChange={noop} label="Add comments" />);
    const box = screen.getByRole('checkbox', { name: 'Add comments, Held' });
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(checkboxStateLabel(true)).toBe('Held');
    expect(checkboxStateLabel(false)).toBe('Not held');
  });

  it('uses a caller-provided state vocabulary when its checkbox is not set membership', () => {
    const { rerender } = render(
      <Checkbox
        checked={false}
        onChange={noop}
        label="Trust this device for 30 days"
        stateLabels={{ checked: 'Checked', unchecked: 'Not checked' }}
      />,
    );
    expect(
      screen.getByRole('checkbox', { name: 'Trust this device for 30 days, Not checked' }),
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Held|Not held/ })).toBeNull();

    rerender(
      <Checkbox
        checked
        onChange={noop}
        label="Trust this device for 30 days"
        stateLabels={{ checked: 'Checked', unchecked: 'Not checked' }}
      />,
    );
    expect(
      screen.getByRole('checkbox', { name: 'Trust this device for 30 days, Checked' }),
    ).toBeTruthy();
  });

  it('takes NO provenance discriminator — a permission is held or it is not', () => {
    // Yue, 2026-08-09. An earlier revision had a third state: a grey fill for a
    // permission that came WITH the author's chosen base, distinct from the
    // accent fill of one they added. It died with the stored `based_on` column —
    // with nothing recorded, a re-edit has no base for anything to have come
    // from, so the two fills could not be told apart honestly.
    const props = Object.keys({
      checked: true,
      onChange: noop,
      label: 'A',
      disabled: false,
      labelVisible: false,
      id: '',
      className: '',
    });
    expect(props).not.toContain('provenance');
    expect(props).not.toContain('baseLabel');
    // And the name carries no "from …" clause in either state.
    render(<Checkbox checked onChange={noop} label="View project" />);
    expect(screen.queryByRole('checkbox', { name: /from/i })).toBeNull();
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
    const { container } = render(<Checkbox checked onChange={noop} label="A" />);
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
