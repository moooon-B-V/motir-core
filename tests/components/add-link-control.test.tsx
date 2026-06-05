// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// AddLinkControl (Subtask 2.4.9) drives the detail-page Server Actions — stub
// them + next/navigation so the client logic is testable under happy-dom.
const createLinkAction = vi.fn();
const listLinkCandidatesAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(authed)/issues/[key]/actions', () => ({
  createLinkAction: (...args: unknown[]) => createLinkAction(...args),
  removeLinkAction: vi.fn(),
  listLinkCandidatesAction: (...args: unknown[]) => listLinkCandidatesAction(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { AddLinkControl } from '@/app/(authed)/issues/[key]/_components/AddLinkControl';

const candidate = {
  id: 'cand-1',
  parentId: null,
  kind: 'task' as const,
  key: 2,
  identifier: 'PROD-9',
  title: 'Callback bug',
  status: 'todo',
  priority: 'medium' as const,
  assigneeId: null,
  position: 'a1',
  archivedAt: null,
};

beforeEach(() => {
  createLinkAction.mockReset();
  listLinkCandidatesAction.mockReset();
  refresh.mockReset();
  listLinkCandidatesAction.mockResolvedValue({ ok: true, candidates: [candidate] });
});
afterEach(cleanup);

function open() {
  render(<AddLinkControl currentItemId="wi-1" identifier="PROD-1" />);
  fireEvent.click(screen.getByRole('button', { name: /Link issue/ }));
}

describe('AddLinkControl (2.4.9)', () => {
  it('expands the form, fetches candidates for the default relationship, and Add starts disabled', async () => {
    open();
    // The kind + issue comboboxes render; Add is disabled until a target is picked.
    expect(screen.getByRole('combobox', { name: 'Relationship' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Issue to link' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() =>
      expect(listLinkCandidatesAction).toHaveBeenCalledWith('wi-1', 'blocked_by'),
    );
  });

  it('Cancel collapses the form back to the entry point', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /Link issue/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('selecting a target enables Add; a rejected create surfaces the inline error (no refresh)', async () => {
    createLinkAction.mockResolvedValue({ ok: false, error: 'That link already exists.' });
    open();

    // Open the issue combobox + pick the fetched candidate.
    fireEvent.click(await screen.findByRole('combobox', { name: 'Issue to link' }));
    fireEvent.click(await screen.findByRole('option', { name: /Callback bug/ }));

    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);

    await screen.findByText('That link already exists.');
    expect(createLinkAction).toHaveBeenCalledWith({
      currentItemId: 'wi-1',
      identifier: 'PROD-1',
      targetId: 'cand-1',
      relationship: 'blocked_by',
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
