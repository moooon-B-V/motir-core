import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPlanFrame,
  narrateFrame,
  TOOL_CALL_VALUE_MAX,
  type PlanChangeProgress,
  type PlanFrameState,
} from '@/lib/hooks/usePlanChangeConversation';
import {
  FRAME_DISPOSITIONS,
  TOOL_CALL_FAMILIES,
  TOOL_CALL_OBJECT_KINDS,
  TOOL_CALL_VERBS,
} from '@/lib/planning/planChangeFrames';

// THE PER-CALL FRAME, READ BEFORE ANYTHING EMITS IT (Story MOTIR-7974 · MOTIR-7976).
//
// The motir-ai emitters (MOTIR-7977 · MOTIR-7978) send `tool_call` as a call
// STARTS, `retrieval` (now carrying the same `callId`) after it returns, and
// `tool_call_failed` when a walk write is refused. This file pins the CONSUMER:
// the parse (`narrateFrame`, total over any payload) and the JOIN of a later
// frame to its call (`applyPlanFrame`). The rail's drawing is
// `plan-change-act-rail.test.tsx`; the relay's pass-through is
// `tests/api/plan-job-stream-relay-tool-call.test.ts`.

afterEach(() => {
  vi.restoreAllMocks();
});

const FULL = {
  callId: 'c1',
  tool: 'read_file',
  family: 'code_read',
  verb: 'read',
  object: { kind: 'path', value: 'lib/auth/session.ts' },
  itemRef: 'MOTIR-12',
};

function call(callId: string, extra: Partial<Record<string, unknown>> = {}): unknown {
  return { ...FULL, callId, ...extra };
}

const EMPTY: PlanFrameState = { progress: null, acts: [] };

/** Feed frames through the reducer in order, as `finishPlanRun`'s onFrame does. */
function run(frames: Array<[string, unknown]>, from: PlanFrameState = EMPTY): PlanFrameState {
  return frames.reduce((state, [event, data]) => applyPlanFrame(state, event, data), from);
}

function callAct(state: PlanFrameState, callId: string) {
  return state.acts.find(
    (a): a is Extract<PlanChangeProgress, { kind: 'call' }> =>
      a.kind === 'call' && a.callId === callId,
  );
}

describe('the closed sets are exactly the contract', () => {
  it('eleven families — the six retrieval families (code_read included) and the five walk families', () => {
    expect([...TOOL_CALL_FAMILIES].sort()).toEqual(
      [
        'plan_tree',
        'code_graph',
        'code_health',
        'code_read',
        'web',
        'lessons',
        'lay',
        'author',
        'item',
        'validate',
        'settle',
      ].sort(),
    );
  });

  it('eleven verbs and five object kinds', () => {
    expect([...TOOL_CALL_VERBS].sort()).toEqual(
      [
        'read',
        'search',
        'explore',
        'look_up',
        'lay',
        'write',
        'add',
        'update',
        'remove',
        'validate',
        'settle',
      ].sort(),
    );
    expect([...TOOL_CALL_OBJECT_KINDS].sort()).toEqual(
      ['path', 'query', 'item', 'parent', 'none'].sort(),
    );
  });

  it('tool_call is SHOWN as a call; tool_call_failed is QUIET, with its reason', () => {
    expect(FRAME_DISPOSITIONS.tool_call).toEqual({ show: 'call' });
    const failed = FRAME_DISPOSITIONS.tool_call_failed;
    expect('quiet' in failed && failed.quiet).toMatch(/mark on its tool_call act/);
  });
});

describe('narrateFrame(tool_call) — the parse', () => {
  it('reads the whole frame into a structured call act, running', () => {
    expect(narrateFrame('tool_call', FULL)).toEqual({
      kind: 'call',
      callId: 'c1',
      tool: 'read_file',
      family: 'code_read',
      verb: 'read',
      object: { kind: 'path', value: 'lib/auth/session.ts' },
      itemRef: 'MOTIR-12',
      outcome: 'running',
    });
  });

  it('a bad field is NULL — never a throw, never the text "undefined"', () => {
    const cases: Array<[string, unknown, Partial<Record<string, unknown>>]> = [
      ['unknown verb', { ...FULL, verb: 'ponder' }, { verb: null }],
      ['unknown family', { ...FULL, family: 'astrology' }, { family: null }],
      ['object kind none', { ...FULL, object: { kind: 'none' } }, { object: null }],
      [
        'object kind none with a value',
        { ...FULL, object: { kind: 'none', value: 'x' } },
        { object: null },
      ],
      ['missing object', { ...FULL, object: undefined }, { object: null }],
      ['object not an object', { ...FULL, object: 'lib/a.ts' }, { object: null }],
      ['unknown object kind', { ...FULL, object: { kind: 'file', value: 'a' } }, { object: null }],
      ['non-string value', { ...FULL, object: { kind: 'path', value: 7 } }, { object: null }],
      ['blank value', { ...FULL, object: { kind: 'query', value: '   ' } }, { object: null }],
      ['missing callId', { ...FULL, callId: undefined }, { callId: null }],
      ['numeric callId', { ...FULL, callId: 3 }, { callId: null }],
      ['missing tool', { ...FULL, tool: undefined }, { tool: null }],
      ['null itemRef', { ...FULL, itemRef: null }, { itemRef: null }],
    ];
    for (const [name, data, expected] of cases) {
      const act = narrateFrame('tool_call', data);
      expect(act, name).not.toBeNull();
      expect(act, name).toMatchObject({ kind: 'call', outcome: 'running', ...expected });
      expect(JSON.stringify(act), name).not.toContain('undefined');
    }
  });

  it('undefined and null data each give a generic call act, every field null', () => {
    const generic = {
      kind: 'call',
      callId: null,
      tool: null,
      family: null,
      verb: null,
      object: null,
      itemRef: null,
      outcome: 'running',
    };
    expect(narrateFrame('tool_call', undefined)).toEqual(generic);
    expect(narrateFrame('tool_call', null)).toEqual(generic);
    expect(JSON.stringify(narrateFrame('tool_call', undefined))).not.toContain('undefined');
  });

  it('trims the value and caps it as a memory guard', () => {
    const long = 'a/'.repeat(TOOL_CALL_VALUE_MAX);
    const act = narrateFrame('tool_call', {
      ...FULL,
      object: { kind: 'path', value: `  ${long}` },
    });
    expect(act).toMatchObject({ object: { kind: 'path' } });
    const value = (act as Extract<PlanChangeProgress, { kind: 'call' }>).object!.value;
    expect(value).toHaveLength(TOOL_CALL_VALUE_MAX);
    expect(value.startsWith('a/')).toBe(true);
  });

  it('tool_call_failed narrates NOTHING on its own — it is only a mark', () => {
    expect(narrateFrame('tool_call_failed', { callId: 'c1', reason: 'refused' })).toBeNull();
  });

  it('an unknown frame kind still hits the LOUD default, unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(narrateFrame('tool_call_v2', FULL)).toEqual({ kind: 'unknown', frame: 'tool_call_v2' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('applyPlanFrame — a later frame MARKS its call', () => {
  it('a blocked retrieval with the matching callId marks the call SKIPPED and appends nothing', () => {
    const s = run([
      ['tool_call', call('c1')],
      ['retrieval', { tool: 'read_file', family: 'code_read', blocked: true, callId: 'c1' }],
    ]);
    expect(s.acts).toHaveLength(1);
    expect(callAct(s, 'c1')?.outcome).toBe('skipped');
  });

  it('a failed retrieval marks it FAILED; a successful one changes nothing and appends nothing', () => {
    const started = run([['tool_call', call('c1')]]);
    const ok = applyPlanFrame(started, 'retrieval', {
      tool: 'read_file',
      family: 'code_read',
      ok: true,
      args: {},
      callId: 'c1',
    });
    expect(ok).toBe(started);

    const failed = applyPlanFrame(started, 'retrieval', {
      tool: 'read_file',
      family: 'code_read',
      ok: false,
      args: {},
      callId: 'c1',
    });
    expect(failed.acts).toHaveLength(1);
    expect(callAct(failed, 'c1')?.outcome).toBe('failed');
  });

  it('tool_call_failed marks its call FAILED; with no matching call it changes nothing', () => {
    const started = run([
      ['tool_call', call('w1', { family: 'item', verb: 'add', tool: 'add_item' })],
    ]);
    const marked = applyPlanFrame(started, 'tool_call_failed', { callId: 'w1', reason: 'refused' });
    expect(marked.acts).toHaveLength(1);
    expect(callAct(marked, 'w1')?.outcome).toBe('failed');

    expect(applyPlanFrame(started, 'tool_call_failed', { callId: 'nope', reason: 'error' })).toBe(
      started,
    );
    expect(applyPlanFrame(started, 'tool_call_failed', {})).toBe(started);
    expect(applyPlanFrame(started, 'tool_call_failed', undefined)).toBe(started);
  });

  it('a retrieval with NO callId, or one matching nothing, appends the shipped act byte-identically', () => {
    const started = run([['tool_call', call('c1')]]);
    const shipped = { kind: 'retrieval', family: 'code_graph', blocked: false };

    const bare = applyPlanFrame(started, 'retrieval', {
      tool: 'find_symbol',
      family: 'code_graph',
      ok: true,
    });
    expect(bare.acts).toHaveLength(2);
    expect(bare.acts[1]).toEqual(shipped);
    expect(bare.progress).toEqual(shipped);

    const stray = applyPlanFrame(started, 'retrieval', {
      tool: 'find_symbol',
      family: 'code_graph',
      ok: false,
      callId: 'other',
    });
    expect(stray.acts[1]).toEqual(shipped);
    // …and the unmatched failure does not leak onto a different call.
    expect(callAct(stray, 'c1')?.outcome).toBe('running');

    // An older producer's budget row is still the shipped one.
    const blocked = applyPlanFrame(EMPTY, 'retrieval', {
      tool: 't',
      family: 'plan_tree',
      blocked: true,
    });
    expect(blocked.acts).toEqual([{ kind: 'retrieval', family: 'plan_tree', blocked: true }]);
  });

  it('interleaved calls: a mark for c1 changes only c1', () => {
    const s = run([
      ['tool_call', call('c1', { itemRef: 'MOTIR-1' })],
      ['tool_call', call('c2', { itemRef: 'MOTIR-2' })],
      ['retrieval', { tool: 'read_file', family: 'code_read', ok: false, callId: 'c1' }],
    ]);
    expect(s.acts.map((a) => (a.kind === 'call' ? [a.callId, a.outcome] : a.kind))).toEqual([
      ['c1', 'failed'],
      ['c2', 'running'],
    ]);
    // The live line is c2, untouched by c1's mark.
    expect(s.progress).toMatchObject({ kind: 'call', callId: 'c2', outcome: 'running' });
  });

  it('a mark on the act the LIVE line holds updates the live line too', () => {
    const s = run([
      ['tool_call', call('c1')],
      ['tool_call_failed', { callId: 'c1', reason: 'error' }],
    ]);
    expect(s.progress).toMatchObject({ kind: 'call', callId: 'c1', outcome: 'failed' });
    expect(s.progress).toBe(s.acts[0]);
  });

  it('every other frame narrates and appends exactly as before; a quiet one changes nothing', () => {
    const s = run([
      ['lay', { target: 'MOTIR-42' }],
      ['tool_call', call('c1')],
      ['author', { title: 'The stop' }],
    ]);
    expect(s.acts.map((a) => a.kind)).toEqual(['laying', 'call', 'authoring']);
    expect(s.progress).toEqual({ kind: 'authoring', title: 'The stop' });
    expect(applyPlanFrame(s, 'token', { n: 1 })).toBe(s);
  });
});
