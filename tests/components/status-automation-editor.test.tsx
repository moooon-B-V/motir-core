// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { StatusAutomationEditor } from '@/app/(authed)/settings/project/workflow/_components/StatusAutomationEditor';
import type { ProjectStatusAutomationDto } from '@/lib/dto/projectStatusAutomation';

// StatusAutomationEditor (Story MOTIR-1615 · Subtask MOTIR-1622) — the two
// bidirectional status-derivation switches, per design/projects/design-notes.md
// §1–§7. Driven under happy-dom (DB-free): the editor is a pure client consumer
// of `PATCH /api/projects/[key]/status-automation`, so global fetch is stubbed
// and the design's states are asserted:
//   (a) both switches render ON by default, with the ladder read-out and the
//       cascade's consequence sentence;
//   (b) each switch flips INDEPENDENTLY — the upward-only case (design panel 2)
//       the two-switch model exists to express;
//   (c) Save fires the right PATCH, is optimistic, and REVERTS on failure;
//   (d) the non-admin state disables both switches and shows the lock banner
//       instead of the save footer — disabled, never hidden (design panel 3).

function dto(over: Partial<ProjectStatusAutomationDto> = {}): ProjectStatusAutomationDto {
  return {
    autoRollupParentStatus: true,
    autoCompleteChildrenOnParentDone: true,
    ...over,
  };
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

function editor(over: { settings?: ProjectStatusAutomationDto; isAdmin?: boolean } = {}) {
  return (
    <StatusAutomationEditor
      projectKey="PROD"
      projectName="Acme"
      settings={over.settings ?? dto()}
      isAdmin={over.isAdmin ?? true}
    />
  );
}

/** The two switches, by their visible labels (the accessible name comes by
 *  reference from those labels, so this is the same string a user reads). */
function rollupSwitch() {
  return screen.getByRole('switch', { name: /Roll up parent status from children/i });
}
function cascadeSwitch() {
  return screen.getByRole('switch', { name: /Complete children when a parent is done/i });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(dto()), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StatusAutomationEditor — the default state (MOTIR-1622)', () => {
  it('renders both switches ON, which is what every project starts at', () => {
    render(editor());

    expect(rollupSwitch().getAttribute('aria-checked')).toBe('true');
    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('renders the ladder read-out — WHEN each rung fires, not just that it does', () => {
    render(editor());

    // The whole reason the <dl> exists (design §4): "rolls up parent status"
    // alone does not let an admin predict the behaviour on their board.
    expect(screen.getByText('as soon as any child starts')).toBeTruthy();
    expect(screen.getByText('when the last open child reaches review')).toBeTruthy();
    expect(screen.getByText('when every child is finished or cancelled')).toBeTruthy();
  });

  it('states the cascade CONSEQUENCE — that unstarted children are completed too', () => {
    render(editor());

    // Load-bearing copy (design §3): the one fact that makes this switch's risk
    // legible. Emphasised, and asserted here so it cannot be quietly dropped.
    const emphasised = screen.getByText('This includes children nobody has started yet.');
    expect(emphasised.tagName).toBe('STRONG');
  });

  it('seeds from the SERVER value, not from a hardcoded default', () => {
    render(editor({ settings: dto({ autoCompleteChildrenOnParentDone: false }) }));

    expect(rollupSwitch().getAttribute('aria-checked')).toBe('true');
    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('false');
    // An off cascade swaps its hint for the off-state copy.
    expect(screen.getByText(/closing a parent leaves its children where they are/i)).toBeTruthy();
  });
});

describe('StatusAutomationEditor — the two switches are independent (MOTIR-1622)', () => {
  it('turning the cascade OFF leaves the rollup on — the upward-only case', () => {
    render(editor());

    fireEvent.click(cascadeSwitch());

    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('false');
    expect(rollupSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('turning the rollup OFF leaves the cascade on', () => {
    render(editor());

    fireEvent.click(rollupSwitch());

    expect(rollupSwitch().getAttribute('aria-checked')).toBe('false');
    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('Save is disabled until something actually changes', () => {
    render(editor());

    const save = screen.getByTestId('status-automation-save');
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(cascadeSwitch());
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('Cancel restores the committed values', () => {
    render(editor());

    fireEvent.click(cascadeSwitch());
    fireEvent.click(rollupSwitch());
    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('true');
    expect(rollupSwitch().getAttribute('aria-checked')).toBe('true');
    expect((screen.getByTestId('status-automation-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('StatusAutomationEditor — saving (MOTIR-1622)', () => {
  it('PATCHes both switches to the status-automation endpoint', async () => {
    render(editor());

    fireEvent.click(cascadeSwitch());
    fireEvent.click(screen.getByTestId('status-automation-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/PROD/status-automation');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      autoRollupParentStatus: true,
      autoCompleteChildrenOnParentDone: false,
    });
  });

  it('is OPTIMISTIC — the switch holds its new value while the request is in flight', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    render(editor());

    fireEvent.click(cascadeSwitch());
    fireEvent.click(screen.getByTestId('status-automation-save'));

    // No self-revert while saving: the optimistic value stands, and there is no
    // router.refresh() to re-read stale data over it (CLAUDE.md § page state).
    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      release(new Response(JSON.stringify(dto()), { status: 200 }));
    });
    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('REVERTS the optimistic flip when the server rejects it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'NOPE' }), { status: 403 }));
    render(editor());

    fireEvent.click(cascadeSwitch());
    fireEvent.click(screen.getByTestId('status-automation-save'));

    // The committed snapshot goes back, so the row shows what the server holds —
    // never a switch that LOOKS saved and is not.
    await waitFor(() => {
      expect((screen.getByTestId('status-automation-save') as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('reverts on a network failure too', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    render(editor());

    fireEvent.click(rollupSwitch());
    fireEvent.click(screen.getByTestId('status-automation-save'));

    await waitFor(() => {
      expect((screen.getByTestId('status-automation-save') as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(rollupSwitch().getAttribute('aria-checked')).toBe('true');
  });
});

describe('StatusAutomationEditor — the non-admin state (MOTIR-1622)', () => {
  it('shows the switches DISABLED, not hidden, with the lock banner', () => {
    render(editor({ isAdmin: false }));

    // Design panel 3: a member sees the same setting an admin does, and learns
    // why their items move on their own.
    expect((rollupSwitch() as HTMLButtonElement).disabled).toBe(true);
    expect((cascadeSwitch() as HTMLButtonElement).disabled).toBe(true);
    expect(rollupSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Only a project admin can change status automation.')).toBeTruthy();
  });

  it('replaces the save footer entirely — no dead Save button', () => {
    render(editor({ isAdmin: false }));

    expect(screen.queryByTestId('status-automation-save')).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('cannot save even if a click reaches the disabled switch', () => {
    render(editor({ isAdmin: false }));

    fireEvent.click(cascadeSwitch());

    expect(cascadeSwitch().getAttribute('aria-checked')).toBe('true');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
