// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  AiPlanningSettingsEditor,
  isWholeNumberInRange,
  type AutoPlanPauseView,
} from '@/app/(authed)/settings/project/ai-planning/_components/AiPlanningSettingsEditor';
import type { ProjectAiSettingsDto } from '@/lib/dto/projectAiSettings';

// AiPlanningSettingsEditor (Story 7.13 · Subtask MOTIR-919) — the AI-planning
// settings panel, per design/ai-settings/. Driven under happy-dom (DB-free): the
// editor is a pure client consumer of the MOTIR-919
// `PATCH /api/projects/[key]/ai-settings` endpoint, so we stub global fetch and
// assert the design's states:
//   (a) the three cards + their controls render with the design's copy, and the
//       explanation toggle (the Story-7.4 column) is SURFACED here;
//   (b) a dependent control is present but DISABLED until its parent switch is
//       on, and its explanatory callout appears only when the setting is live;
//   (c) validation is inline (`role="alert"`), at the field, and BLOCKS Save;
//   (d) Save fires the right PATCH (optimistic) and REVERTS on failure, with a
//       typed 422 slotting its message under the field it names;
//   (e) the non-admin read-only + Motir-AI-not-connected states disable the
//       controls and say why;
//   (f) the MOTIR-1740 auto-plan PAUSED state — both faces (current /
//       out-of-date), the link out to the waiting plan, when it does NOT render,
//       and that pausing is not disabling.

function dto(over: Partial<ProjectAiSettingsDto> = {}): ProjectAiSettingsDto {
  return {
    aiAutoPlanEnabled: false,
    aiAutoPlanThreshold: 5,
    aiSprintPlanningEnabled: false,
    aiSprintLengthDays: 2,
    aiPlannerModel: null,
    aiGenerateExplanations: false,
    ...over,
  };
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

/** The MOTIR-1740 paused view the server hands down (relative time already
 *  formatted). Defaults to a current (not drifted) waiting plan. */
function pauseView(over: Partial<AutoPlanPauseView> = {}): AutoPlanPauseView {
  return {
    planId: 'pln_8f2',
    plannedWhenLabel: '3 days ago',
    itemCount: 12,
    stale: false,
    staleCount: 0,
    ...over,
  };
}

function mount(
  over: Partial<ProjectAiSettingsDto> = {},
  props: { isAdmin?: boolean; aiConfigured?: boolean; pause?: AutoPlanPauseView | null } = {},
) {
  return render(
    <AiPlanningSettingsEditor
      projectKey="PROD"
      projectName="motir"
      settings={dto(over)}
      isAdmin={props.isAdmin ?? true}
      aiConfigured={props.aiConfigured ?? true}
      pause={props.pause ?? null}
    />,
  );
}

const threshold = () => screen.getByTestId('ai-planning-threshold') as HTMLInputElement;
const sprintLength = () => screen.getByTestId('ai-planning-sprint-length') as HTMLInputElement;
const saveButton = () => screen.getByTestId('ai-planning-save') as HTMLButtonElement;
const autoPlanSwitch = () => screen.getByRole('switch', { name: 'Expand the plan automatically' });
const sprintSwitch = () => screen.getByRole('switch', { name: 'Plan sprints with Motir' });
const explanationsSwitch = () => screen.getByRole('switch', { name: 'Draft a why for each item' });

let fetchMock: ReturnType<typeof vi.fn>;

function okResponse(body: unknown = dto()) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errorResponse(status: number, body: unknown = {}) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AiPlanningSettingsEditor — the three cards', () => {
  it('renders auto-plan, AI sprint planning and planner, with the explanation toggle SURFACED here', () => {
    mount();

    expect(screen.getByText('Auto-plan')).toBeTruthy();
    expect(screen.getByText('AI sprint planning')).toBeTruthy();
    expect(screen.getByText('Planner')).toBeTruthy();

    // Three enable switches — including the Story-7.4 `aiGenerateExplanations`
    // column, which had no UI anywhere before this panel.
    expect(screen.getAllByRole('switch')).toHaveLength(3);
    expect(explanationsSwitch().getAttribute('aria-checked')).toBe('false');

    // The planner-model picker offers the SHIPPED model set (no invented names).
    expect(screen.getByRole('combobox', { name: 'Planner model' })).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
  });

  it('seeds every control from the persisted settings (incl. a pinned planner model)', () => {
    mount({
      aiAutoPlanEnabled: true,
      aiAutoPlanThreshold: 8,
      aiSprintPlanningEnabled: true,
      aiSprintLengthDays: 4,
      aiPlannerModel: 'deepseek-v4-pro',
      aiGenerateExplanations: true,
    });

    expect(autoPlanSwitch().getAttribute('aria-checked')).toBe('true');
    expect(threshold().value).toBe('8');
    expect(sprintLength().value).toBe('4');
    expect(explanationsSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Thorough')).toBeTruthy();
  });

  it('labels each switch BY REFERENCE to its visible text (the name cannot drift)', () => {
    mount();
    const labelledBy = autoPlanSwitch().getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Expand the plan automatically');
  });
});

describe('AiPlanningSettingsEditor — dependent controls + callouts', () => {
  it('keeps a dependent control PRESENT but disabled until its parent switch is on', () => {
    mount();
    expect(threshold().disabled).toBe(true);
    expect(sprintLength().disabled).toBe(true);

    fireEvent.click(autoPlanSwitch());

    expect(threshold().disabled).toBe(false);
    expect(sprintLength().disabled).toBe(true); // its own parent is still off
  });

  it('shows each group’s explanatory callout ONLY while that setting is live', () => {
    mount();
    const guardrail = /never creates work without you/;
    const rationale = /Short sprints keep plan/;
    expect(screen.queryByText(guardrail)).toBeNull();
    expect(screen.queryByText(rationale)).toBeNull();

    fireEvent.click(autoPlanSwitch());
    expect(screen.getByText(guardrail)).toBeTruthy();
    expect(screen.queryByText(rationale)).toBeNull();

    fireEvent.click(sprintSwitch());
    expect(screen.getByText(rationale)).toBeTruthy();
  });

  it('steps within the range and disables each button at its end', () => {
    mount({ aiSprintPlanningEnabled: true, aiSprintLengthDays: 1 });
    const decrease = screen.getByRole('button', { name: 'Decrease sprint length' });
    const increase = screen.getByRole('button', { name: 'Increase sprint length' });

    expect((decrease as HTMLButtonElement).disabled).toBe(true); // at the floor
    fireEvent.click(increase);
    expect(sprintLength().value).toBe('2');
    expect((decrease as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('AiPlanningSettingsEditor — validation', () => {
  it('surfaces a typed threshold error inline (role=alert) and BLOCKS Save', () => {
    mount({ aiAutoPlanEnabled: true });
    fireEvent.change(threshold(), { target: { value: '0' } });

    const alert = screen.getByTestId('ai-planning-threshold-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Enter 1 or more ready items.');
    expect(threshold().getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByTestId('ai-planning-footer-hint').textContent).toBe(
      'Fix the highlighted fields to save',
    );
  });

  it('surfaces an out-of-range sprint length and blocks Save', () => {
    mount({ aiSprintPlanningEnabled: true });
    fireEvent.change(sprintLength(), { target: { value: '30' } });

    expect(screen.getByTestId('ai-planning-sprint-length-error').textContent).toContain(
      'Choose a sprint length between 1 and 14 days.',
    );
    expect(saveButton().disabled).toBe(true);
  });

  it('links the field’s hint AND its error slot via aria-describedby', () => {
    mount({ aiAutoPlanEnabled: true });
    fireEvent.change(threshold(), { target: { value: '0' } });

    const describedBy = threshold().getAttribute('aria-describedby')!.split(' ');
    expect(describedBy).toHaveLength(2);
    expect(document.getElementById(describedBy[0]!)?.textContent).toContain(
      'Motir starts drafting',
    );
    expect(document.getElementById(describedBy[1]!)).toBe(
      screen.getByTestId('ai-planning-threshold-error'),
    );
  });

  it('isWholeNumberInRange rejects blanks, fractions and out-of-range values', () => {
    expect(isWholeNumberInRange('5', 1, 14)).toBe(true);
    expect(isWholeNumberInRange(' 14 ', 1, 14)).toBe(true);
    expect(isWholeNumberInRange('', 1, 14)).toBe(false);
    expect(isWholeNumberInRange('2.5', 1, 14)).toBe(false);
    expect(isWholeNumberInRange('0', 1, 14)).toBe(false);
    expect(isWholeNumberInRange('15', 1, 14)).toBe(false);
    // Floor-only (the threshold's shape): no ceiling is applied client-side.
    expect(isWholeNumberInRange('5000', 1)).toBe(true);
    expect(isWholeNumberInRange('0', 1)).toBe(false);
  });
});

describe('AiPlanningSettingsEditor — save', () => {
  it('is inert until something is dirty, then PATCHes the whole panel', async () => {
    mount();
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(autoPlanSwitch());
    expect(screen.getByTestId('ai-planning-footer-hint').textContent).toBe('Unsaved changes');
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/PROD/ai-settings');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      aiAutoPlanEnabled: true,
      aiAutoPlanThreshold: 5,
      aiSprintPlanningEnabled: false,
      aiSprintLengthDays: 2,
      aiGenerateExplanations: false,
      aiPlannerModel: null, // the Default row CLEARS the override
    });
    // Optimistic + reconciled: the footer settles back to not-dirty.
    await waitFor(() => expect(saveButton().disabled).toBe(true));
  });

  it('sends the pinned model id when one is selected', async () => {
    mount({ aiPlannerModel: 'deepseek-v4-pro', aiGenerateExplanations: true });
    fireEvent.click(explanationsSwitch());
    fireEvent.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({
      aiPlannerModel: 'deepseek-v4-pro',
      aiGenerateExplanations: false,
    });
  });

  it('REVERTS the optimistic snapshot when the save fails', async () => {
    fetchMock.mockResolvedValue(errorResponse(500));
    mount();

    fireEvent.click(autoPlanSwitch());
    fireEvent.click(saveButton());

    // The revert restores the committed snapshot, so the change is still dirty.
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.getByTestId('ai-planning-footer-hint').textContent).toBe('Unsaved changes');
  });

  it('slots a typed 422 under the field the server NAMES', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(422, {
        code: 'INVALID_AI_SETTINGS',
        field: 'aiAutoPlanThreshold',
        error: 'The auto-plan threshold must be between 1 and 1000.',
      }),
    );
    mount({ aiAutoPlanEnabled: true });

    fireEvent.change(threshold(), { target: { value: '5000' } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByTestId('ai-planning-threshold-error').textContent).toContain(
        'must be between 1 and 1000',
      ),
    );
  });

  it('Cancel restores the last-persisted values', () => {
    mount({ aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 });
    fireEvent.change(threshold(), { target: { value: '9' } });
    expect(threshold().value).toBe('9');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(threshold().value).toBe('5');
    expect(saveButton().disabled).toBe(true);
  });
});

describe('AiPlanningSettingsEditor — read-only + not-connected states', () => {
  it('a non-admin gets the lock banner, disabled controls, and NO footer', () => {
    mount({}, { isAdmin: false });

    expect(screen.getByTestId('ai-planning-readonly-banner').textContent).toContain(
      'Only a project admin can change AI planning settings.',
    );
    expect((autoPlanSwitch() as HTMLButtonElement).disabled).toBe(true);
    expect(threshold().disabled).toBe(true);
    expect(screen.queryByTestId('ai-planning-save')).toBeNull();
  });

  it('an unconnected deployment states the reason on ALL THREE cards, with no "Connect" CTA', () => {
    mount({}, { aiConfigured: false });

    const banners = screen.getAllByTestId('ai-planning-not-connected-banner');
    expect(banners).toHaveLength(3);
    expect(banners[0]!.textContent).toContain("Motir AI isn't connected.");
    expect(banners[0]!.textContent).toContain('stay inactive until this deployment is connected');
    // Deliberately no in-app provisioning affordance — that route does not exist.
    expect(screen.queryByRole('button', { name: /connect/i })).toBeNull();
    expect((explanationsSwitch() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AiPlanningSettingsEditor — the auto-plan PAUSED state (MOTIR-1740)', () => {
  const banner = () => screen.getByTestId('ai-planning-paused-banner');

  it('says cadence is paused, and LINKS to the plan that is waiting', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView() });

    expect(banner().textContent).toContain(
      'Auto-plan is paused — a plan is waiting for your review.',
    );
    expect(banner().textContent).toContain('Motir drafts one plan at a time.');
    // The meta line reuses the Plans list's own strings for the same facts.
    expect(banner().textContent).toContain('planned 3 days ago');
    expect(banner().textContent).toContain('12 items');
    // The way OUT — the shipped plan detail (MOTIR-847).
    const link = screen.getByTestId('ai-planning-paused-link');
    expect(link.getAttribute('href')).toBe('/plans/pln_8f2');
    expect(link.textContent).toContain('Review the plan');
  });

  it('announces as a status region, and carries its meaning in WORDS, not colour', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView() });

    expect(banner().getAttribute('role')).toBe('status');
    // The link's accessible name says where it goes; the glyphs are decorative.
    expect(screen.getByRole('link', { name: /Review the plan/ })).toBeTruthy();
    banner()
      .querySelectorAll('svg')
      .forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'));
  });

  it('renders the OUT-OF-DATE face when the waiting plan has drifted', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView({ stale: true, staleCount: 4 }) });

    const stale = screen.getByTestId('ai-planning-paused-stale');
    // The SHIPPED badge string, not a re-authored one.
    expect(stale.textContent).toContain('Out of date');
    expect(stale.textContent).toContain(
      'Your project has changed since this plan was drafted — 4 items may be out of date.',
    );
    // The pause message itself is unchanged — the drift is additive.
    expect(banner().textContent).toContain('a plan is waiting for your review');
  });

  it('shows NO drift treatment when the waiting plan is current', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView() });

    expect(screen.queryByTestId('ai-planning-paused-stale')).toBeNull();
    expect(screen.queryByText('Out of date')).toBeNull();
  });

  it('omits the planned-when clause while the plan is still generating', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView({ plannedWhenLabel: null }) });

    expect(banner().textContent).not.toContain('planned');
    expect(banner().textContent).toContain('12 items');
    expect(screen.getByTestId('ai-planning-paused-link')).toBeTruthy();
  });

  it('renders NOTHING paused when no plan is waiting — the card is exactly as 919 ships it', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: null });

    expect(screen.queryByTestId('ai-planning-paused-banner')).toBeNull();
    // The guardrail callout is untouched by this state.
    expect(screen.getByText(/never creates work without you/)).toBeTruthy();
  });

  it('renders NOTHING paused while auto-plan is off — there is no cadence to pause', () => {
    mount({ aiAutoPlanEnabled: false }, { pause: pauseView() });

    expect(screen.queryByTestId('ai-planning-paused-banner')).toBeNull();

    // …and it appears the moment the reader turns auto-plan on.
    fireEvent.click(autoPlanSwitch());
    expect(screen.getByTestId('ai-planning-paused-banner')).toBeTruthy();
  });

  it('PAUSING IS NOT DISABLING — the switch and the stepper stay interactive', () => {
    mount({ aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 }, { pause: pauseView() });

    expect((autoPlanSwitch() as HTMLButtonElement).disabled).toBe(false);
    expect(threshold().disabled).toBe(false);
    expect(threshold().getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Increase threshold' }));
    expect(threshold().value).toBe('6');
  });

  it('saving settings while paused works normally', async () => {
    mount({ aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 }, { pause: pauseView() });

    fireEvent.change(threshold(), { target: { value: '9' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ aiAutoPlanEnabled: true, aiAutoPlanThreshold: 9 });
    // The banner is a server-derived state — a settings save does not clear it.
    expect(screen.getByTestId('ai-planning-paused-banner')).toBeTruthy();
  });
});
