// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';

// Hoisted spies the mock factories close over (vi.mock is hoisted above imports).
const { refresh, createIssueActionSpy } = vi.hoisted(() => ({
  refresh: vi.fn(),
  createIssueActionSpy: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('@/app/(authed)/issues/actions', () => ({
  createIssueAction: createIssueActionSpy,
  // The modal now renders ParentPicker, which fetches candidates on mount.
  listCandidateParentsAction: vi.fn(async () => ({ ok: true, candidates: [] })),
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
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });

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
