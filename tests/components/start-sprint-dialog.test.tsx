// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';

// Start-sprint flow UI (Story 4.4 · Subtask 4.4.5). The StartSprintDialog wires
// the design's start modal (design/sprints/sprint-lifecycle.mock.html panels 1–3)
// to the backlog Start-sprint entry point, binding to the shipped backend
// (POST /api/sprints/[id]/start, PATCH /api/sprints/[id]). Real Postgres is not
// in scope for a pure-client modal — fetch + the router are stubbed (the project
// convention's single allowed mock surface for a UI unit), and the dialog renders
// the real next-intl English catalog via renderWithIntl.

// Radix Popover (the custom-date DatePicker) needs APIs happy-dom omits.
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

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

import { StartSprintDialog } from '@/app/(authed)/backlog/_components/StartSprintDialog';

function sprint(over: Partial<SprintDto> = {}): SprintDto {
  return {
    id: 'sp7',
    name: 'Sprint 7',
    goal: 'Ship the sprint lifecycle.',
    state: 'planned',
    startDate: null,
    endDate: null,
    completedAt: null,
    sequence: 7,
    issueCount: 8,
    committedPoints: null,
    committedIssueCount: null,
    ...over,
  };
}

function renderDialog(over: { sprint?: SprintDto; activeSprint?: SprintDto | null } = {}) {
  const onOpenChange = vi.fn();
  const onStarted = vi.fn();
  render(
    <ToastProvider>
      <StartSprintDialog
        open
        onOpenChange={onOpenChange}
        sprint={over.sprint ?? sprint()}
        projectName="prodect"
        activeSprint={over.activeSprint ?? null}
        onStarted={onStarted}
      />
    </ToastProvider>,
  );
  return { onOpenChange, onStarted };
}

function okJson(body: unknown = {}) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
}
function errJson(status: number, code: string) {
  return Promise.resolve({ ok: false, status, json: async () => ({ code }) } as Response);
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(() => okJson());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('StartSprintDialog (4.4.5)', () => {
  it('renders the start modal — name, the duration deck, the derived window, the committed summary', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: 'Start sprint' })).toBeTruthy();
    // Duration deck (the Jira durations + Custom).
    for (const label of ['1 week', '2 weeks', '3 weeks', '4 weeks', 'Custom']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    // Default 2-week window → a 13-day inclusive span (start … start+13).
    expect(screen.getByText(/ends in 13 days/)).toBeTruthy();
    // Committed baseline preview reads the sprint's issue count.
    expect(screen.getByText(/8 issues committed at start/)).toBeTruthy();
  });

  it('derives the window from the chosen duration', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '1 week' }));
    expect(screen.getByText(/ends in 6 days/)).toBeTruthy();
  });

  it('reveals explicit start/end date pickers when Custom is chosen', () => {
    renderDialog();
    expect(screen.queryByLabelText('End date')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByLabelText('Start date')).toBeTruthy();
    expect(screen.getByLabelText('End date')).toBeTruthy();
  });

  it('starts the sprint and navigates to /boards ("board opens")', async () => {
    const { onStarted } = renderDialog();
    fireEvent.click(getStartButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/boards'));
    // Start is one atomic call: the window + name + goal all ride in the /start
    // POST (finding #68 — no separate pre-start goal PATCH).
    const startCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/start'));
    expect(startCall).toBeTruthy();
    const [, init] = startCall!;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('Sprint 7');
    // Goal untouched → the existing goal rides along in the same POST.
    expect(body.goal).toBe('Ship the sprint lifecycle.');
    expect(body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.endDate >= body.startDate).toBe(true);
    expect(onStarted).toHaveBeenCalled();
    // Exactly one request, and it is never a PATCH (the pre-start goal PATCH is gone).
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(
      false,
    );
  });

  it('sends an edited goal in the single /start POST — never a pre-start PATCH (finding #68)', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Sprint goal'), {
      target: { value: 'A brand new goal' },
    });
    fireEvent.click(getStartButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/boards'));
    // The edited goal is carried by the ONE /start POST (atomic), not a PATCH.
    const startCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/start'));
    expect(startCall).toBeTruthy();
    expect((startCall![1] as RequestInit).method).toBe('POST');
    expect(JSON.parse((startCall![1] as RequestInit).body as string).goal).toBe('A brand new goal');
    // Zero PATCH calls, and exactly one request total.
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(
      false,
    );
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('clears the goal by sending null in the /start POST when emptied', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Sprint goal'), { target: { value: '   ' } });
    fireEvent.click(getStartButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/boards'));
    const startCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/start'));
    expect(JSON.parse((startCall![1] as RequestInit).body as string).goal).toBeNull();
  });

  it('proactively blocks + names the active sprint when the project already has one', () => {
    renderDialog({ activeSprint: sprint({ id: 'sp6', name: 'Sprint 6', state: 'active' }) });
    // The blocked alert (mock panel 3) shows up front, naming the active sprint…
    expect(screen.getByText(/prodect already has an active sprint \(Sprint 6\)/)).toBeTruthy();
    // …and Start is disabled, so clicking issues no start request.
    expect(getStartButton().disabled).toBe(true);
    fireEvent.click(getStartButton());
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/start'))).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('surfaces a 409 race (another sprint activated after load) and does not navigate', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith('/start') ? errJson(409, 'SPRINT_ALREADY_ACTIVE') : okJson(),
    );
    // No active sprint known at render → Start is enabled; the server is the
    // backstop that rejects the concurrent activation with the friendly 409.
    renderDialog();
    fireEvent.click(getStartButton());
    expect(await screen.findByText(/prodect already has an active sprint\./)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('renders the inline window error on a 422 and does not navigate', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith('/start') ? errJson(422, 'SPRINT_WINDOW_INVALID') : okJson(),
    );
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.click(getStartButton());
    expect(await screen.findByText(/End date must be after the start date/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('disables Start when the name is empty', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Sprint name'), { target: { value: '   ' } });
    expect(getStartButton().disabled).toBe(true);
  });
});

// The footer primary button (label "Start sprint") — disambiguated from the
// dialog heading of the same text.
function getStartButton(): HTMLButtonElement {
  const buttons = screen.getAllByRole('button', { name: 'Start sprint' });
  return buttons[buttons.length - 1] as HTMLButtonElement;
}
