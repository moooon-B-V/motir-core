// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — one line per tool call on the planning rail, from the wire to
// the screen (Story MOTIR-7974 · MOTIR-7981).
// ═══════════════════════════════════════════════════════════════════════════
//
// Each card proved its own side against input it built itself: the frame map and
// the fold (MOTIR-7976) take hand-written frames, the rail (MOTIR-7979) renders a
// hand-built act record. This file stands at the JOIN, with a RECORDED stream —
// `tests/fixtures/plan-change/tool-call-stream.ts`, captured from motir-ai's own
// story gate driving a real `plan` job — and nothing hand-built between it and
// the screen:
//
//   1. THE WIRE. The anchored relay `GET /api/work-items/[id]/ai/plan/[jobId]/stream`
//      (permission gate against a REAL Postgres) writes the stream, and the
//      shipped client reader `consumeStream` reads it back frame for frame.
//   2. THE FOLD. Every frame goes through `applyPlanFrame`, the hook's own fold:
//      one row per call, each mark on its own call by `callId`, no lookup row
//      for a matched read, and no frame the map does not know.
//   3. THE SCREEN. The folded record renders in the shipped `PlanChangeRail`, in
//      en and in zh, mid-run (three parallel author sessions open) and at the
//      end (every finished step folded behind its count).
//
// The en/zh catalogue parity this card also asks for is
// `tests/components/plan-change-catalogue-parity.test.ts` (MOTIR-7979), which
// runs in this story's coverage lane beside this file.
//
// Stubbed, per the motir-core convention: the session and active-project
// resolvers the test env cannot supply, and the motir-ai boundary client — it
// replays the recording. `fetch` is pointed at the route handler in-process.

const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const streamJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ai/motirAiClient')>();
  return { ...real, streamJob: (...args: unknown[]) => streamJobMock(...(args as [])) };
});

import { db } from '@/lib/db';
import { GET as anchoredStream } from '@/app/api/work-items/[id]/ai/plan/[jobId]/stream/route';
import { consumeStream } from '@/lib/planning/planEditsClient';
import {
  applyPlanFrame,
  type PlanChangeConversationState,
  type PlanChangeProgress,
  type PlanFrameState,
} from '@/lib/hooks/usePlanChangeConversation';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { TOOL_CALL_STREAM, type RecordedFrame } from '../../fixtures/plan-change/tool-call-stream';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { renderWithIntl } from '../../helpers/renderWithIntl';

const BASE = 'http://localhost:3000';
const NS = 'planningWorkspace.conversation';
type Tr = (key: string, values?: Record<string, string | number>) => string;
const TR: Record<'en' | 'zh', Tr> = {
  en: createTranslator({ locale: 'en', messages: en, namespace: NS }) as unknown as Tr,
  zh: createTranslator({ locale: 'zh', messages: zh, namespace: NS }) as unknown as Tr,
};
const LOCALES = ['en', 'zh'] as const;

type CallAct = Extract<PlanChangeProgress, { kind: 'call' }>;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  streamJobMock.mockReset();
  streamJobMock.mockImplementation(() =>
    (async function* () {
      for (const frame of TOOL_CALL_STREAM) yield frame;
    })(),
  );
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The wire: relay → client reader ─────────────────────────────────────────

/** Read the recording through the real relay and the real client reader. */
async function readStream(): Promise<RecordedFrame[]> {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Sign-in story' });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const match = /\/api\/work-items\/([^/]+)\/ai\/plan\/([^/]+)\/stream$/.exec(url);
    if (!match) throw new Error(`unexpected fetch ${url}`);
    return anchoredStream(new Request(BASE + url, init), {
      params: Promise.resolve({ id: match[1]!, jobId: match[2]! }),
    });
  });
  const frames: RecordedFrame[] = [];
  const errors: (string | null)[] = [];
  let done = false;
  await consumeStream(
    `/api/work-items/${story.id}/ai/plan/job-1/stream`,
    new AbortController().signal,
    (code) => errors.push(code),
    () => {
      done = true;
    },
    (event, data) => frames.push({ event, data }),
  );
  expect(errors).toEqual([]);
  expect(done).toBe(true);
  return frames;
}

/** Fold frames with the hook's own fold; one state per frame. */
function fold(frames: readonly RecordedFrame[]): PlanFrameState[] {
  const states: PlanFrameState[] = [];
  let state: PlanFrameState = { progress: null, acts: [] };
  for (const { event, data } of frames) {
    state = applyPlanFrame(state, event, data);
    states.push(state);
  }
  return states;
}

/** The index in the recording of the Nth `tool_call` naming `tool`. */
function frameIndexOf(tool: string, nth = 0): number {
  let seen = 0;
  for (let i = 0; i < TOOL_CALL_STREAM.length; i += 1) {
    const f = TOOL_CALL_STREAM[i]!;
    if (f.event === 'tool_call' && (f.data as { tool: string }).tool === tool) {
      if (seen === nth) return i;
      seen += 1;
    }
  }
  throw new Error(`no ${tool} #${nth} in the recording`);
}

// ── The screen ──────────────────────────────────────────────────────────────

const SESSION: PlanChangeSessionDto = {
  id: 's1',
  projectId: 'p1',
  targetKeys: [],
  turnCount: 0,
  lastJobId: null,
  lastSubmittedAt: null,
  lastActivityAt: '2026-10-09T00:00:00.000Z',
  origin: 'conversation',
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  turns: [],
  workItemRefs: {},
};

function railState(folded: PlanFrameState): PlanChangeConversationState {
  return {
    phase: 'streaming',
    session: SESSION,
    progress: folded.progress,
    review: null,
    liveReview: null,
    liveVersion: 0,
    liveFailing: false,
    discardedReview: null,
    decided: null,
    jobId: 'job-1',
    planId: null,
    approved: null,
    errorCode: null,
    outOfCredits: false,
    stopping: false,
    stopped: false,
    queued: [],
    earlier: null,
    reopened: null,
    readOnly: false,
    acts: folded.acts,
  };
}

function renderRail(folded: PlanFrameState, locale: 'en' | 'zh') {
  const state = railState(folded);
  return renderWithIntl(
    <PlanChangeRail
      launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
      projectName="PayFlow"
      state={state}
      index={indexPlanReview(null)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onStop={vi.fn()}
    />,
    { locale, messages: locale === 'zh' ? zh : en },
  );
}

// ═══════════════════════════════════════════════════════════════════════════

describe('1 · the wire — the relay and the client reader lose nothing', () => {
  it('every recorded frame arrives, in order, with the same data', async () => {
    const frames = await readStream();
    expect(frames).toEqual(TOOL_CALL_STREAM.map(({ event, data }) => ({ event, data })));
  });
});

describe('2 · the fold — one row per call, each mark on its own call', () => {
  it('every start is one call row; no matched lookup draws a row; no frame is unknown', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { acts } = fold(await readStream()).at(-1)!;
    const starts = TOOL_CALL_STREAM.filter((f) => f.event === 'tool_call');
    const calls = acts.filter((a): a is CallAct => a.kind === 'call');
    expect(calls.map((c) => c.callId)).toEqual(
      starts.map((f) => (f.data as { callId: string }).callId),
    );
    // Every `retrieval` in the recording carries the callId of a call it saw.
    expect(acts.some((a) => a.kind === 'retrieval')).toBe(false);
    expect(acts.some((a) => a.kind === 'unknown')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failed read is failed, a refusal is refused, the rest stay as they ran', async () => {
    const { acts } = fold(await readStream()).at(-1)!;
    const calls = acts.filter((a): a is CallAct => a.kind === 'call');
    const failedReads = TOOL_CALL_STREAM.filter(
      (f) => f.event === 'retrieval' && (f.data as { ok: boolean }).ok === false,
    ).map((f) => (f.data as { callId: string }).callId);
    const refusals = TOOL_CALL_STREAM.filter(
      (f) => f.event === 'tool_call_failed' && (f.data as { reason: string }).reason === 'refused',
    ).map((f) => (f.data as { callId: string }).callId);
    expect(failedReads).toHaveLength(1);
    expect(refusals).toHaveLength(6);
    for (const c of calls) {
      const expected = failedReads.includes(c.callId ?? '')
        ? 'failed'
        : refusals.includes(c.callId ?? '')
          ? 'refused'
          : 'running';
      expect(c.outcome, `${c.tool} ${c.callId}`).toBe(expected);
    }
  });
});

describe('3 · the screen, mid-run — three author sessions open at once', () => {
  // The state right after the three interleaved reads' audits arrive: every
  // author session has started one call, and none has written yet.
  const MID = frameIndexOf('update_item', 1) - 1;

  for (const locale of LOCALES) {
    it(`${locale}: each author step holds its own call, and the bar names the newest one’s card`, async () => {
      const t = TR[locale];
      const mid = fold(await readStream())[MID]!;
      renderRail(mid, locale);

      const steps = screen.getAllByTestId('plan-change-act-authoring');
      expect(steps).toHaveLength(3);
      const titles = ['First leaf', 'Second leaf', 'Third leaf'];
      steps.forEach((step, i) => {
        expect(step.getAttribute('data-step')).toBe('open');
        expect(step.textContent).toContain(t('act.authoringLine', { title: titles[i]! }));
        const calls = within(step).getAllByTestId('plan-change-call');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.textContent).toContain(t('act.call.tool.get_item', { item: 'MOTIR-42' }));
      });

      // The lay step finished: folded behind its count, which names its failures.
      const lay = screen.getByTestId('plan-change-act-laying');
      expect(lay.getAttribute('data-step')).toBe('folded');

      // The newest STARTED call belongs to the third session.
      expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
        t('act.call.barParallel', {
          line: t('act.call.tool.get_item', { item: 'MOTIR-42' }),
          title: 'Third leaf',
        }),
      );
    });
  }
});

describe('4 · the screen, at the end — every finished step folds behind its count', () => {
  for (const locale of LOCALES) {
    it(`${locale}: PART 1’s calls stand alone; the lay folds to 17 calls · 6 failed and opens to every line`, async () => {
      const t = TR[locale];
      const { acts } = fold(await readStream()).at(-1)!;
      renderRail({ acts, progress: acts.at(-1)! }, locale);

      // PART 1's four calls came before any step: rows of their own.
      const record = screen.getByTestId('plan-change-acts');
      const topLevel = [...record.children].filter(
        (li) => li.getAttribute('data-testid') === 'plan-change-call',
      );
      expect(topLevel).toHaveLength(4);
      expect(topLevel[1]!.textContent).toContain(t('act.call.tool.get_item', { item: 'MOTIR-42' }));
      expect(topLevel[2]!.textContent).toContain(
        t('act.call.tool.search_work_items_semantic', { query: 'sign in' }),
      );

      // The lay: 17 calls, 1 failed read + 5 refusals.
      const lay = screen.getByTestId('plan-change-act-laying');
      expect(lay.getAttribute('data-step')).toBe('folded');
      const toggle = within(lay).getByTestId('plan-change-calls-toggle');
      expect(toggle.textContent).toBe(t('act.call.countFailed', { count: 17, failed: 6 }));
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(within(lay).getByTestId('plan-change-calls').hidden).toBe(true);

      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const list = within(lay).getByTestId('plan-change-calls');
      expect(list.hidden).toBe(false);
      const lines = within(list).getAllByTestId('plan-change-call');
      expect(lines).toHaveLength(17);

      const read = lines.find((li) =>
        li.textContent?.includes(t('act.call.tool.read_file', { path: 'lib/auth/session.ts' })),
      );
      expect(read?.getAttribute('data-outcome')).toBe('running');
      const missing = lines.find((li) =>
        li.textContent?.includes(t('act.call.tool.get_item', { item: 'MOTIR-999' })),
      )!;
      expect(missing.getAttribute('data-outcome')).toBe('failed');
      expect(within(missing).getByTestId('plan-change-call-mark').textContent).toContain(
        t('act.call.mark.failed'),
      );
      const refused = lines.filter((li) => li.getAttribute('data-outcome') === 'refused');
      expect(refused).toHaveLength(5);
      for (const li of refused) {
        expect(within(li).getByTestId('plan-change-call-mark').textContent).toContain(
          t('act.call.mark.refused'),
        );
      }
      // A refused write still reads as its own line.
      expect(
        refused.some((li) =>
          li.textContent?.includes(
            t('act.call.tool.add_item', { title: 'Session cookie not cleared' }),
          ),
        ),
      ).toBe(true);

      // Each author step kept its own calls through the interleaving.
      const authors = screen.getAllByTestId('plan-change-act-authoring');
      const counts = authors.map(
        (step) => within(step).getByTestId('plan-change-calls-toggle').textContent,
      );
      expect(counts).toEqual([
        t('act.call.countFailed', { count: 3, failed: 1 }),
        t('act.call.count', { count: 2 }),
        t('act.call.count', { count: 2 }),
      ]);

      // One live region, holding only the announcer — never a call.
      const regions = document.querySelectorAll('[aria-live]');
      expect(regions).toHaveLength(1);
      expect(regions[0]!.querySelectorAll('[data-testid="plan-change-call"]')).toHaveLength(0);
      expect(within(regions[0] as HTMLElement).getByTestId('plan-change-announcer')).toBeTruthy();
    });
  }
});
