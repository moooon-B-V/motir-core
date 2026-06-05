// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';

// The Due-date DatePicker opens a Radix Popover (Popper), which needs
// ResizeObserver + pointer-capture / scrollIntoView APIs happy-dom omits.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

// Hoisted spies the mock factories close over (vi.mock is hoisted above imports).
const { refresh, createIssueActionSpy, listCreateLinkCandidatesSpy } = vi.hoisted(() => ({
  refresh: vi.fn(),
  createIssueActionSpy: vi.fn(),
  listCreateLinkCandidatesSpy: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('@/app/(authed)/issues/actions', () => ({
  createIssueAction: createIssueActionSpy,
  // The modal now renders ParentPicker, which fetches candidates on mount.
  listCandidateParentsAction: vi.fn(async () => ({ ok: true, candidates: [] })),
  // 2.4.10: the Linked-issues section fetches link candidates on mount.
  listCreateLinkCandidatesAction: (...args: unknown[]) => listCreateLinkCandidatesSpy(...args),
}));
// Heavy palette deps — only the ⌘K-command test renders AppCommandPalette, but
// the mocks must exist at module-eval time.
vi.mock('@/lib/contexts/theme-context', () => ({
  useTheme: () => ({ pattern: 'system', setPattern: vi.fn() }),
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn() }));
vi.mock('@/app/(authed)/_actions', () => ({ switchWorkspaceAction: vi.fn() }));
vi.mock('@/app/(authed)/_project-actions', () => ({ setActiveProjectAction: vi.fn() }));
// The modal now renders the real MarkdownEditor (client-only Tiptap WYSIWYG) —
// stub it to a textarea labelled by its `label` prop so the Description AND
// Explanation editors are individually addressable.
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (v: string) => void;
    label?: string;
  }) => (
    <textarea
      aria-label={label ?? 'Description'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock('@/lib/blob/uploadClient', () => ({ uploadIssueAttachment: vi.fn() }));

import { CreateIssueProvider } from '@/app/(authed)/_components/CreateIssueProvider';
import { CreateIssueButton } from '@/app/(authed)/_components/CreateIssueButton';
import { CommandPaletteProvider } from '@/app/(authed)/_components/CommandPaletteProvider';
import { CommandPaletteTrigger } from '@/app/(authed)/_components/CommandPaletteTrigger';
import { AppCommandPalette } from '@/app/(authed)/_components/AppCommandPalette';

function Shell({ hasProject = true }: { hasProject?: boolean }) {
  return (
    <ToastProvider>
      <CommandPaletteProvider>
        <CreateIssueProvider hasProject={hasProject}>
          <CommandPaletteTrigger />
          <CreateIssueButton />
          <AppCommandPalette
            workspaces={[]}
            activeWorkspaceId={null}
            projects={[]}
            activeProjectId={null}
            hasProject={hasProject}
          />
        </CreateIssueProvider>
      </CommandPaletteProvider>
    </ToastProvider>
  );
}

const modalHeading = () => screen.queryByRole('heading', { name: 'Create issue' });

beforeEach(() => {
  // Default: the Linked-issues section's mount fetch resolves to no candidates.
  // Individual link tests override this with a candidate set.
  listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CreateIssueModal — entry points', () => {
  it('the top-nav "+" button opens the modal', () => {
    render(<Shell />);
    expect(modalHeading()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
    expect(modalHeading()).not.toBeNull();
  });

  it('the global "C" shortcut opens the modal', () => {
    render(<Shell />);
    expect(modalHeading()).toBeNull();
    fireEvent.keyDown(window, { key: 'c' });
    expect(modalHeading()).not.toBeNull();
  });

  it('the ⌘K palette "Create issue" command opens the modal', async () => {
    render(<Shell />);
    // Open the palette via its trigger (deterministic — no platform-key path).
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    const command = await screen.findByText('Create issue');
    fireEvent.click(command);
    await waitFor(() => expect(modalHeading()).not.toBeNull());
  });

  it('no entry points when there is no active project', () => {
    render(<Shell hasProject={false} />);
    // Button hidden, "C" inert, modal not mounted.
    expect(screen.queryByRole('button', { name: 'Create issue' })).toBeNull();
    fireEvent.keyDown(window, { key: 'c' });
    expect(modalHeading()).toBeNull();
  });
});

describe('CreateIssueModal — validation + submit', () => {
  function openModal() {
    render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
  }

  it('Create is disabled until a non-empty title is entered', () => {
    openModal();
    const submit = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Ship it' } });
    expect(submit.disabled).toBe(false);
    // Whitespace-only is still empty.
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '   ' } });
    expect(submit.disabled).toBe(true);
  });

  it('submit calls createIssueAction with the form values, toasts, and closes', async () => {
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_1', identifier: 'WFD-7' });
    openModal();

    // Type is now the combobox picker — open it and choose Bug.
    fireEvent.click(screen.getByRole('combobox', { name: 'Type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Bug' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Login is broken' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Repro steps…' } });
    // Priority is the combobox picker now (like Type) — open it and choose High.
    fireEvent.click(screen.getByRole('combobox', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('option', { name: 'High' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    expect(createIssueActionSpy).toHaveBeenCalledTimes(1);
    expect(createIssueActionSpy).toHaveBeenCalledWith({
      kind: 'bug',
      title: 'Login is broken',
      descriptionMd: 'Repro steps…',
      explanationMd: null,
      priority: 'high',
      parentId: null,
    });
    // Success path: toast surfaces the identifier, list revalidates, modal closes.
    await waitFor(() => expect(screen.getByText('WFD-7 created')).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(modalHeading()).toBeNull());
  });

  it('expands the optional explanation section and submits its markdown', async () => {
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_2', identifier: 'WFD-8' });
    openModal();

    // Collapsed by default — the editor isn't mounted until expanded.
    expect(screen.queryByLabelText('Explanation')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Explanation' }));

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Add OAuth' } });
    fireEvent.change(screen.getByLabelText('Explanation'), {
      target: { value: 'Why it matters: fewer drop-offs.' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    expect(createIssueActionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ explanationMd: 'Why it matters: fewer drop-offs.' }),
    );
  });

  it('threads a chosen Due date through as a UTC ISO string; a plain create omits it', async () => {
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_3', identifier: 'WFD-9' });
    openModal();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Ship the thing' } });

    // Open the Due-date DatePicker and pick TODAY (always present in the
    // default-open month, whatever date CI runs on).
    fireEvent.click(screen.getByRole('button', { name: 'Due date' }));
    const calendar = await screen.findByRole('dialog', { name: 'Due date' });
    const MONTHS = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const d = now.getUTCDate();
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedIso = new Date(`${y}-${pad(m + 1)}-${pad(d)}T00:00:00.000Z`).toISOString();
    fireEvent.click(within(calendar).getByRole('button', { name: `${MONTHS[m]} ${d}, ${y}` }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(createIssueActionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dueDate: expectedIso }),
    );

    // And a create with no date chosen sends no dueDate key at all (the
    // exact-match test above already pins the plain-create payload shape).
    createIssueActionSpy.mockClear();
    cleanup();
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_4', identifier: 'WFD-10' });
    openModal();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'No due date' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(createIssueActionSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ dueDate: expect.anything() }),
    );
  });

  it('an error result keeps the modal open and toasts the message', async () => {
    createIssueActionSpy.mockResolvedValue({ ok: false, error: 'That project no longer exists.' });
    openModal();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Anything' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    await waitFor(() => expect(screen.getByText('That project no longer exists.')).toBeTruthy());
    expect(modalHeading()).not.toBeNull(); // stays open so the user can retry
  });
});

// ── Subtask 2.4.10 — the create-modal "Linked issues" section ──────────────────
describe('CreateIssueModal — linked issues (2.4.10)', () => {
  const candidate = {
    id: 'cand-1',
    parentId: null,
    kind: 'task' as const,
    key: 9,
    identifier: 'PROD-9',
    title: 'Callback bug',
    status: 'todo',
    priority: 'medium' as const,
    assigneeId: null,
    position: 'a1',
    archivedAt: null,
  };

  function openModal() {
    render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
  }

  // Pick the fetched candidate in the Linked-issues search combobox and click Add.
  async function addPendingLink() {
    fireEvent.click(await screen.findByRole('combobox', { name: 'Issue to link' }));
    fireEvent.click(await screen.findByRole('option', { name: /Callback bug/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  }

  it('collects a pending link as a row and a second Add is excluded for the same pair', async () => {
    listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [candidate] });
    openModal();

    await addPendingLink();

    // The pending row renders (default relationship "Blocked by" + the issue).
    expect(await screen.findByText('Callback bug')).toBeTruthy();
    expect(screen.getByText('PROD-9')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Remove pending blocked by link to PROD-9/ }),
    ).toBeTruthy();

    // The same (target, relationship) pair is now excluded — reopening the
    // combobox offers no candidates.
    fireEvent.click(screen.getByRole('combobox', { name: 'Issue to link' }));
    expect(await screen.findByText('No matching issues.')).toBeTruthy();
  });

  it('removing a pending row drops it', async () => {
    listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [candidate] });
    openModal();

    await addPendingLink();
    const remove = await screen.findByRole('button', {
      name: /Remove pending blocked by link to PROD-9/,
    });
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByText('Callback bug')).toBeNull());
  });

  it('submit threads the collected links to createIssueAction', async () => {
    listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [candidate] });
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_9', identifier: 'WFD-9' });
    openModal();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Needs PROD-9' } });
    await addPendingLink();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    expect(createIssueActionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Needs PROD-9',
        links: [{ targetId: 'cand-1', relationship: 'blocked_by' }],
      }),
    );
  });

  it('a links-field error result keeps the modal open and surfaces inline (no toast)', async () => {
    listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [candidate] });
    createIssueActionSpy.mockResolvedValue({
      ok: false,
      error: 'That would create a dependency cycle.',
      field: 'links',
    });
    openModal();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Cyclic' } });
    await addPendingLink();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    await waitFor(() =>
      expect(screen.getByText('That would create a dependency cycle.')).toBeTruthy(),
    );
    expect(modalHeading()).not.toBeNull(); // stays open; the pending link is preserved
  });
});
