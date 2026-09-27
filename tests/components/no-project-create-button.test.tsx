// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The no-project shell's primary "Create a project" (Story MOTIR-6169 ·
// MOTIR-6548, design S3): the shipped create-project modal behind the shipped
// primary Button, closed until pressed.

const modal = vi.fn();
vi.mock('@/app/(authed)/_components/CreateProjectModal', () => ({
  CreateProjectModal: (props: { open: boolean }) => {
    modal(props.open);
    return props.open ? <div role="dialog">create project</div> : null;
  },
}));

import { NoProjectCreateButton } from '@/app/(authed)/_components/NoProjectCreateButton';

afterEach(() => {
  cleanup();
  modal.mockReset();
});

describe('NoProjectCreateButton', () => {
  it('opens the create-project modal when pressed, and not before', () => {
    renderWithIntl(<NoProjectCreateButton label="Create a project" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create a project' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(modal).toHaveBeenLastCalledWith(true);
  });
});
