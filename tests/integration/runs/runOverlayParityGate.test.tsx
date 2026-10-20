// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../../helpers/renderWithIntl';
import { RunModal } from '@/app/(authed)/runs/_components/RunModal';
import { RunsIndex } from '@/app/(authed)/runs/_components/RunsIndex';
import type { RoadmapLevel } from '@/components/planning/ProjectRoadmapCanvas';
import { db } from '@/lib/db';
import type { DispatchCardDisposition } from '@/lib/dto/dispatchRuns';
import {
  RAIL_KEYBOARD_STEP_PX,
  SPLIT_MIN_CONTAINER_PX,
  railBounds,
} from '@/lib/planning/railWidth';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import { DISPOSITION_TONE } from '@/lib/runs/timeline';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { readerRoutes } from '@/lib/visitor/routes';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { projectAccessData } from '../../helpers/projectAccess';
import { consentedVisitor } from '../../visitor/_consentedVisitor';

// STORY GATE — THE RUN OVERLAY WORKS LIKE THE PLAN OVERLAY, AND THE RUNS LIST NAMES
// EACH RUN'S TARGET (Story MOTIR-8982 · MOTIR-9075).
//
// ⚠️ WHAT THIS FILE IS NOT. Each code card pinned its own half with the other half
// stubbed: the target is asserted on DTOs and the cell on a hand-built factory row;
// the toggle with the console stubbed away; the console alone. None of that is
// re-asserted here. WHAT IS: the assembled seams —
//
//   A. the index's target, from a REAL row (`dispatchRunService.listRunsForProject`)
//      to the REAL `RunsIndex` cell;
//   B. the overlay's List | Canvas seam, from real legs to the real console;
//   C. the split and the wrap, assembled with the real children.
//
// Mocked — the boundaries OUTSIDE the path under test, and nothing in it:
//   · `fetch`, the HTTP transport a client island reads through — and every answer it
//     gives is served FROM the real service, never from a hand-built fixture;
//   · `next/navigation` (the index reads `useSearchParams`);
//   · the canvas component (it measures its own box, which happy-dom has none of) —
//     captured, so its `loadLevel` is driven directly and its node CONTENT is rendered;
//   · the roadmap read, served from the real work-item rows.
//
// ⚠️ THIS LANE PERFORMS NO LAYOUT. No assertion below reads `getBoundingClientRect`,
// `offsetWidth`, `scrollWidth` or `clientWidth` of a rendered element — happy-dom
// answers 0 for every one, so such an assertion compares 0 with 0 and is green on the
// unfixed component. (`clientWidth` is STUBBED, below, only to hand the split its
// container's width; it is never asserted on.) The pixel claim is the story E2E card's.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let params = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => params,
}));

let captured: { loadLevel: (parentId: string | null) => Promise<RoadmapLevel> } | null = null;
vi.mock('@/components/planning/ProjectRoadmapCanvas', () => ({
  ProjectRoadmapCanvas: (props: {
    loadLevel: (parentId: string | null) => Promise<RoadmapLevel>;
  }) => {
    captured = props;
    return <div data-testid="canvas" />;
  },
}));

// The roadmap read: served from the real rows, or made to fail.
const roadmap = vi.hoisted(() => ({
  read: null as null | ((ids: string[]) => Promise<unknown>),
}));
vi.mock('@/lib/planning/roadmapClient', () => ({
  fetchRoadmapLevel: (...args: unknown[]) => {
    if (!roadmap.read) throw new Error('roadmap read not armed');
    return roadmap.read((args[5] as string[] | undefined) ?? []);
  },
}));

// ── Geometry the split needs and happy-dom lacks ────────────────────────────
let containerWidth = 1440;
const observers = new Set<{ cb: ResizeObserverCallback; el: Element }>();

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset?.testid === 'resizable-split' ? containerWidth : 0;
    },
  });
  class RO implements ResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      observers.add({ cb: this.cb, el });
    }
    unobserve() {}
    disconnect() {
      for (const o of observers) if (o.cb === this.cb) observers.delete(o);
    }
  }
  globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  globalThis.matchMedia ??= ((q: string) =>
    ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof matchMedia;
});

function resizeTo(width: number) {
  containerWidth = width;
  act(() => {
    for (const o of observers) {
      o.cb(
        [{ contentRect: { width } } as unknown as ResizeObserverEntry],
        null as unknown as ResizeObserver,
      );
    }
  });
}

let seq = 0;
let fx: WorkItemFixture;
let previousCloud: string | undefined;
const fetchMock = vi.fn();

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  previousCloud = process.env['MOTIR_CLOUD'];
  params = new URLSearchParams();
  captured = null;
  containerWidth = 1440;
  observers.clear();
  window.localStorage.clear();
  fetchMock.mockReset();
  roadmap.read = null;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  // The modal re-reads the run when its stream says `done`; let that read finish
  // so no backend of this test is still working when the next one truncates.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Seeding, all through the shipped services ───────────────────────────────

/** A story with `count` subtasks, created through the real service. */
async function seedStory(count: number): Promise<{ storyKey: string; keys: string[] }> {
  const parent = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'A story a run works' },
    fx.ctx,
  );
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', parentId: parent.id, title: `Card ${i + 1}` },
      fx.ctx,
    );
    keys.push(child.identifier);
  }
  return { storyKey: parent.identifier, keys };
}

async function open(opts: {
  keys: string[];
  command?: 'run' | 'batch' | 'auto';
  scopeKey?: string;
  scopeLabel?: string;
  skipped?: Record<string, 'needs_planning'>;
}): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: opts.command ?? 'batch',
      reportedBy: 'cli',
      ...(opts.scopeKey ? { scopeKey: opts.scopeKey } : {}),
      ...(opts.scopeLabel ? { scopeLabel: opts.scopeLabel } : {}),
      cards: opts.keys.map((key) =>
        opts.skipped?.[key]
          ? { key, disposition: 'skipped' as const, skipReason: opts.skipped[key] }
          : { key, disposition: 'queued' as const },
      ),
    },
    fx.ctx,
  );
  return run.id;
}

const listRuns = () =>
  dispatchRunService
    .listRunsForProject(fx.projectIdentifier, { take: 20 }, fx.ctx)
    .then((page) => page.runs);

function mountIndex(runs: Awaited<ReturnType<typeof listRuns>>) {
  return render(
    <RunsIndex
      projectKey={fx.projectIdentifier}
      initialLive={runs}
      initialPast={[]}
      pageSize={20}
    />,
  );
}

// ═══ A — THE INDEX'S TARGET, FROM A REAL ROW TO THE RENDERED CELL ═══════════

describe('A — the index’s target read, from a real row to the rendered cell', () => {
  it('A1 · a scoped run over three children names the scope’s KEY, links it, and shows +3', async () => {
    const { storyKey, keys } = await seedStory(3);
    const scope = await adminDb.workItem.findFirstOrThrow({ where: { identifier: storyKey } });
    // The label is the scope's TITLE, as shipped writers store it — an implementation
    // that reads the label names "A story a run works" and fails below.
    await open({ keys, command: 'run', scopeKey: storyKey, scopeLabel: 'A story a run works' });

    const [row] = await listRuns();
    expect({ key: row!.targetKey, id: row!.targetWorkItemId, others: row!.otherCardCount }).toEqual(
      { key: storyKey, id: scope.id, others: 3 },
    );

    mountIndex([row!]);
    const link = screen.getByRole('link', { name: storyKey });
    expect(link.getAttribute('href')).toBe(readerRoutes(null).item(storyKey));
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('A2 · the fallback is the leg at position 0 — order, not sorting', async () => {
    const { keys } = await seedStory(3);
    // Claimed out of alphabetical order: sorting by key, or taking the last leg, differs.
    const claimed = [keys[2]!, keys[0]!, keys[1]!];
    await open({ keys: claimed });

    const [row] = await listRuns();
    expect(row!.targetKey).toBe(claimed[0]);
    expect(row!.otherCardCount).toBe(2);

    mountIndex([row!]);
    expect(screen.getByRole('link', { name: claimed[0]! })).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('A3 · a card that is its own scope counts nothing beyond it and renders no +N', async () => {
    const { keys } = await seedStory(1);
    await open({ keys });

    const [row] = await listRuns();
    expect(row!.otherCardCount).toBe(0);

    mountIndex([row!]);
    expect(screen.getByRole('link', { name: keys[0]! })).toBeTruthy();
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it('A4 · a deleted scope keeps its label as TEXT, with no link and the door still there', async () => {
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Soon gone' },
      fx.ctx,
    );
    await open({ keys: [], command: 'run', scopeKey: parent.identifier, scopeLabel: 'Soon gone' });
    await adminDb.workItem.delete({ where: { id: parent.id } });

    const [row] = await listRuns();
    expect(row!.targetKey).toBe('Soon gone');
    expect(row!.targetWorkItemId).toBeNull();

    mountIndex([row!]);
    expect(screen.getByText('Soon gone')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Soon gone' })).toBeNull();
    expect(screen.getByTestId('run-open')).toBeTruthy();
  });

  it('A5 · no scope and no legs: no target text, no +N, the door stays, Items says none', async () => {
    await open({ keys: [], command: 'auto' });

    const [row] = await listRuns();
    expect(row).toMatchObject({ targetKey: null, otherCardCount: 0 });

    mountIndex([row!]);
    expect(screen.getByTestId('run-open')).toBeTruthy();
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
    expect(screen.getByText('Took no work items')).toBeTruthy();
  });

  it('A6 · withholding: the visitor’s list renders the visible target and no cell shows the hidden key', async () => {
    process.env['MOTIR_CLOUD'] = 'true';
    const identifier = `VG${seq++}`;
    const vfx = await makeWorkItemFixture({ name: `VG ${identifier}`, identifier });
    await adminDb.project.update({
      where: { id: vfx.projectId },
      data: projectAccessData('public'),
    });
    const epic = await workItemsService.createWorkItem(
      { projectId: vfx.projectId, kind: 'epic', title: 'Private epic' },
      vfx.ctx,
    );
    const hidden = await workItemsService.createWorkItem(
      { projectId: vfx.projectId, kind: 'story', title: 'Hidden story', parentId: epic.id },
      vfx.ctx,
    );
    const visible = await workItemsService.createWorkItem(
      { projectId: vfx.projectId, kind: 'story', title: 'Visible story' },
      vfx.ctx,
    );
    await adminDb.workItem.update({ where: { id: epic.id }, data: { publicChildrenHidden: true } });
    const seed = (scopeWorkItemId: string) =>
      adminDb.dispatchRun.create({
        data: {
          workspaceId: vfx.workspaceId,
          projectId: vfx.projectId,
          command: 'run_scope',
          status: 'running',
          scopeWorkItemId,
          cards: {
            create: { workspaceId: vfx.workspaceId, workItemId: scopeWorkItemId, position: 0 },
          },
        },
      });
    await seed(hidden.id);
    await seed(visible.id);

    const visitor = await consentedVisitor(identifier);
    const page = await dispatchRunService.listRunsForProject(identifier, { take: 20 }, visitor);

    render(
      <RunsIndex projectKey={identifier} initialLive={page.runs} initialPast={[]} pageSize={20} />,
    );
    // Both halves in ONE case: a blanket blank cannot pass.
    expect(screen.getByRole('link', { name: visible.identifier })).toBeTruthy();
    expect(document.body.textContent).not.toContain(hidden.identifier);
  });
});

// ═══ B — THE OVERLAY'S LIST | CANVAS SEAM ═══════════════════════════════════

const DISPOSITIONS = Object.keys(DISPOSITION_TONE) as DispatchCardDisposition[];

/** Serve the run read and its event stream FROM THE REAL SERVICE. */
function serveRun(runId: string) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/stream')) {
      const { events, status } = await dispatchRunService.readStreamPage(runId, 0, 500, fx.ctx);
      const frames = events.map((e) => `event: event\ndata: ${JSON.stringify(e)}\n\n`);
      const live = status === 'running';
      if (!live) frames.push('event: done\ndata: {}\n\n');
      const chunks = [new TextEncoder().encode(frames.join(''))];
      let i = 0;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () =>
              i < chunks.length
                ? { done: false, value: chunks[i++] }
                : live
                  ? new Promise<never>(() => {})
                  : { done: true, value: undefined },
          }),
        },
      };
    }
    const dto = await dispatchRunService.getRunDetail(runId, fx.ctx);
    return { ok: true, status: 200, json: async () => dto };
  });
}

/** The roadmap read, answered from the real work-item rows. */
function serveRoadmap() {
  roadmap.read = async (ids) => {
    const rows = await adminDb.workItem.findMany({ where: { id: { in: ids } } });
    return {
      items: rows.map((w) => ({
        id: w.id,
        parentId: w.parentId,
        identifier: w.identifier,
        title: w.title,
        kind: w.kind,
        status: w.status,
        statusLabel: w.status,
        statusCategory: 'todo',
        hasChildren: false,
      })),
      edges: [],
      offLevelBlockers: [],
    } as unknown as RoadmapLevelData;
  };
}

async function mountModal(runId: string) {
  serveRun(runId);
  render(<RunModal runId={runId} projectKey={fx.projectIdentifier} onClose={() => {}} />);
  await screen.findByTestId('run-modal-log-region');
  await act(async () => {});
}

/** A run with one leg per disposition, a skipped one carrying its reason, and a leg whose work item is gone. */
async function seedEveryDisposition() {
  const { keys } = await seedStory(DISPOSITIONS.length + 1);
  const skippedKey = keys[DISPOSITIONS.indexOf('skipped')]!;
  const runId = await open({ keys, skipped: { [skippedKey]: 'needs_planning' } });
  const cards = await adminDb.dispatchRunCard.findMany({
    where: { dispatchRunId: runId },
    orderBy: { position: 'asc' },
  });
  for (const [i, card] of cards.entries()) {
    const disposition = DISPOSITIONS[i];
    if (disposition && disposition !== 'skipped') {
      await adminDb.dispatchRunCard.update({ where: { id: card.id }, data: { disposition } });
    }
  }
  // The last leg: its work item is gone.
  await adminDb.dispatchRunCard.update({
    where: { id: cards[cards.length - 1]!.id },
    data: { workItemId: null },
  });
  return { runId, keys };
}

describe('B — the overlay’s List | Canvas seam, from real legs to the real console', () => {
  it('B1 · one row per leg in run order, and each row’s word is the canvas badge’s', async () => {
    serveRoadmap();
    const { runId, keys } = await seedEveryDisposition();
    await mountModal(runId);

    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    const rows = await screen.findAllByTestId('run-set-row');
    expect(rows).toHaveLength(keys.length);
    expect(rows.map((r) => r.textContent!.match(/[A-Z0-9]+-\d+/)![0])).toEqual(keys);
    // The leg with no work item is text, not a button.
    expect(rows[rows.length - 1]!.tagName).toBe('DIV');

    // The canvas, read off its OWN rendered nodes — not off the helper's source.
    const level = await captured!.loadLevel(null);
    const members = rows.slice(0, DISPOSITIONS.length);
    expect(level.nodes).toHaveLength(DISPOSITIONS.length);
    for (const [i, row] of members.entries()) {
      const word = row.lastElementChild!.textContent!.trim();
      expect(word.length, `row ${i} (${DISPOSITIONS[i]}) has a word`).toBeGreaterThan(0);
      const node = level.nodes.find((n) => n.searchText?.includes(keys[i]!));
      expect(node, `a canvas node for ${keys[i]}`).toBeTruthy();
      const rendered = render(<>{node!.content}</>);
      expect(rendered.container.textContent, `${DISPOSITIONS[i]} badge`).toContain(word);
      rendered.unmount();
    }
    // A skipped leg shows its REASON, not just "Skipped".
    expect(members[DISPOSITIONS.indexOf('skipped')]!.textContent).not.toMatch(/Skipped$/);
  });

  it('B2 · a row narrows the real console to that card’s own lines, and again restores the run', async () => {
    serveRoadmap();
    const { keys } = await seedStory(2);
    const runId = await open({ keys });
    await dispatchRunService.appendEvents(
      runId,
      [
        { kind: 'log', workItemKey: keys[0]!, data: { workItemKey: keys[0]! }, body: 'line A1' },
        { kind: 'log', workItemKey: keys[1]!, data: { workItemKey: keys[1]! }, body: 'line B1' },
        { kind: 'log', workItemKey: keys[0]!, data: { workItemKey: keys[0]! }, body: 'line A2' },
      ],
      fx.ctx,
    );
    await mountModal(runId);
    await waitFor(() => expect(screen.getAllByTestId('run-log-line-body')).toHaveLength(3));

    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    const rows = await screen.findAllByTestId('run-set-row');
    const target = await adminDb.workItem.findFirstOrThrow({ where: { identifier: keys[0]! } });

    fireEvent.click(rows[0]!);
    expect(screen.getByTestId('run-modal-log-region').getAttribute('data-selected-work-item')).toBe(
      target.id,
    );
    expect(screen.getAllByTestId('run-log-line-body').map((n) => n.textContent)).toEqual([
      'line A1',
      'line A2',
    ]);

    fireEvent.click(screen.getAllByTestId('run-set-row')[0]!);
    expect(screen.getAllByTestId('run-log-line-body')).toHaveLength(3);
  });

  it('B3 · a selection that admits nothing says so, and makes no claim about the run', async () => {
    serveRoadmap();
    const { keys } = await seedStory(2);
    const runId = await open({ keys });
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'log', workItemKey: keys[0]!, data: { workItemKey: keys[0]! }, body: 'only A' }],
      fx.ctx,
    );
    await mountModal(runId);
    await waitFor(() => expect(screen.getAllByTestId('run-log-line-body')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    fireEvent.click((await screen.findAllByTestId('run-set-row'))[1]!);
    const panel = await screen.findByTestId('run-log-silence-filtered');
    expect(panel.textContent).toContain('Nothing logged for this work item');
    expect(screen.queryByTestId('run-log-silence-waiting')).toBeNull();
  });

  // The three run-level silences, from their own fixtures, in this same file.
  it('B3 · a live run with nothing printed is still WAITING with nothing selected', async () => {
    const runId = await open({ keys: [] });
    await mountModal(runId);
    expect(await screen.findByTestId('run-log-silence-waiting')).toBeTruthy();
    expect(screen.queryByTestId('run-log-silence-filtered')).toBeNull();
  });

  it('B3 · a finished run that sent nothing is still NEVER SENT', async () => {
    const runId = await open({ keys: [] });
    await dispatchRunService.close(runId, { stopReason: 'completed' }, fx.ctx);
    await mountModal(runId);
    expect(await screen.findByTestId('run-log-silence-neverSent')).toBeTruthy();
  });

  it('B3 · a run past the retention window is still EXPIRED', async () => {
    const runId = await open({ keys: [] });
    await dispatchRunService.close(runId, { stopReason: 'completed' }, fx.ctx);
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { startedAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    await mountModal(runId);
    expect(await screen.findByTestId('run-log-silence-expired')).toBeTruthy();
  });

  it('B4 · a run that took no work items says so in both bodies, and the switch still renders', async () => {
    serveRoadmap();
    const runId = await open({ keys: [], command: 'auto' });
    await mountModal(runId);

    expect(screen.getByTestId('run-modal-no-members')).toBeTruthy();
    const list = screen.getByRole('button', { name: 'List' });
    expect(list.hasAttribute('disabled')).toBe(false);
    fireEvent.click(list);
    expect(screen.getByTestId('run-modal-no-members')).toBeTruthy();
    expect(screen.queryByTestId('run-set-list')).toBeNull();
  });

  it('B5 · a failed title read still lists every leg by key and word, and never says "took none"', async () => {
    roadmap.read = async () => {
      throw new Error('roadmap unavailable');
    };
    const { keys } = await seedStory(3);
    const runId = await open({ keys });
    await mountModal(runId);

    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    const rows = await screen.findAllByTestId('run-set-row');
    expect(rows).toHaveLength(3);
    for (const [i, row] of rows.entries()) {
      expect(row.textContent).toContain(keys[i]!);
      expect(row.textContent).not.toContain('Card ');
    }
    expect(screen.queryByTestId('run-modal-no-members')).toBeNull();
  });
});

// ═══ C — THE SPLIT AND THE WRAP, ASSEMBLED WITH THE REAL CHILDREN ═══════════

describe('C — the split and the wrap, assembled with the real children', () => {
  async function mountAssembled(events?: { body: string }[]) {
    serveRoadmap();
    const { keys } = await seedStory(1);
    const runId = await open({ keys });
    if (events) {
      await dispatchRunService.appendEvents(
        runId,
        events.map((e) => ({
          kind: 'log' as const,
          workItemKey: keys[0]!,
          data: { workItemKey: keys[0]! },
          body: e.body,
        })),
        fx.ctx,
      );
    }
    await mountModal(runId);
  }

  it('C1 · pane set first, log region second, divider after both — and the keyboard moves the log’s width', async () => {
    await mountAssembled();
    resizeTo(1440);

    const frame = screen.getByTestId('resizable-split');
    const log = screen.getByTestId('run-modal-log-region');
    const divider = screen.getByTestId('split-divider');
    expect(frame.children[0]!.getAttribute('aria-label')).toBe('The set');
    expect(frame.children[1]).toBe(log);
    for (const pane of [frame.children[0]!, log]) {
      expect(pane.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    const railVar = () => frame.style.getPropertyValue('--rail-w');
    const start = Number(divider.getAttribute('aria-valuenow'));
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(start + RAIL_KEYBOARD_STEP_PX);
    fireEvent.keyDown(divider, { key: 'Home' });
    expect(railVar()).toBe(`${railBounds(1440).min}px`);
    fireEvent.keyDown(divider, { key: 'End' });
    expect(railVar()).toBe(`${railBounds(1440).max}px`);
  });

  it('C2 · stacked: no divider renders, and both real panes are still there in order', async () => {
    await mountAssembled();
    resizeTo(SPLIT_MIN_CONTAINER_PX - 1);

    expect(screen.queryByTestId('split-divider')).toBeNull();
    const frame = screen.getByTestId('resizable-split');
    expect(frame.children[0]!.getAttribute('aria-label')).toBe('The set');
    expect(frame.children[1]).toBe(screen.getByTestId('run-modal-log-region'));
  });

  it('C3 · an unbroken 600-character token renders whole, and nothing between cell and region re-clips it', async () => {
    const token = 'x'.repeat(600);
    await mountAssembled([{ body: token }]);

    const cell = await screen.findByTestId('run-log-line-body');
    expect(cell.textContent).toBe(token);

    const region = screen.getByTestId('run-modal-log-region');
    let node: HTMLElement | null = cell;
    while (node && node !== region) {
      const classes = node.className.split(/\s+/);
      expect(classes, `${node.tagName}.${node.className}`).not.toContain('overflow-x-auto');
      expect(classes).not.toContain('overflow-x-scroll');
      expect(classes).not.toContain('overflow-auto');
      expect(classes).not.toContain('whitespace-pre');
      node = node.parentElement;
    }
    expect(node).toBe(region);
    // `within` keeps the helper honest: the cell really is inside the region.
    expect(within(region).getByTestId('run-log-line-body')).toBe(cell);
  });
});
