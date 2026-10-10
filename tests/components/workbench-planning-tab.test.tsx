// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type {
  HomeTabCountsDto,
  WorkbenchPlanningPageDto,
  WorkbenchPlanningRowDto,
} from '@/lib/dto/home';
import type { PlanProgressSnapshot } from '@/lib/plans/planProgress';

// THE WORKBENCH'S PLANNING TAB (Story MOTIR-7820 · Subtask MOTIR-7831; design
// `design/workbench/design-notes.md` § 36, mock `workbench--planning.mock.html`).
//
// What only the RENDER can be wrong about, and nothing else covers: the strip's
// eighth tab and its suppression rule, the row's three naming forms and five
// planner forms, the door's two clicks, the scope line, the ceiling note, the empty
// state's gated action — and the live island, which is the real reasoning in this
// card: a 10s visible-only poll whose late response cannot win, whose dropped read
// keeps the rows, whose vanished row is HELD with its outcome, and which asks for
// exactly one `router.refresh()` when the set's size moves (the strip's count is a
// server surface the island cannot reach).
//
// The read itself is covered against real Postgres in
// `tests/integration/workbench/planning-read.test.ts`.

const { push, refresh, shallowPush } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  shallowPush: vi.fn(),
}));
let params = new URLSearchParams('tab=planning');

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, prefetch: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: 'workbench') =>
      createTranslator({ locale: 'en', messages, namespace }),
  };
});

const { PlanningList } = await import('../../app/(authed)/workbench/_components/PlanningList');
const { PlanningEmptyAction } =
  await import('../../app/(authed)/workbench/_components/PlanningEmptyAction');
const { WorkbenchTabs } = await import('../../app/(authed)/workbench/_components/WorkbenchTabs');
const { mergePlanningRows, planningOutcomeOf } =
  await import('../../app/(authed)/workbench/_components/planningOutcome');
const { PLANNING_TAB_CEILING } = await import('@/lib/services/workbenchPlanningService');

const T0 = Date.parse('2026-10-08T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function progress(over: Partial<PlanProgressSnapshot> = {}): PlanProgressSnapshot {
  return {
    startedAt: iso(T0 - 3 * MIN),
    lastActivityAt: iso(T0 - 5_000),
    observedAt: iso(T0),
    authored: 1,
    proposed: 5,
    steps: [],
    ...over,
  };
}

function row(over: Partial<WorkbenchPlanningRowDto> = {}): WorkbenchPlanningRowDto {
  return {
    planId: 'plan-1',
    sessionId: 'sess-1',
    title: null,
    projectName: 'Acme Web',
    targets: [{ key: 'ACME-12', title: 'Per-key API quotas' }],
    author: { source: 'native', harness: null, model: null, origin: 'user' },
    createdAt: iso(T0 - 3 * MIN),
    progress: progress(),
    ...over,
  };
}

function page(items: WorkbenchPlanningRowDto[], total = items.length): WorkbenchPlanningPageDto {
  return { items, total, page: 1, pageSize: PLANNING_TAB_CEILING };
}

const EMPTY = <p>No plans being written</p>;

function mount(
  seed: WorkbenchPlanningPageDto,
  opts: { locale?: 'en' | 'zh'; empty?: React.ReactNode } = {},
) {
  const locale = opts.locale ?? 'en';
  return renderWithIntl(
    <PlanningList
      seed={seed}
      projectName="Acme Web"
      label="Planning"
      empty={opts.empty ?? EMPTY}
    />,
    { locale, messages: locale === 'zh' ? zh : en },
  );
}

/** A poll's answer, resolved on the next microtask flush. */
function answerWith(...pages: WorkbenchPlanningPageDto[]) {
  const fetchMock = vi.fn(async (input: string) => {
    if (String(input).startsWith('/api/plans/')) {
      throw new Error('no plan read stubbed');
    }
    const next = pages.shift();
    if (!next) throw new Error('no page stubbed');
    return { ok: true, json: async () => next } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Advance past one poll interval and let its promise chain settle. */
async function poll(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await act(async () => {});
  }
}

beforeEach(() => {
  params = new URLSearchParams('tab=planning');
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the strip — EIGHT tabs, Planning second (§ 36.2)', () => {
  function counts(over: Partial<HomeTabCountsDto> = {}): HomeTabCountsDto {
    return {
      myWork: 0,
      toDo: 0,
      inProgress: 0,
      toFix: 0,
      toResume: 0,
      recentlyFinished: 0,
      approvals: 0,
      watching: 0,
      planning: 0,
      ...over,
    };
  }

  async function strip(over: Partial<HomeTabCountsDto> = {}) {
    return renderWithIntl(await WorkbenchTabs({ active: 'planning', counts: counts(over) }));
  }

  it('renders Planning second, with `PenLine`, its label and `?tab=planning`', async () => {
    await strip({ planning: 3 });

    const tabs = screen.getAllByRole('link').map((el) => el.dataset['testid']);
    expect(tabs).toEqual([
      'workbench-tab-approvals',
      'workbench-tab-planning',
      'workbench-tab-to-fix',
      'workbench-tab-to-resume',
      'workbench-tab-in-progress',
      'workbench-tab-todo',
      'workbench-tab-finished',
      'workbench-tab-watching',
    ]);
    const planning = screen.getByTestId('workbench-tab-planning');
    expect(planning.getAttribute('href')).toBe('/workbench?tab=planning');
    expect(planning.textContent).toContain('Planning');
    expect(planning.getAttribute('aria-current')).toBe('page');
    expect(planning.querySelector('svg')?.getAttribute('class')).toContain('lucide-pen-line');
    expect(planning.textContent).toContain('3');
  });

  it('suppresses every chip while ALL EIGHT counts are zero, and shows a `0` beside a sibling', async () => {
    const quiet = await strip();
    expect(quiet.container.textContent).not.toMatch(/\d/);
    cleanup();

    // Planning alone is non-zero: every chip renders, the seven zeros included.
    await strip({ planning: 2 });
    expect(screen.getByTestId('workbench-tab-watching').textContent).toContain('0');
  });

  it('reads 规划 in zh, and no new zh string says 待审批', () => {
    // The strip is a Server Component reading `getTranslations`, which this file
    // mocks to the `en` catalogue — so the zh label is asserted where it lives,
    // in the catalogue the strip reads by key.
    expect(zh.workbench.tabs.planning).toBe('规划');
    expect(JSON.stringify(zh.workbench.planning)).not.toContain('待审批');
    expect(JSON.stringify(zh.workbench.empty.planning)).not.toContain('待审批');
  });
});

describe('the row — what the plan is FOR (§ 36.4, § 29 composed)', () => {
  it('names a plan by its first resolvable TARGET, with the key beside it', () => {
    answerWith();
    mount(page([row()]));

    expect(screen.getByText('Plan for')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Per-key API quotas' }).getAttribute('href')).toBe(
      '/items/ACME-12',
    );
    expect(screen.getByText('ACME-12')).toBeTruthy();
  });

  it('falls to the plan TITLE when no target resolves, and to the PROJECT when it has none', () => {
    answerWith();
    mount(
      page([
        row({
          planId: 'plan-untargeted',
          title: 'Billing exports',
          targets: [{ key: 'ACME-99', title: null }],
        }),
        row({ planId: 'plan-untitled', title: null, targets: [] }),
      ]),
    );

    const untargeted = screen.getByTestId('planning-row-plan-untargeted');
    expect(untargeted.textContent).toContain('Plan — Billing exports');
    // The key cell still names an unresolvable target — the sentence cannot.
    expect(untargeted.textContent).toContain('ACME-99');
    expect(screen.getByTestId('planning-row-plan-untitled').textContent).toContain(
      'Plan for Acme Web',
    );
  });

  it('reads several targets as `KEY +n`, with every key in the title attribute', () => {
    answerWith();
    mount(
      page([
        row({
          targets: [
            { key: 'ACME-12', title: 'Per-key API quotas' },
            { key: 'ACME-13', title: 'Rate-limit headers' },
            { key: 'ACME-14', title: null },
          ],
        }),
      ]),
    );

    const cell = screen.getByText('ACME-12 +2');
    expect(cell.getAttribute('title')).toBe('ACME-12, ACME-13, ACME-14');
  });
});

describe('the row — who is WRITING it (§ 36.4)', () => {
  const planner = (author: WorkbenchPlanningRowDto['author']) => {
    answerWith();
    mount(page([row({ author })]));
    return screen.getByTestId('planning-row-plan-1').textContent ?? '';
  };

  it('says Motir AI for the hosted planner', () => {
    expect(planner({ source: 'native', harness: null, model: null, origin: 'user' })).toContain(
      'Motir AI',
    );
  });

  it('names an MCP planner by its harness and its model', () => {
    expect(
      planner({
        source: 'mcp',
        harness: 'Claude Code',
        model: 'frontier-model-long-context',
        origin: 'user',
      }),
    ).toContain('Claude Code · frontier-model-long-context');
  });

  it('names a harness alone, a model alone, and neither', () => {
    expect(
      planner({
        source: 'mcp',
        harness: 'Claude Code (prompts/plan.py)',
        model: null,
        origin: 'user',
      }),
    ).toContain('Claude Code (prompts/plan.py)');
    cleanup();
    expect(
      planner({ source: 'mcp', harness: null, model: 'frontier-model-mini', origin: 'user' }),
    ).toContain('MCP agent · frontier-model-mini');
    cleanup();
    expect(planner({ source: 'mcp', harness: null, model: null, origin: 'user' })).toContain(
      'MCP agent',
    );
  });

  it('renders a model id in a monospace span, with the whole string in `title`', () => {
    answerWith();
    mount(
      page([
        row({
          author: {
            source: 'mcp',
            harness: 'Claude Code',
            model: 'frontier-model',
            origin: 'user',
          },
        }),
      ]),
    );

    const cell = screen.getByTitle('Claude Code · frontier-model');
    expect(cell.querySelector('.font-mono')?.textContent).toBe('frontier-model');
  });
});

describe('the row — its PROGRESS is the compact line, one per row (§ 36.4)', () => {
  it('feeds each row its own snapshot', () => {
    answerWith();
    mount(
      page([
        row({ planId: 'p1', progress: progress({ authored: 1, proposed: 5 }) }),
        row({ planId: 'p2', progress: progress({ authored: 4, proposed: 9 }) }),
      ]),
    );

    const lines = screen.getAllByTestId('plan-progress-compact');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain('1 of 5 authored');
    expect(lines[1]!.textContent).toContain('4 of 9 authored');
  });
});

describe('the row — the DOOR (§ 36.6)', () => {
  it('is a real link to the plan page, named for what it opens', () => {
    answerWith();
    mount(page([row()]));

    const door = screen.getByRole('link', {
      name: 'Open the plan being written — Plan for Per-key API quotas',
    });
    expect(door.getAttribute('href')).toBe('/plans/plan-1');
    expect(door.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('a plain click SHALLOW-PUSHES the planning surface over this tab, carrying `planVia=planning`', () => {
    answerWith();
    mount(page([row()]));

    const door = screen.getByRole('link', { name: /^Open the plan being written/ });
    fireEvent.click(door, { button: 0 });

    expect(shallowPush).toHaveBeenCalledTimes(1);
    const href = shallowPush.mock.calls[0]![0] as string;
    expect(href).toContain('/workbench?tab=planning');
    expect(href).toContain('planSession=sess-1');
    expect(href).toContain('planVia=planning');
  });

  it('a MODIFIED click keeps the real `/plans/<id>` href', () => {
    answerWith();
    mount(page([row()]));

    const door = screen.getByRole('link', { name: /^Open the plan being written/ });
    expect(fireEvent.click(door, { button: 0, metaKey: true })).toBe(true);
    expect(fireEvent.click(door, { button: 1 })).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a plan with NO SESSION navigates to its page instead — no shallow push', () => {
    answerWith();
    mount(page([row({ sessionId: null })]));

    fireEvent.click(screen.getByRole('link', { name: /^Open the plan being written/ }), {
      button: 0,
    });
    expect(shallowPush).not.toHaveBeenCalled();
  });
});

describe('the scope line, the ceiling and the empty state (§ 36.5, § 36.9, § 36.10)', () => {
  it('says what the tab excludes, naming the project and pointing at the Plans page', () => {
    answerWith();
    mount(page([row()]));

    const scope = screen.getByTestId('planning-scope');
    expect(scope.textContent).toBe(
      'Plans you asked for in Acme Web that are still being written. Plans others asked for are on the Plans page.',
    );
    expect(scope.querySelector('a')?.getAttribute('href')).toBe('/plans');
  });

  it('draws NO ceiling note while the set fits, and the note (with no pager) when it does not', () => {
    answerWith();
    mount(page([row()]));
    expect(screen.queryByTestId('planning-ceiling')).toBeNull();
    cleanup();

    answerWith();
    mount(page([row({ planId: 'p1' }), row({ planId: 'p2' })], 53));
    const note = screen.getByTestId('planning-ceiling');
    expect(note.textContent).toContain('Showing your 2 newest plans being written');
    expect(note.textContent).toContain('The other 51');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/plans?status=generating');
    // § 28 DECISION 5's form: a note, never a pager.
    expect(screen.queryByRole('navigation', { name: /pag/i })).toBeNull();
  });

  it('an EMPTY tab draws its empty state and nothing else — no list box, no scope line', () => {
    answerWith();
    mount(page([]));

    expect(screen.getByText('No plans being written')).toBeTruthy();
    expect(screen.queryByTestId('planning-scope')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('planning-ceiling')).toBeNull();
  });

  it('the empty state offers `Plan with AI` only to a reader who can plan here', () => {
    renderWithIntl(<PlanningEmptyAction aiConfigured />);
    const action = screen.getByTestId('planning-empty-action');
    expect(action.textContent).toContain('Plan with AI');
    expect(action.getAttribute('href')).toContain('plan=project');
    cleanup();

    // No planner wired for this build: no button rather than one that is refused.
    const { container } = renderWithIntl(<PlanningEmptyAction aiConfigured={false} />);
    expect(container.textContent).toBe('');
  });
});

describe('the LIVE island — the poll (§ 36.7, § 36.8)', () => {
  it('reads every 10s while the document is visible, and applies the newer rows', async () => {
    const fetchMock = answerWith(page([row({ planId: 'p1' }), row({ planId: 'p2' })]));
    mount(page([row({ planId: 'p1' })]));

    expect(fetchMock).not.toHaveBeenCalled();
    await poll();

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/planning', expect.anything());
    // The arrival lands at the TOP (newest first) and wears `New`.
    const rendered = screen.getAllByTestId(/^planning-row-/).map((el) => el.dataset['testid']);
    expect(rendered).toEqual(['planning-row-p2', 'planning-row-p1']);
    expect(screen.getByText('New')).toBeTruthy();
  });

  it('calls `router.refresh()` EXACTLY ONCE when `total` moved, and not at all when it did not', async () => {
    answerWith(
      page([row({ planId: 'p1' }), row({ planId: 'p2' })], 2),
      page([row({ planId: 'p1' }), row({ planId: 'p2' })], 2),
    );
    mount(page([row({ planId: 'p1' })], 1));

    await poll();
    expect(refresh).toHaveBeenCalledTimes(1);

    await poll();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('HOLDS a row the read dropped, with the outcome it reads once from the plan', async () => {
    const pages = [page([row({ planId: 'p2' })], 1)];
    const fetchMock = vi.fn(async (input: string) => {
      if (String(input) === '/api/plans/p1') {
        return {
          ok: true,
          json: async () => ({ status: 'planned', decisionReason: null }),
        } as unknown as Response;
      }
      const next = pages.shift();
      if (!next) throw new Error('no page stubbed');
      return { ok: true, json: async () => next } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    mount(page([row({ planId: 'p1' }), row({ planId: 'p2' })], 2));
    await poll();

    const heldRow = screen.getByTestId('planning-row-p1');
    // Still on screen, in place, marked held — never removed under the cursor.
    expect(heldRow.dataset['held']).toBe('true');
    expect(heldRow.textContent).toContain('Written');
    expect(heldRow.textContent).toContain('Ready for your review.');
    expect(heldRow.querySelector('a[href="/workbench?tab=approvals"]')?.textContent).toBe(
      'See it in Waiting on you',
    );
    // Its progress line is gone — line 2 is the outcome now.
    expect(screen.getAllByTestId('plan-progress-compact')).toHaveLength(1);
  });

  it('says only that the plan is no longer being written when the outcome read fails', async () => {
    const pages = [page([], 0)];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input).startsWith('/api/plans/')) throw new Error('offline');
        const next = pages.shift();
        if (!next) throw new Error('no page stubbed');
        return { ok: true, json: async () => next } as unknown as Response;
      }),
    );

    mount(page([row({ planId: 'p1' })], 1));
    await poll();

    const heldRow = screen.getByTestId('planning-row-p1');
    expect(heldRow.textContent).toContain('No longer being written.');
    expect(heldRow.textContent).not.toContain('Written');
  });

  it('a LATE response never overwrites a newer one', async () => {
    // The first read resolves AFTER the second: the first page names only `p1`,
    // the second names `p1` + `p2`, and the rows must end up the second's.
    let release: (() => void) | null = null;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          await slow;
          return { ok: true, json: async () => page([row({ planId: 'p1' })], 1) } as Response;
        }
        return {
          ok: true,
          json: async () => page([row({ planId: 'p1' }), row({ planId: 'p2' })], 2),
        } as Response;
      }),
    );

    mount(page([row({ planId: 'p1' })], 1));
    await poll(); // issues read 1, still in flight
    await poll(); // issues read 2, which lands first
    expect(screen.getAllByTestId(/^planning-row-/)).toHaveLength(2);

    await act(async () => {
      release?.();
    });
    await act(async () => {});

    // Read 1's older page is DROPPED: `p2` is still on screen.
    expect(screen.getAllByTestId(/^planning-row-/).map((el) => el.dataset['testid'])).toEqual([
      'planning-row-p2',
      'planning-row-p1',
    ]);
  });

  it('a REJECTED read leaves the last rows on screen, and reports the dropped read after three', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    mount(page([row({ planId: 'p1' })], 1));

    await poll(2);
    expect(screen.getByTestId('planning-row-p1')).toBeTruthy();
    expect(screen.getByTestId('plan-progress-compact').textContent).toContain('1 of 5 authored');

    await poll();
    // Part XXV §25.10's dropped-read form: the counts stand, the dot warns, and the
    // compact line says it is showing the last update. No row leaves on a failed read.
    expect(screen.getByTestId('plan-progress-compact').textContent).toContain('Reconnecting');
    expect(screen.getByTestId('plan-progress-compact').textContent).toContain('1 of 5 authored');
    expect(screen.getByTestId('planning-row-p1')).toBeTruthy();
  });

  it('does NOT read while the document is hidden, and reads at once when it comes back', async () => {
    const fetchMock = answerWith(
      page([row({ planId: 'p1' })], 1),
      page([row({ planId: 'p1' })], 1),
    );
    mount(page([row({ planId: 'p1' })], 1));

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await poll(2);
    expect(fetchMock).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });
});

describe('the pure rules behind the island', () => {
  it('words each outcome from the plan read, and nothing from a plan still generating', () => {
    expect(planningOutcomeOf({ status: 'generating', decisionReason: null })).toBeNull();
    expect(planningOutcomeOf({ status: 'planned', decisionReason: null })).toMatchObject({
      chipKey: 'planned',
      lineKey: 'plannedLine',
    });
    expect(planningOutcomeOf({ status: 'declined', decisionReason: 'discarded' })).toMatchObject({
      chipKey: 'discarded',
    });
    expect(planningOutcomeOf({ status: 'declined', decisionReason: 'abandoned' })).toMatchObject({
      chipKey: 'abandoned',
    });
    // A decline with no recorded reason is the *ended* form, never *stopped*.
    expect(planningOutcomeOf({ status: 'declined', decisionReason: null })).toMatchObject({
      chipKey: 'discarded',
    });
  });

  it('keeps every row the reader had, holds the ones that left, and puts arrivals on top', () => {
    const id = (r: { planId: string }) => r.planId;
    const merged = mergePlanningRows(
      [{ planId: 'a' }, { planId: 'b' }],
      [{ planId: 'c' }, { planId: 'b' }],
      id,
    );
    expect(merged.rows.map(id)).toEqual(['c', 'a', 'b']);
    expect([...merged.heldIds]).toEqual(['a']);
    expect([...merged.arrivedIds]).toEqual(['c']);
  });
});

describe('zh (§ 36.11)', () => {
  it('renders the scope line, the planner and a held outcome in Chinese', async () => {
    const pages = [page([], 0)];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input) === '/api/plans/plan-1') {
          return {
            ok: true,
            json: async () => ({ status: 'declined', decisionReason: 'abandoned' }),
          } as unknown as Response;
        }
        const next = pages.shift();
        if (!next) throw new Error('no page stubbed');
        return { ok: true, json: async () => next } as unknown as Response;
      }),
    );

    mount(page([row()], 1), { locale: 'zh' });
    expect(screen.getByTestId('planning-scope').textContent).toContain('仍在编写的计划');

    await poll();
    const heldRow = screen.getByTestId('planning-row-plan-1');
    expect(heldRow.textContent).toContain('已中止');
    expect(heldRow.textContent).not.toContain('待审批');
  });
});
