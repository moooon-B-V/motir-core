// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// AddLinkControl (Subtask 2.4.9) drives the detail-page Server Actions — stub
// them + next/navigation so the client logic is testable under happy-dom.
const createLinkAction = vi.fn();
const listLinkCandidatesAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(authed)/items/[key]/actions', () => ({
  createLinkAction: (...args: unknown[]) => createLinkAction(...args),
  removeLinkAction: vi.fn(),
  listLinkCandidatesAction: (...args: unknown[]) => listLinkCandidatesAction(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { AddLinkControl } from '@/app/(authed)/items/[key]/_components/AddLinkControl';

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
  fireEvent.click(screen.getByRole('button', { name: /Link work item/ }));
}

// Open the issue-search Combobox and type a query — the candidate read is
// query-driven since 6.9.2 (debounced server fetch per keystroke), so nothing
// loads until the user types ≥ the search minimum.
async function typeSearch(query: string) {
  fireEvent.click(await screen.findByRole('combobox', { name: 'Work item to link' }));
  fireEvent.change(await screen.findByRole('combobox', { name: /Search by identifier or title/ }), {
    target: { value: query },
  });
}

describe('AddLinkControl (2.4.9; server-search since 6.9.2)', () => {
  it('expands the form, does NOT fetch until typed, then searches the typed query', async () => {
    open();
    // The kind + issue comboboxes render; Add is disabled until a target is picked.
    expect(screen.getByRole('combobox', { name: 'Relationship' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Work item to link' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    // No fetch on open — the picker is query-driven (closes finding #98's
    // newest-50 prefetch).
    expect(listLinkCandidatesAction).not.toHaveBeenCalled();

    await typeSearch('Callback');
    await waitFor(() =>
      expect(listLinkCandidatesAction).toHaveBeenCalledWith('wi-1', 'blocked_by', 'Callback'),
    );
  });

  it('Cancel collapses the form back to the entry point', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /Link work item/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('selecting a searched target enables Add; a rejected create surfaces the inline error (no refresh)', async () => {
    createLinkAction.mockResolvedValue({ ok: false, error: 'That link already exists.' });
    open();

    // Type to search, then pick the fetched candidate.
    await typeSearch('Callback');
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
