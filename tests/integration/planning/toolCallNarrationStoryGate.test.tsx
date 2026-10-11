// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
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
//      end — since MOTIR-8064, with NO call line drawn (see sections 3 and 4).
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

describe('2 · the fold — no lookup, no tool call and no unlisted frame becomes an act', () => {
  it('the recording folds to the run rows alone, and nothing logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { acts } = fold(await readStream()).at(-1)!;
    // MOTIR-8158: a tool call and a lookup are quiet frames, so the record holds
    // neither — live, it holds what a reopened rail draws.
    const kinds = new Set<string>(acts.map((a) => a.kind));
    for (const gone of ['call', 'retrieval', 'searching', 'drilling', 'unknown']) {
      expect(kinds.has(gone), gone).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

// ⚠️ AMENDED BY STORY MOTIR-8060 · MOTIR-8064. The per-call lines this gate drew
// were retired for both planners (`design/ai-chat/design-notes.md` § "⭐ Planner
// narration in the chat panel"): the wire and the fold above are unchanged —
// motir-ai still emits the frames and the hook still records them — but the
// screen now draws NONE of them. These two sections pin that absence against the
// same recording, mid-run and at the end, in en and zh.

const CALL_CHROME = [
  'plan-change-call',
  'plan-change-calls',
  'plan-change-calls-toggle',
  'plan-change-calls-earlier',
  'plan-change-call-mark',
  'plan-change-call-object',
];

function expectNoCallChrome() {
  for (const id of CALL_CHROME) expect(screen.queryAllByTestId(id), id).toHaveLength(0);
}

describe('3 · the screen, mid-run — three author sessions open at once, no call lines', () => {
  // The state right after the three interleaved reads' audits arrive: every
  // author session has started one call, and none has written yet.
  const MID = frameIndexOf('update_item', 1) - 1;

  for (const locale of LOCALES) {
    it(`${locale}: each author step renders and none of its calls does; the bar repeats a step`, async () => {
      const t = TR[locale];
      const mid = fold(await readStream())[MID]!;
      renderRail(mid, locale);

      const steps = screen.getAllByTestId('plan-change-act-authoring');
      expect(steps).toHaveLength(3);
      const titles = ['First leaf', 'Second leaf', 'Third leaf'];
      steps.forEach((step, i) => {
        expect(step.textContent).toContain(t('act.authoringLine', { title: titles[i]! }));
      });
      expect(screen.getByTestId('plan-change-act-laying')).toBeTruthy();
      expectNoCallChrome();

      // The bar repeats the newest step row, never a call's object.
      const bar = screen.getByTestId('plan-change-running-bar').textContent ?? '';
      expect(bar).toContain(t('act.authoringLine', { title: 'Third leaf' }));
      expect(bar).not.toContain('MOTIR-42');
    });
  }
});

describe('4 · the screen, at the end — the steps stand, the calls are not drawn', () => {
  for (const locale of LOCALES) {
    it(`${locale}: no call line, count or mark for any of the recording's calls`, async () => {
      const { acts } = fold(await readStream()).at(-1)!;
      renderRail({ acts, progress: acts.at(-1)! }, locale);

      expectNoCallChrome();
      expect(screen.getAllByTestId('plan-change-act-laying')).toHaveLength(1);
      expect(screen.getAllByTestId('plan-change-act-authoring')).toHaveLength(3);
      const record = screen.getByTestId('plan-change-acts');
      expect(record.textContent).not.toContain('lib/auth/session.ts');
      expect(record.textContent).not.toContain('MOTIR-999');

      // One live region, holding only the announcer — never a call.
      const regions = document.querySelectorAll('[aria-live]');
      expect(regions).toHaveLength(1);
      expect(within(regions[0] as HTMLElement).getByTestId('plan-change-announcer')).toBeTruthy();
    });
  }
});
