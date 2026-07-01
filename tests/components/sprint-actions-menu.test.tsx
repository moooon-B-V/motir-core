// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';
import { SprintActionsMenu } from '@/app/(authed)/backlog/_components/SprintActionsMenu';

// SprintActionsMenu + DeleteSprintDialog (Story 4.2 · Subtask 4.2.5 — enabled +
// Delete wired in bug MOTIR-1492). The header ⋯ menu was placed-but-disabled; it
// now opens the shipped Popover menu and its Delete action wires the shipped
// `DELETE /api/sprints/[id]`. This pins the STATE gate (Delete enabled for a
// planned sprint, disabled for an active one) and the delete round-trip as units;
// the full backlog flow (sprint gone → items in backlog) is the sprint-delete
// E2E. fetch is stubbed — the project convention's single allowed mock surface
// for a pure-client component — and the real en catalog renders via renderWithIntl.

function sprint(over: Partial<SprintDto> = {}): SprintDto {
  return {
    id: 'sp7',
    name: 'Sprint 7',
    goal: null,
    state: 'planned',
    startDate: null,
    endDate: null,
    completedAt: null,
    sequence: 7,
    issueCount: 4,
    committedPoints: null,
    committedIssueCount: null,
    ...over,
  };
}

function renderMenu(over: Partial<SprintDto> = {}) {
  const onDeleted = vi.fn();
  const onRenamed = vi.fn();
  render(
    <ToastProvider>
      <SprintActionsMenu sprint={sprint(over)} onRenamed={onRenamed} onDeleted={onDeleted} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Sprint actions' }));
  return { onDeleted, onRenamed };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SprintActionsMenu — state gate', () => {
  it('offers an enabled Delete for a planned sprint', () => {
    renderMenu({ state: 'planned' });
    const del = screen.getByTestId('sprint-delete-sp7');
    expect(del.getAttribute('aria-disabled')).not.toBe('true');
    // It is an actionable menuitem button (not the disabled state-gate div).
    expect(del.tagName).toBe('BUTTON');
  });

  it('disables Delete for an active sprint (it must be completed first)', () => {
    renderMenu({ state: 'active' });
    const del = screen.getByTestId('sprint-delete-sp7');
    expect(del.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('SprintActionsMenu — rename state gate', () => {
  it('offers an enabled Rename for a planned sprint', () => {
    renderMenu({ state: 'planned' });
    const rename = screen.getByTestId('sprint-rename-sp7');
    expect(rename.getAttribute('aria-disabled')).not.toBe('true');
    // An actionable menuitem button (not the disabled complete-sprint state-gate div).
    expect(rename.tagName).toBe('BUTTON');
  });

  it('offers an enabled Rename for an active sprint (active sprints are renameable)', () => {
    renderMenu({ state: 'active' });
    const rename = screen.getByTestId('sprint-rename-sp7');
    expect(rename.getAttribute('aria-disabled')).not.toBe('true');
    expect(rename.tagName).toBe('BUTTON');
  });

  it('disables Rename for a complete sprint (its name is frozen)', () => {
    renderMenu({ state: 'complete' });
    const rename = screen.getByTestId('sprint-rename-sp7');
    expect(rename.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('SprintActionsMenu — rename round-trip', () => {
  it('saving a new name PATCHes /api/sprints/[id] with { name } and fires onRenamed on success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'sp7' }), { status: 200 }));
    const { onRenamed } = renderMenu({ state: 'planned' });

    fireEvent.click(screen.getByTestId('sprint-rename-sp7'));

    // The focus-trapped rename dialog opens; edit the name and save inside it.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Rename sprint')).toBeTruthy();
    const input = screen.getByTestId('sprint-rename-input-sp7') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Sprint 7 — hardening' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onRenamed).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('/api/sprints/sp7');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: 'Sprint 7 — hardening',
    });
  });

  it('keeps Save inert for an unchanged name (a no-op rename does not round-trip)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderMenu({ state: 'planned' });
    fireEvent.click(screen.getByTestId('sprint-rename-sp7'));

    // The input is seeded with the current name → Save disabled, no fetch.
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire onRenamed when the rename is rejected (e.g. not a sprint admin)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'NOT_SPRINT_ADMIN' }), { status: 403 }),
    );
    const { onRenamed } = renderMenu({ state: 'planned' });

    fireEvent.click(screen.getByTestId('sprint-rename-sp7'));
    const dialog = await screen.findByRole('dialog');
    const input = screen.getByTestId('sprint-rename-input-sp7') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    // The error surfaces (a toast) and the callback never runs.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(onRenamed).not.toHaveBeenCalled();
  });
});

describe('SprintActionsMenu — delete round-trip', () => {
  it('confirming Delete calls DELETE /api/sprints/[id] and fires onDeleted on success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const { onDeleted } = renderMenu({ state: 'planned' });

    fireEvent.click(screen.getByTestId('sprint-delete-sp7'));

    // The focus-trapped confirm dialog opens; confirm inside it (the menuitem
    // shares the "Delete sprint" label, so scope to the dialog).
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete sprint?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete sprint' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('/api/sprints/sp7');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('does NOT fire onDeleted when the delete is rejected (e.g. not a sprint admin)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'NOT_SPRINT_ADMIN' }), { status: 403 }),
    );
    const { onDeleted } = renderMenu({ state: 'planned' });

    fireEvent.click(screen.getByTestId('sprint-delete-sp7'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete sprint' }));

    // The error surfaces (a toast) and the callback never runs.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
