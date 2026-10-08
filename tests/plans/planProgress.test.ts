import { describe, expect, it } from 'vitest';
import {
  PLAN_STALLED_AFTER_MS,
  PLAN_STEP_PHRASE_MESSAGE_KEY,
  buildPlanProgressSnapshot,
  countAuthored,
  progressRowOfAdd,
  readPlanProgress,
  requireExplanationFor,
  serverNow,
  type PlanProgressAddRow,
  type PlanProgressSnapshot,
} from '@/lib/plans/planProgress';
import type { PlanStepDto } from '@/lib/dto/plans';

// Story MOTIR-7820 · Subtask MOTIR-7825 — the ONE progress derivation, pure.
// Every number and phrase key here is the design's (Part XXV §25.9, §25.13).

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function row(over: Partial<PlanProgressAddRow> & { id: string }): PlanProgressAddRow {
  return {
    workItemId: null,
    parentRef: null,
    kind: 'task',
    title: `Title ${over.id}`,
    hasDescription: true,
    hasExplanation: true,
    hasType: true,
    hasExecutor: true,
    hasStoryPoints: true,
    hasEstimate: true,
    hasDifficulty: true,
    ...over,
  };
}

function step(over: Partial<PlanStepDto> & { sessionKey: string }): PlanStepDto {
  return { kind: 'author', targetRef: null, startedAt: at(0), ...over };
}

function snap(over: Partial<PlanProgressSnapshot> = {}): PlanProgressSnapshot {
  return {
    startedAt: at(0),
    lastActivityAt: at(0),
    observedAt: at(0),
    authored: 0,
    proposed: 0,
    steps: [],
    ...over,
  };
}

function build(args: {
  steps: PlanStepDto[];
  addRows?: PlanProgressAddRow[];
  committedTitles?: Map<string, string>;
}) {
  return buildPlanProgressSnapshot({
    plan: { createdAt: at(0), lastActivityAt: at(0) },
    steps: args.steps,
    addRows: args.addRows ?? [],
    committedTitles: args.committedTitles ?? new Map(),
    requireExplanation: true,
    observedAt: at(0),
  });
}

describe('the threshold and the copy keys are the design’s', () => {
  it('PLAN_STALLED_AFTER_MS is 15 minutes (§25.9)', () => {
    expect(PLAN_STALLED_AFTER_MS).toBe(900_000);
  });

  it('maps every phrase to its §25.13 copy key', () => {
    expect(PLAN_STEP_PHRASE_MESSAGE_KEY).toEqual({
      settling: 'planReview.progress.settling',
      layingTopLevel: 'planReview.progress.layingTopLevel',
      layingChildrenOf: 'planReview.progress.layingChildrenOf',
      authoring: 'planReview.progress.authoring',
      draftingNew: 'planReview.progress.draftingNew',
    });
  });
});

describe('readPlanProgress — states and their precedence', () => {
  const live = build({ steps: [step({ sessionKey: 'a', kind: 'settle' })] }).steps;

  it('stalled exactly past the threshold — `=` is not, `+1 ms` is', () => {
    const s = snap({ steps: live, proposed: 2 });
    expect(readPlanProgress(s, T0 + PLAN_STALLED_AFTER_MS).state).toBe('working');
    const past = readPlanProgress(s, T0 + PLAN_STALLED_AFTER_MS + 1);
    expect(past.state).toBe('stalled');
    expect(past.liveSteps).toEqual([]);
  });

  it('stalled wins over a live step (a step younger than the silence)', () => {
    const young = build({
      steps: [step({ sessionKey: 'a', kind: 'settle', startedAt: at(10 * 60_000) })],
    }).steps;
    const s = snap({ steps: young, lastActivityAt: at(0) });
    const r = readPlanProgress(s, T0 + PLAN_STALLED_AFTER_MS + 1);
    expect(r.state).toBe('stalled');
    expect(r.liveSteps).toEqual([]);
  });

  it('working with a live step, starting with none and nothing proposed, writing otherwise', () => {
    expect(readPlanProgress(snap({ steps: live }), T0).state).toBe('working');
    expect(readPlanProgress(snap({ proposed: 0 }), T0).state).toBe('starting');
    expect(readPlanProgress(snap({ proposed: 3, authored: 1 }), T0).state).toBe('writing');
  });

  it('drops a QUIET step while a younger sibling stays live (untargeted included)', () => {
    const steps = build({
      steps: [
        step({ sessionKey: 'old', kind: 'lay', targetRef: null, startedAt: at(0) }),
        step({ sessionKey: 'new', kind: 'author', targetRef: null, startedAt: at(10 * 60_000) }),
      ],
    }).steps;
    const now = T0 + PLAN_STALLED_AFTER_MS + 1;
    const s = snap({ steps, lastActivityAt: at(14 * 60_000), proposed: 1 });
    const r = readPlanProgress(s, now);
    expect(r.state).toBe('working');
    expect(r.liveSteps.map((x) => x.sessionKey)).toEqual(['new']);
  });

  it('a plan whose every step aged out reads writing, not working', () => {
    const steps = build({ steps: [step({ sessionKey: 'a', kind: 'settle' })] }).steps;
    const r = readPlanProgress(
      snap({ steps, lastActivityAt: at(14 * 60_000), proposed: 1 }),
      T0 + PLAN_STALLED_AFTER_MS + 1,
    );
    expect(r.state).toBe('writing');
    expect(r.liveSteps).toEqual([]);
  });

  it('elapsed and since-activity, with negative durations clamped to 0', () => {
    const s = snap({ startedAt: at(0), lastActivityAt: at(60_000) });
    const r = readPlanProgress(s, T0 + 120_000);
    expect(r.elapsedMs).toBe(120_000);
    expect(r.sinceActivityMs).toBe(60_000);
    const early = readPlanProgress(s, T0 - 5_000);
    expect(early.elapsedMs).toBe(0);
    expect(early.sinceActivityMs).toBe(0);
  });
});

describe('buildPlanProgressSnapshot — the phrase table', () => {
  const adds = [
    row({ id: 'add1', title: 'Proposed story' }),
    row({ id: 'mat', workItemId: 'wi9', title: 'Materialized' }),
  ];
  const committedTitles = new Map([['wi1', 'Committed parent']]);

  it('yields all five phrases; the untargeted ones are KEPT with null title and node', () => {
    const s = build({
      addRows: adds,
      committedTitles,
      steps: [
        step({ sessionKey: '1', kind: 'settle', startedAt: at(1) }),
        step({ sessionKey: '2', kind: 'lay', targetRef: null, startedAt: at(2) }),
        step({ sessionKey: '3', kind: 'lay', targetRef: 'wi1', startedAt: at(3) }),
        step({ sessionKey: '4', kind: 'author', targetRef: null, startedAt: at(4) }),
        step({ sessionKey: '5', kind: 'author', targetRef: 'planItem:add1', startedAt: at(5) }),
      ],
    });
    expect(s.steps.map((x) => [x.phrase, x.targetTitle, x.targetNodeId])).toEqual([
      ['settling', null, null],
      ['layingTopLevel', null, null],
      ['layingChildrenOf', 'Committed parent', 'wi1'],
      ['draftingNew', null, null],
      ['authoring', 'Proposed story', 'add1'],
    ]);
  });

  it('a materialized add’s node id is its work item (PlanReviewItemDto.nodeId’s rule)', () => {
    const s = build({
      addRows: adds,
      steps: [step({ sessionKey: 'm', kind: 'author', targetRef: 'planItem:mat' })],
    });
    expect(s.steps[0]).toMatchObject({ targetNodeId: 'wi9', targetTitle: 'Materialized' });
  });

  it('drops a withdrawn planItem target and a committed id with no title', () => {
    const s = build({
      addRows: adds,
      committedTitles,
      steps: [
        step({ sessionKey: 'gone', kind: 'author', targetRef: 'planItem:withdrawn' }),
        step({ sessionKey: 'nope', kind: 'lay', targetRef: 'wi-unknown' }),
        step({ sessionKey: 'ok', kind: 'lay', targetRef: 'wi1' }),
      ],
    });
    expect(s.steps.map((x) => x.sessionKey)).toEqual(['ok']);
  });

  it('orders by startedAt, ties by sessionKey', () => {
    const s = build({
      steps: [
        step({ sessionKey: 'b', kind: 'settle', startedAt: at(5) }),
        step({ sessionKey: 'z', kind: 'settle', startedAt: at(1) }),
        step({ sessionKey: 'a', kind: 'settle', startedAt: at(5) }),
      ],
    });
    expect(s.steps.map((x) => x.sessionKey)).toEqual(['z', 'a', 'b']);
  });

  it('carries the plan’s times and the counts', () => {
    const s = buildPlanProgressSnapshot({
      plan: { createdAt: new Date(T0), lastActivityAt: at(30_000) },
      steps: [],
      addRows: [row({ id: 'x' }), row({ id: 'y', hasDescription: false })],
      committedTitles: new Map(),
      requireExplanation: false,
      observedAt: new Date(T0 + 45_000),
    });
    expect(s).toMatchObject({
      startedAt: at(0),
      lastActivityAt: at(30_000),
      observedAt: at(45_000),
      authored: 1,
      proposed: 2,
    });
  });
});

describe('countAuthored — the mirrored walk-completeness authored test', () => {
  it('a childless task with both bodies and all five sizing fields counts', () => {
    expect(countAuthored([row({ id: 't' })], true)).toEqual({ authored: 1, proposed: 1 });
  });

  it('the same task with one sizing field missing does not', () => {
    for (const k of [
      'hasType',
      'hasExecutor',
      'hasStoryPoints',
      'hasEstimate',
      'hasDifficulty',
    ] as const) {
      expect(countAuthored([row({ id: 't', [k]: false })], true).authored, k).toBe(0);
    }
  });

  it('a container (story / epic) with both bodies and no sizing counts — never leaf-sized', () => {
    const bare = {
      hasType: false,
      hasExecutor: false,
      hasStoryPoints: false,
      hasEstimate: false,
      hasDifficulty: false,
    };
    expect(
      countAuthored(
        [row({ id: 's', kind: 'story', ...bare }), row({ id: 'e', kind: 'epic', ...bare })],
        true,
      ),
    ).toEqual({ authored: 2, proposed: 2 });
  });

  it('a task with a proposed child counts without sizing; its childless subtask owes sizing', () => {
    const rows = [
      row({ id: 'parent', kind: 'task', hasStoryPoints: false, hasDifficulty: false }),
      row({ id: 'child', kind: 'subtask', parentRef: 'planItem:parent', hasEstimate: false }),
    ];
    expect(countAuthored(rows, true)).toEqual({ authored: 1, proposed: 2 });
  });

  it('requireExplanation: a row missing only explanationMd counts when false, not when true', () => {
    const r = [row({ id: 'x', hasExplanation: false })];
    expect(countAuthored(r, false).authored).toBe(1);
    expect(countAuthored(r, true).authored).toBe(0);
  });

  it('a modify is in neither number (the caller passes adds only; progressRowOfAdd filters nothing)', () => {
    // M counts what is passed: the service passes ONLY `add` rows (SQL `op = 'add'`,
    // the review path filters `op === 'add'`), so a modify never reaches here.
    expect(countAuthored([], true)).toEqual({ authored: 0, proposed: 0 });
  });

  it('progressRowOfAdd mirrors the SQL flags', () => {
    const r = progressRowOfAdd({
      id: 'p',
      workItemId: null,
      parentRef: null,
      proposedFields: {
        title: 'P',
        kind: 'task',
        descriptionMd: '  \n ',
        explanationMd: 'why',
        type: '',
        executor: 'coding_agent',
        storyPoints: 0,
        estimateMinutes: null,
      },
    });
    expect(r).toMatchObject({
      kind: 'task',
      title: 'P',
      hasDescription: false,
      hasExplanation: true,
      hasType: false,
      hasExecutor: true,
      hasStoryPoints: true,
      hasEstimate: false,
      hasDifficulty: false,
    });
  });
});

describe('requireExplanationFor', () => {
  it('mcp always owes it; native and null follow the project setting', () => {
    for (const setting of [true, false]) {
      expect(
        requireExplanationFor({ authorSource: 'mcp', projectAiGenerateExplanations: setting }),
      ).toBe(true);
      expect(
        requireExplanationFor({ authorSource: 'native', projectAiGenerateExplanations: setting }),
      ).toBe(setting);
      expect(
        requireExplanationFor({ authorSource: null, projectAiGenerateExplanations: setting }),
      ).toBe(setting);
    }
  });
});

describe('serverNow — the client ticks in server time', () => {
  // The server built the snapshot at T0 + 4 min; activity was at T0. The client
  // received it at ITS OWN clock reading, 5 minutes off either way, and reads
  // again 30 s later. Read in raw client time, the fast clock would be 9.5 min
  // past activity and the slow one would be negative; in server time both are 4.5.
  const s = snap({ lastActivityAt: at(0), observedAt: at(4 * 60_000), proposed: 1 });
  for (const [label, skew] of [
    ['5 minutes fast', 5 * 60_000],
    ['5 minutes slow', -5 * 60_000],
  ] as const) {
    it(`holds to server time with a client clock ${label}`, () => {
      const receivedAt = T0 + 4 * 60_000 + skew;
      const now = serverNow(s.observedAt, receivedAt, receivedAt + 30_000);
      expect(now).toBe(T0 + 4 * 60_000 + 30_000);
      const r = readPlanProgress(s, now);
      expect(r.state).not.toBe('stalled');
      expect(r.sinceActivityMs).toBe(4 * 60_000 + 30_000);
    });
  }

  it('never runs backwards when the client clock steps back after receipt', () => {
    expect(serverNow(at(0), T0 + 10_000, T0 + 5_000)).toBe(T0);
  });
});
