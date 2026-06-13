// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { AutomationRuleSummaryDto } from '@/lib/dto/automationRules';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { AUTOMATION_TRIGGER_TYPES } from '@/lib/automation/registry';
import { EDITOR_READY_ACTION_TYPES } from '@/app/(authed)/settings/project/automation/_components/AutomationRuleEditor';
import { ToastProvider } from '@/components/ui/Toast';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Subtask 6.6.5 — the automation settings UI under happy-dom. The card's
// component AC: the list renders its states (rows / empty / cap / auto-disabled
// banner), the editor's When/If/Then is registry-driven (every trigger + action
// the 6.6.1 registries expose appears, with the If group the REUSED 6.1.4
// condition builder), validation gates Save with per-row messages, and the
// enable/disable + delete + create mutations call the 6.6.1 routes.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/settings/project/automation',
}));

import { AutomationSettings } from '@/app/(authed)/settings/project/automation/_components/AutomationSettings';

let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    // Echo a plausible rule back for the writes the UI reconciles.
    if (method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    return {
      ok: true,
      status: 200,
      json: async () => ({ rule: rule({ id: 'saved-1', name: (body.name as string) ?? 'Saved' }) }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const STATUSES: WorkflowStatusDto[] = [
  {
    id: 's1',
    projectId: 'p',
    key: 'todo',
    label: 'To Do',
    category: 'todo',
    color: null,
    position: 'a',
    isInitial: true,
  },
  {
    id: 's2',
    projectId: 'p',
    key: 'review',
    label: 'In Review',
    category: 'in_progress',
    color: null,
    position: 'b',
    isInitial: false,
  },
  {
    id: 's3',
    projectId: 'p',
    key: 'done',
    label: 'Done',
    category: 'done',
    color: null,
    position: 'c',
    isInitial: false,
  },
];
const MEMBERS: WorkspaceMemberDTO[] = [
  { userId: 'u1', name: 'Zhu Yue', email: 'zhuyue@motir.co', role: 'admin' },
  { userId: 'u2', name: 'Bo Philips', email: 'bo@motir.co', role: 'member' },
];

function rule(over: Partial<AutomationRuleSummaryDto> = {}): AutomationRuleSummaryDto {
  return {
    id: 'r1',
    name: 'Bug verification handoff',
    enabled: true,
    trigger: { type: 'transitioned', fromStatusId: null, toStatusId: 'done' },
    condition: null,
    conditionError: null,
    actions: [{ type: 'transition', toStatusId: 'review' }],
    owner: { id: 'u1', name: 'Zhu Yue' },
    consecutiveFailureCount: 0,
    autoDisableThreshold: 10,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
    lastRun: null,
    ...over,
  };
}

function renderSettings(rules: AutomationRuleSummaryDto[]): void {
  const ui: ReactElement = (
    <ToastProvider>
      <AutomationSettings
        projectKey="PROD"
        currentUserName="Zhu Yue"
        initialRules={rules}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={[]}
        customFields={[]}
        components={[]}
        referencedLabels={[]}
      />
    </ToastProvider>
  );
  renderWithIntl(ui);
}

describe('AutomationRuleList — states', () => {
  it('renders a row per rule with owner, trigger pill, and the never-run state', () => {
    renderSettings([
      rule(),
      rule({ id: 'r2', name: 'Auto-watch', trigger: { type: 'field_changed', field: 'assignee' } }),
    ]);
    expect(screen.getByText('Bug verification handoff')).toBeTruthy();
    expect(screen.getByText('Auto-watch')).toBeTruthy();
    expect(screen.getByText('When transitioned')).toBeTruthy();
    expect(screen.getByText('When field changed')).toBeTruthy();
    expect(screen.getAllByText('Never run').length).toBe(2);
  });

  it('renders the empty state with a Create rule action', () => {
    renderSettings([]);
    expect(screen.getByText('No rules yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create rule' })).toBeTruthy();
  });

  it('shows the auto-disabled banner + Re-enable for a failure-disabled rule', () => {
    renderSettings([rule({ enabled: false, consecutiveFailureCount: 10 })]);
    expect(screen.getByText(/disabled automatically after 10 consecutive failures/)).toBeTruthy();
    expect(screen.getByText('Auto-disabled · 10 failures')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-enable' })).toBeTruthy();
  });

  it('disables Create at the 100-rule cap', () => {
    const many = Array.from({ length: 100 }, (_, i) => rule({ id: `r${i}`, name: `Rule ${i}` }));
    renderSettings(many);
    const createButtons = screen.getAllByRole('button', { name: 'Create rule' });
    expect(createButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe('AutomationSettings — list mutations call the 6.6.1 routes', () => {
  it('toggling a rule PUTs the /enabled route', async () => {
    renderSettings([rule()]);
    fireEvent.click(screen.getByRole('switch', { name: /Enabled — Bug verification handoff/ }));
    await Promise.resolve();
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/enabled'));
    expect(call).toBeTruthy();
    expect(call![1].method).toBe('PUT');
    expect(JSON.parse(call![1].body)).toEqual({ enabled: false });
  });

  it('deleting a rule DELETEs after confirm', async () => {
    renderSettings([rule()]);
    fireEvent.click(screen.getByRole('button', { name: /Actions for Bug verification handoff/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }));
    await Promise.resolve();
    const call = fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'DELETE');
    expect(call).toBeTruthy();
    expect(String(call![0])).toContain('/automation-rules/r1');
  });
});

describe('AutomationRuleEditor — registry-driven when/if/then', () => {
  function openCreate(): void {
    renderSettings([]);
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }));
  }

  it('renders the three blocks and the reused condition builder', () => {
    openCreate();
    expect(screen.getByText('When')).toBeTruthy();
    expect(screen.getByText('If')).toBeTruthy();
    expect(screen.getByText('Then')).toBeTruthy();
    // The If group is the SAME 6.1.4 builder (its "Add condition" affordance).
    expect(screen.getByRole('button', { name: 'Add condition' })).toBeTruthy();
  });

  it('the trigger picker renders EVERY registered trigger (registry-driven)', () => {
    openCreate();
    fireEvent.click(screen.getByRole('combobox', { name: 'Trigger' }));
    const expected: Record<string, string> = {
      created: 'Item created',
      transitioned: 'Item transitioned',
      field_changed: 'Field value changed',
      commented: 'Item commented',
    };
    for (const type of AUTOMATION_TRIGGER_TYPES) {
      expect(screen.getByRole('option', { name: expected[type] })).toBeTruthy();
    }
  });

  it('the action picker renders the editor-ready actions (registry-driven; Epic-5 actions gated until their editors land)', () => {
    openCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Action type' }));
    const expected: Record<string, string> = { transition: 'Transition', set_field: 'Set field' };
    for (const type of EDITOR_READY_ACTION_TYPES) {
      expect(screen.getByRole('option', { name: expected[type] })).toBeTruthy();
    }
    // The four 6.6.3 Epic-5 actions (add_watcher / add_comment / add_label /
    // set_custom_field) are NOT offered yet — their config editors are a 6.6.5
    // follow-up, so the picker gates them out (the backend fully supports them).
    expect(screen.queryByRole('option', { name: 'Add comment' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Add watcher' })).toBeNull();
  });

  it('gates Save: a nameless, action-less rule surfaces the validation messages', () => {
    openCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(screen.getByText('Give the rule a name.')).toBeTruthy();
    expect(screen.getByText('Add at least one action.')).toBeTruthy();
    // No write fired while incomplete.
    expect(fetchMock.mock.calls.some(([, init]) => init && init.method !== 'GET')).toBe(false);
  });

  it('creates a rule: fills name + a transition action, POSTs the payload', async () => {
    openCreate();
    fireEvent.change(screen.getByRole('textbox', { name: 'Rule name' }), {
      target: { value: 'Move to review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    // The default action is "transition" — set its target status. The option's
    // value is the status KEY ('review'), the unit the engine + updateStatus use.
    fireEvent.click(screen.getByRole('combobox', { name: 'Target status' }));
    fireEvent.click(screen.getByRole('option', { name: 'In Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    await Promise.resolve();
    const call = fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'POST');
    expect(call).toBeTruthy();
    const body = JSON.parse(call![1].body) as Record<string, unknown>;
    expect(body.name).toBe('Move to review');
    expect(body.triggerType).toBe('created');
    expect(body.actions).toEqual([{ type: 'transition', toStatusId: 'review' }]);
  });
});
