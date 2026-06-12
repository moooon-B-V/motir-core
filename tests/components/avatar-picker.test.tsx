// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AvatarPicker } from '@/app/(authed)/settings/project/_components/AvatarPicker';
import { AVATAR_COLORS, AVATAR_ICONS } from '@/lib/projects/avatar';

// AvatarPicker (Subtask 6.8.4) — the Popover holding the 18 preset icons + 6
// colour swatches as two radiogroups, with "None" clearing both keys. The
// trigger opens the picker; selecting an icon when no colour is set seeds a
// default colour (and vice versa) so the chip always carries both.

afterEach(cleanup);

function open(initial: { icon: string | null; color: string | null }) {
  const onChange = vi.fn();
  renderWithIntl(
    <AvatarPicker
      icon={initial.icon}
      color={initial.color}
      identifier="PROD"
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change avatar' }));
  return onChange;
}

describe('AvatarPicker', () => {
  it('renders all 18 icons + 6 colour swatches as radiogroups', () => {
    open({ icon: 'rocket', color: 'lavender' });
    const icons = screen.getByRole('radiogroup', { name: 'Icon' });
    expect(within(icons).getAllByRole('radio')).toHaveLength(AVATAR_ICONS.length);
    const colours = screen.getByRole('radiogroup', { name: 'Colour' });
    expect(within(colours).getAllByRole('radio')).toHaveLength(AVATAR_COLORS.length);
  });

  it('selecting an icon with no colour set seeds a default colour', () => {
    const onChange = open({ icon: null, color: null });
    fireEvent.click(screen.getByRole('radio', { name: 'star' }));
    // Seeds a non-null default colour (so the chip always carries both halves).
    expect(onChange).toHaveBeenCalledWith({ icon: 'star', color: expect.any(String) });
  });

  it('"None" clears both keys', () => {
    const onChange = open({ icon: 'rocket', color: 'lavender' });
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(onChange).toHaveBeenCalledWith({ icon: null, color: null });
  });
});
