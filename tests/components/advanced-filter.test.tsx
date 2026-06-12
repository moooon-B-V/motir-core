// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { LabelDto } from '@/lib/dto/labels';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { EMPTY_FILTER, parseIssueFilter, type IssueFilter } from '@/lib/issues/issueListFilter';
import { decodeFilterParam, encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { FILTER_FIELDS, type FilterFieldDef } from '@/lib/filters/registry';
import { setAdvancedParam } from '@/lib/issues/issueListAdvancedFilter';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The advanced filter BUILDER (Subtask 6.1.4) under happy-dom — the card's
// component AC: rows render FROM the registry (a test-only entry appears with
// zero UI changes), live-apply writes the `?filter=v1:` param round-trippably
// (asserted by decoding the pushed URL), pending rows are excluded from the
// badge + URL, the cap disables Add condition, the facet bar upgrades
// losslessly and shows the superseded state exactly beyond facet
// expressiveness, and the invalid-param callout recovers. The builder only
// NAVIGATES (the URL is the state) — we stub next/navigation and decode hrefs.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/issues',
}));

import { IssueAdvancedFilter } from '@/app/(authed)/issues/_components/IssueAdvancedFilter';
import { IssueFilterBar } from '@/app/(authed)/issues/_components/IssueFilterBar';
import { AdvancedFilterSummary } from '@/app/(authed)/issues/_components/AdvancedFilterSummary';
import { InvalidFilterCallout } from '@/app/(authed)/issues/_components/InvalidFilterCallout';

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
  // The label value editor's bounded autocomplete (6.1.5) — stub the fetch so
  // opening a label row never hits the network; chip names/stale come from the
  // server-resolved `referencedLabels` prop, so an empty window is fine here.
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ labels: [] }),
  }));
});

afterEach(() => {
  push.mockReset();
  cleanup();
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
    key: 'in_progress',
    label: 'In Progress',
    category: 'in_progress',
    color: null,
    position: 'b',
    isInitial: false,
  },
];

const MEMBERS: WorkspaceMemberDTO[] = [
  { userId: 'u-alice', name: 'Alice Chen', email: 'alice@acme.test', role: 'owner' },
  { userId: 'u-dana', name: 'Dana Kim', email: 'dana@acme.test', role: 'member' },
];

const SPRINTS: SprintDto[] = [
  {
    id: 'sp1',
    name: 'Sprint 1',
    goal: null,
    state: 'active',
    startDate: null,
    endDate: null,
    completedAt: null,
    sequence: 1,
    issueCount: 0,
    committedIssueCount: null,
    committedPoints: null,
  } as unknown as SprintDto,
];

// Epic-5 builder fixtures (Subtask 6.1.5): a select CF (with an archived
// option), a number CF, a user CF; two components; two referenced labels.
const CUSTOM_FIELDS: CustomFieldDefinitionDTO[] = [
  {
    id: 'cf-sev',
    key: 'severity',
    label: 'Severity',
    fieldType: 'select',
    description: null,
    position: 'a',
    valueCount: 3,
    options: [
      { id: 'opt-high', label: 'High', position: 'a', archived: false, valueCount: 2 },
      { id: 'opt-crit', label: 'Critical', position: 'b', archived: true, valueCount: 1 },
    ],
  },
  {
    id: 'cf-eff',
    key: 'effort',
    label: 'Effort',
    fieldType: 'number',
    description: null,
    position: 'b',
    valueCount: 1,
    options: [],
  },
  {
    id: 'cf-qa',
    key: 'qa_owner',
    label: 'QA owner',
    fieldType: 'user',
    description: null,
    position: 'c',
    valueCount: 0,
    options: [],
  },
];

const COMPONENTS: ComponentDto[] = [
  { id: 'cmp-api', name: 'API', description: null, defaultAssigneeId: null },
  { id: 'cmp-web', name: 'Web', description: null, defaultAssigneeId: null },
];

const REFERENCED_LABELS: LabelDto[] = [
  { id: 'lbl-perf', name: 'perf-q3' },
  { id: 'lbl-api', name: 'api' },
];

function renderBuilder(
  opts: {
    ast?: FilterAst | null;
    fields?: FilterFieldDef[];
    customFields?: CustomFieldDefinitionDTO[];
    components?: ComponentDto[];
    referencedLabels?: LabelDto[];
  } = {},
) {
  const ast = opts.ast ?? null;
  const filter = ast ? setAdvancedParam(EMPTY_FILTER, ast) : EMPTY_FILTER;
  return renderWithIntl(
    <IssueAdvancedFilter
      filter={filter}
      ast={ast}
      view="tree"
      sort={DEFAULT_SORT}
      statuses={STATUSES}
      members={MEMBERS}
      sprints={SPRINTS}
      customFields={opts.customFields ?? CUSTOM_FIELDS}
      components={opts.components ?? COMPONENTS}
      referencedLabels={opts.referencedLabels ?? REFERENCED_LABELS}
      projectKey="PROD"
      fields={opts.fields}
    />,
  );
}

function openBuilder() {
  fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));
}

/** Decode the `?filter=` param of the LAST pushed href into its AST. */
function lastPushedAst(): FilterAst | null {
  const href = push.mock.calls.at(-1)?.[0] as string;
  const params = new URLSearchParams(href.split('?')[1] ?? '');
  const raw = params.get('filter');
  if (raw === null) return null;
  const decoded = decodeFilterParam(raw);
  if (!decoded.ok) throw new Error(`pushed an undecodable filter: ${raw}`);
  return decoded.ast;
}

describe('IssueAdvancedFilter — the builder', () => {
  it('opens as a labelled dialog with the combinator sentence and footer', () => {
    renderBuilder();
    openBuilder();
    expect(screen.getByRole('dialog', { name: 'Advanced filter' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Combinator' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add condition' })).toBeTruthy();
    expect(screen.getByText('0 of 20 conditions · applied live')).toBeTruthy();
  });

  it('Add condition appends a PENDING row — drawn with the not-applied note, no URL push', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(
      within(row).getByText('Not applied yet — pick a value to activate this condition.'),
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    // pending rows are excluded from the trigger badge
    expect(screen.getByRole('button', { name: /^Advanced$/ })).toBeTruthy();
  });

  it('completing a row live-applies the encoded AST (URL round-trip)', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    // default row: Kind · is any of · (empty kind-select); pick "Bug"
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Kind values' }));
    fireEvent.click(screen.getByRole('option', { name: /Bug/ }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    });
    // the trigger badge now counts the applied row
    expect(
      screen.getByRole('button', { name: 'Advanced filter — 1 condition active' }),
    ).toBeTruthy();
  });

  it('emptying an applied row returns it to pending WITHOUT dropping it (and clears the URL)', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    };
    renderBuilder({ ast });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Bug' }));
    // row still present, now pending; the URL drops the param
    expect(screen.getByRole('group', { name: 'Condition 1' })).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Condition 1' })).getByText(
        'Not applied yet — pick a value to activate this condition.',
      ),
    ).toBeTruthy();
    expect(push).toHaveBeenCalledTimes(1);
    expect(lastPushedAst()).toBeNull();
  });

  it('the field menu RENDERS the registry — a test-only entry appears with zero UI changes', () => {
    const testOnly: FilterFieldDef = {
      id: 'watchers' as never,
      fieldType: 'number',
      nullable: true,
      operators: ['eq', 'gt', 'is_empty', 'is_not_empty'],
    };
    renderBuilder({ fields: [...FILTER_FIELDS, testOnly] });
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    // open the field picker — the entry lists under its raw id (no copy yet)
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('option', { name: 'watchers' }));
    // its operator set populates from the registry def
    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    expect(screen.getByRole('option', { name: '=' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'is empty' })).toBeTruthy();
  });

  it('choosing a zero-arity operator collapses the value slot and applies at once', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'assignee', operator: 'is_any_of', value: ['u-alice'] }],
    };
    renderBuilder({ ast });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    fireEvent.click(screen.getByRole('option', { name: 'is empty' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'assignee', operator: 'is_empty', value: null }],
    });
    // the value editor is gone
    expect(within(row).queryByRole('combobox', { name: 'Assignee values' })).toBeNull();
  });

  it('flipping the combinator to Match any re-applies with `or`', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [
        { field: 'kind', operator: 'is_any_of', value: ['bug'] },
        { field: 'status', operator: 'is_any_of', value: ['todo'] },
      ],
    };
    renderBuilder({ ast });
    openBuilder();
    fireEvent.click(within(screen.getByRole('group', { name: 'Combinator' })).getByText('any'));
    expect(lastPushedAst()?.combinator).toBe('or');
  });

  it('Clear all empties the rows and drops the param', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    };
    renderBuilder({ ast });
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByRole('group', { name: 'Condition 1' })).toBeNull();
    expect(lastPushedAst()).toBeNull();
  });

  it('at the 20-row cap Add condition disables with the cap notice', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: Array.from({ length: 20 }, () => ({
        field: 'kind' as const,
        operator: 'is_any_of' as const,
        value: ['bug'],
      })),
    };
    // NB 20 same-field rows decode fine (the cap is the only structural gate)
    renderBuilder({ ast });
    openBuilder();
    const add = screen.getByRole('button', { name: 'Add condition' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText('Condition limit reached (20) — remove one to add another.'),
    ).toBeTruthy();
  });

  it('restores the builder state from the URL (reload/share)', () => {
    const ast: FilterAst = {
      combinator: 'or',
      conditions: [
        { field: 'status', operator: 'is_none_of', value: ['todo'] },
        { field: 'due', operator: 'in_next_days', value: 14 },
        { field: 'text', operator: 'contains', value: 'oauth' },
      ],
    };
    renderBuilder({ ast });
    openBuilder();
    expect(screen.getByRole('group', { name: 'Condition 1' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Condition 2' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Condition 3' })).toBeTruthy();
    expect(screen.getByText('3 of 20 conditions · applied live')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Text values' }) as HTMLInputElement).value).toBe(
      'oauth',
    );
    expect((screen.getByRole('textbox', { name: 'Day count' }) as HTMLInputElement).value).toBe(
      '14',
    );
  });

  it('debounces free-typing edits into one push', () => {
    vi.useFakeTimers();
    try {
      const ast: FilterAst = {
        combinator: 'and',
        conditions: [{ field: 'text', operator: 'contains', value: 'o' }],
      };
      renderBuilder({ ast });
      openBuilder();
      const input = screen.getByRole('textbox', { name: 'Text values' }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'oa' } });
      fireEvent.change(input, { target: { value: 'oauth' } });
      expect(push).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(push).toHaveBeenCalledTimes(1);
      expect(lastPushedAst()).toEqual({
        combinator: 'and',
        conditions: [{ field: 'text', operator: 'contains', value: 'oauth' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('IssueFilterBar — superseded state + the one-way upgrade (6.1.4)', () => {
  function renderBar(filter: IssueFilter = EMPTY_FILTER, ast: FilterAst | null = null) {
    return renderWithIntl(
      <IssueFilterBar
        filter={filter}
        statuses={STATUSES}
        members={MEMBERS}
        view="tree"
        sort={DEFAULT_SORT}
        ast={ast}
      />,
    );
  }

  const BEYOND: FilterAst = {
    combinator: 'and',
    conditions: [{ field: 'status', operator: 'is_none_of', value: ['todo'] }],
  };
  const WITHIN: FilterAst = {
    combinator: 'and',
    conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo'] }],
  };

  it('marks the facet trigger SUPERSEDED exactly when the AST exceeds facet expressiveness', () => {
    const { unmount } = renderBar(setAdvancedParam(EMPTY_FILTER, BEYOND), BEYOND);
    expect(screen.getByLabelText('Managed in Advanced')).toBeTruthy();
    unmount();
    renderBar(setAdvancedParam(EMPTY_FILTER, WITHIN), WITHIN);
    expect(screen.queryByLabelText('Managed in Advanced')).toBeNull();
  });

  it('the superseded popover is READ-ONLY with the Edit in Advanced hand-off', () => {
    renderBar(setAdvancedParam(EMPTY_FILTER, BEYOND), BEYOND);
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const bug = screen.getByRole('option', { name: 'Bug' }) as HTMLButtonElement;
    expect(bug.disabled).toBe(true);
    fireEvent.click(bug);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit in Advanced' })).toBeTruthy();
  });

  it('Edit in Advanced upgrades the facets LOSSLESSLY into builder rows and swaps the params', () => {
    const facets: IssueFilter = {
      ...EMPTY_FILTER,
      kinds: ['bug'],
      statuses: ['todo'],
      includeUnassigned: true,
    };
    renderBar(facets);
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Advanced' }));
    expect(push).toHaveBeenCalledTimes(1);
    const href = push.mock.calls[0]![0] as string;
    const params = new URLSearchParams(href.split('?')[1] ?? '');
    // the facet params are gone…
    expect(parseIssueFilter({ kind: params.getAll('kind') }).kinds).toEqual([]);
    expect(params.get('q')).toBeNull();
    // …and the AST carries every selection
    const decoded = decodeFilterParam(params.get('filter')!);
    expect(decoded.ok && decoded.ast).toEqual({
      combinator: 'and',
      conditions: [
        { field: 'kind', operator: 'is_any_of', value: ['bug'] },
        { field: 'status', operator: 'is_any_of', value: ['todo'] },
        { field: 'assignee', operator: 'is_any_of', value: ['unassigned'] },
      ],
    });
  });

  it('the facet Clear preserves an active advanced param (it clears FACETS, not the builder)', () => {
    const filter = setAdvancedParam({ ...EMPTY_FILTER, kinds: ['bug'] }, WITHIN);
    renderBar(filter, WITHIN);
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(push).toHaveBeenCalledTimes(1);
    const href = push.mock.calls[0]![0] as string;
    const params = new URLSearchParams(href.split('?')[1] ?? '');
    expect(params.getAll('kind')).toEqual([]);
    expect(params.get('filter')).toBe(encodeFilterParam(WITHIN));
  });
});

describe('AdvancedFilterSummary — the read-only chip readout', () => {
  it('renders one chip per condition with resolved value labels (+ Match any only on OR)', () => {
    const ast: FilterAst = {
      combinator: 'or',
      conditions: [
        { field: 'status', operator: 'is_any_of', value: ['todo', 'in_progress'] },
        { field: 'due', operator: 'in_next_days', value: 14 },
        { field: 'assignee', operator: 'is_any_of', value: ['u-dana', 'unassigned'] },
      ],
    };
    renderWithIntl(
      <AdvancedFilterSummary
        ast={ast}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        referencedLabels={REFERENCED_LABELS}
      />,
    );
    expect(screen.getByText('Match any')).toBeTruthy();
    expect(screen.getByText('is any of To Do, In Progress')).toBeTruthy();
    expect(screen.getByText('in the next 14 days')).toBeTruthy();
    expect(screen.getByText('is any of Dana Kim, Unassigned')).toBeTruthy();
  });

  it('omits the Match-any chip on AND', () => {
    renderWithIntl(
      <AdvancedFilterSummary
        ast={{
          combinator: 'and',
          conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
        }}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        referencedLabels={REFERENCED_LABELS}
      />,
    );
    expect(screen.queryByText('Match any')).toBeNull();
  });
});

describe('InvalidFilterCallout — the typed recoverable state', () => {
  it('renders the alert with the designed copy and Clear filter navigates to the canonical URL', () => {
    renderWithIntl(<InvalidFilterCallout view="list" sort={DEFAULT_SORT} filter={EMPTY_FILTER} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('This filter link couldn’t be read')).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Clear filter' }));
    expect(push).toHaveBeenCalledWith('/issues?view=list');
  });
});

describe('IssueAdvancedFilter — Epic-5 rows (Subtask 6.1.5)', () => {
  function openFieldPicker(rowName = 'Condition 1') {
    const row = screen.getByRole('group', { name: rowName });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    return row;
  }

  it('the field menu groups the dynamic custom-field entries under "Custom fields"', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    openFieldPicker();
    // the group header + every dynamic CF entry + the join fields render
    expect(screen.getByText('Custom fields')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Severity' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Effort' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'QA owner' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Label' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Component' })).toBeTruthy();
  });

  it('a project with no custom fields shows zero CF entries (registry-driven)', () => {
    renderBuilder({ customFields: [] });
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    openFieldPicker();
    expect(screen.queryByText('Custom fields')).toBeNull();
    expect(screen.queryByRole('option', { name: 'Severity' })).toBeNull();
    // the built-in + join fields are still there
    expect(screen.getByRole('option', { name: 'Label' })).toBeTruthy();
  });

  it('builds a select custom-field condition incl. the archived option (URL round-trip)', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = openFieldPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Severity' }));
    // the value editor is the CF option picker; archived options carry the mark
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Severity values' }));
    expect(screen.getByRole('option', { name: 'Critical (archived)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'High' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'cf:cf-sev', operator: 'is_any_of', value: ['opt-high'] }],
    });
  });

  it('builds a component condition (URL round-trip)', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = openFieldPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Component' }));
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Component values' }));
    fireEvent.click(screen.getByRole('option', { name: 'API' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'cmp', operator: 'is_any_of', value: ['cmp-api'] }],
    });
  });

  it('builds a number custom-field comparison (Effort ≥ 3)', () => {
    vi.useFakeTimers();
    try {
      renderBuilder();
      openBuilder();
      fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
      const row = openFieldPicker();
      fireEvent.click(screen.getByRole('option', { name: 'Effort' }));
      // default operator for a number field is `=`; switch to ≥ and type 3
      fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
      fireEvent.click(screen.getByRole('option', { name: '≥' }));
      // numeric input free-typing debounces the live-apply push
      fireEvent.change(within(row).getByRole('textbox', { name: 'Effort values' }), {
        target: { value: '3' },
      });
      vi.advanceTimersByTime(300);
      expect(lastPushedAst()).toEqual({
        combinator: 'and',
        conditions: [{ field: 'cf:cf-eff', operator: 'gte', value: 3 }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a label row from the URL — a deleted referent renders the stale chip + notice', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'lbl', operator: 'is_any_of', value: ['lbl-perf', 'lbl-gone'] }],
    };
    // referencedLabels resolves only the surviving id; 'lbl-gone' is deleted.
    renderBuilder({ ast, referencedLabels: [{ id: 'lbl-perf', name: 'perf-q3' }] });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('perf-q3')).toBeTruthy();
    expect(within(row).getByText('Unknown value')).toBeTruthy();
    expect(
      within(row).getByText(
        'This value no longer exists in the project — this condition matches nothing.',
      ),
    ).toBeTruthy();
    // removing the stale chip re-applies WITHOUT it (it matched nothing)
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Unknown value' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'lbl', operator: 'is_any_of', value: ['lbl-perf'] }],
    });
  });

  it('degrades a deleted custom FIELD to the unknown-field row (kept, removable)', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'cf:cf-gone', operator: 'is_any_of', value: ['opt-x'] }],
    };
    renderBuilder({ ast });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('Unknown field')).toBeTruthy();
    expect(
      within(row).getByText('This field no longer exists — this condition matches nothing.'),
    ).toBeTruthy();
    // it counts as applied (matches nothing) until removed
    expect(screen.getByText('1 of 20 conditions · applied live')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Remove condition 1' }));
    expect(lastPushedAst()).toBeNull();
  });
});

describe('AdvancedFilterSummary — Epic-5 value resolution (6.1.5)', () => {
  function renderSummary(ast: FilterAst, referencedLabels = REFERENCED_LABELS) {
    return renderWithIntl(
      <AdvancedFilterSummary
        ast={ast}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        referencedLabels={referencedLabels}
      />,
    );
  }

  it('resolves CF-option, label, and component value names (with the field labels)', () => {
    renderSummary({
      combinator: 'and',
      conditions: [
        { field: 'cf:cf-sev', operator: 'is_any_of', value: ['opt-high', 'opt-crit'] },
        { field: 'lbl', operator: 'is_none_of', value: ['lbl-api'] },
        { field: 'cmp', operator: 'is_any_of', value: ['cmp-api'] },
      ],
    });
    expect(screen.getByText('Severity')).toBeTruthy();
    expect(screen.getByText('is any of High, Critical (archived)')).toBeTruthy();
    expect(screen.getByText('is none of api')).toBeTruthy();
    expect(screen.getByText('is any of API')).toBeTruthy();
  });

  it('renders a deleted referent as the unknown-value text', () => {
    renderSummary(
      {
        combinator: 'and',
        conditions: [{ field: 'lbl', operator: 'is_any_of', value: ['lbl-gone'] }],
      },
      [],
    );
    expect(screen.getByText('is any of Unknown value')).toBeTruthy();
  });
});
