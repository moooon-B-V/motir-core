import { describe, expect, it } from 'vitest';
import {
  CALL_OBJECT_CAP,
  barTarget,
  callLineSpec,
  columns,
  failedCount,
  groupActs,
  isMonoObject,
  latestRowAnnouncement,
  nextAnnouncement,
  openSteps,
  shortenCallObject,
  type CallAct,
} from '@/components/planning/planCallLines';
import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';

// THE PER-CALL LINE AS DATA (Story MOTIR-7974 · MOTIR-7979) — the pure rules
// `PlanActRecord` renders from, each one MOTIR-7975's design
// (`design/ai-chat/design-notes.md` § "⭐ The per-call line on the planning rail").

function call(extra: Partial<CallAct> = {}): CallAct {
  return {
    kind: 'call',
    callId: 'c1',
    tool: 'read_file',
    family: 'code_read',
    verb: 'read',
    object: { kind: 'path', value: 'lib/auth/passwords.ts' },
    itemRef: null,
    outcome: 'running',
    ...extra,
  };
}

describe('callLineSpec — total over any call', () => {
  it('a known tool with its object reads as the tool line, filled', () => {
    expect(callLineSpec(call())).toEqual({
      key: 'act.call.tool.read_file',
      placeholder: 'path',
      value: 'lib/auth/passwords.ts',
    });
    expect(
      callLineSpec(
        call({ tool: 'code_callers', object: { kind: 'query', value: 'refreshToken' } }),
      ),
    ).toMatchObject({ placeholder: 'symbol', value: 'refreshToken' });
  });

  it('a template that takes no object reads as its own line, object or not', () => {
    expect(callLineSpec(call({ tool: 'get_code_health', object: null }))).toEqual({
      key: 'act.call.tool.get_code_health',
      placeholder: null,
      value: null,
    });
  });

  it('a missing object, an unknown tool or a null tool reads as the family line; no family, the bare line', () => {
    expect(callLineSpec(call({ object: null })).key).toBe('act.call.family.code_read');
    expect(callLineSpec(call({ tool: 'brand_new_tool' })).key).toBe('act.call.family.code_read');
    expect(callLineSpec(call({ tool: null })).key).toBe('act.call.family.code_read');
    expect(callLineSpec(call({ tool: 'brand_new_tool', family: null })).key).toBe(
      'act.call.family.none',
    );
    // A prototype name is not a tool.
    expect(callLineSpec(call({ tool: 'toString' })).key).toBe('act.call.family.code_read');
  });
});

describe('shortenCallObject — the design’s rule per object kind', () => {
  it('leaves an object within the cap alone, and counts a CJK character as two columns', () => {
    expect(shortenCallObject('path', 'lib/auth/passwords.ts')).toEqual({
      text: 'lib/auth/passwords.ts',
      shortened: false,
    });
    expect(columns('会话')).toBe(4);
    expect(shortenCallObject('query', '会'.repeat(16)).shortened).toBe(false);
    const zh = shortenCallObject('query', '会'.repeat(17));
    expect(zh.shortened).toBe(true);
    expect(columns(zh.text)).toBeLessThanOrEqual(CALL_OBJECT_CAP);
  });

  it('a path keeps its first segment and file name; then `…/` + the file; then the file’s end', () => {
    expect(
      shortenCallObject('path', 'packages/design-system/src/components/theme/StyleVignette.tsx')
        .text,
    ).toBe('packages/…/StyleVignette.tsx');
    expect(
      shortenCallObject('path', 'node_modules_are_long/a/b/somewhat_long_file_name.ts').text,
    ).toBe('…/somewhat_long_file_name.ts');
    const file = 'a/' + 'x'.repeat(40) + '.ts';
    const short = shortenCallObject('path', file).text;
    expect(short.startsWith('…')).toBe(true);
    expect(short.endsWith('.ts')).toBe(true);
    expect(columns(short)).toBe(CALL_OBJECT_CAP);
  });

  it('a query and a title keep their start; a code-graph name keeps its end; a key is never shortened', () => {
    expect(
      shortenCallObject('query', 'sessions that outlive a password change everywhere').text,
    ).toBe('sessions that outlive a passwor…');
    expect(shortenCallObject('title', 'Move token refresh into SessionStore today').text).toBe(
      'Move token refresh into Session…',
    );
    expect(
      shortenCallObject('symbol', 'SessionStore.refreshTokenIfExpiringWithinGraceWindow').text,
    ).toBe('…okenIfExpiringWithinGraceWindow');
    const key = 'MOTIR-' + '1'.repeat(40);
    expect(shortenCallObject('item', key)).toEqual({ text: key, shortened: false });
    // An item named by its TITLE is a title, and shortens like one.
    expect(
      shortenCallObject('item', 'A very long working title for a brand new card').shortened,
    ).toBe(true);
  });

  it('draws a path, a code-graph name and a key in mono; a query and a title as prose', () => {
    expect(isMonoObject('path', 'a.ts')).toBe(true);
    expect(isMonoObject('symbol', 'x')).toBe(true);
    expect(isMonoObject('item', 'MOTIR-1')).toBe(true);
    expect(isMonoObject('item', 'A title')).toBe(false);
    expect(isMonoObject('query', 'billing')).toBe(false);
  });
});

describe('groupActs — a call finds its step, and none is lost', () => {
  const acts: PlanChangeProgress[] = [
    call({ callId: 'orphan' }), // 0: before any step
    { kind: 'submitted' }, // 1
    { kind: 'laying', target: 'MOTIR-1' }, // 2
    call({ callId: 'l1' }), // 3
    { kind: 'authoring', title: 'Card A' }, // 4
    { kind: 'authoring', title: 'Card B' }, // 5
    call({ callId: 'a1', itemRef: 'card a' }), // 6 → A (case-insensitive)
    call({ callId: 'b1', itemRef: 'Card B' }), // 7 → B
    call({ callId: 'a2', itemRef: 'Card A' }), // 8 → A
    call({ callId: 'x', itemRef: 'Not a live card' }), // 9 → most recent step (B)
    { kind: 'note', text: 'thinking' }, // 10
  ];

  it('nests by item ref, else under the most recent step, else on its own row', () => {
    const entries = groupActs(acts);
    expect(entries).toEqual([
      { type: 'call', index: 0 },
      { type: 'act', index: 1, calls: [] },
      { type: 'act', index: 2, calls: [3] },
      { type: 'act', index: 4, calls: [6, 8] },
      { type: 'act', index: 5, calls: [7, 9] },
      { type: 'act', index: 10, calls: [] },
    ]);
    const placed = entries.flatMap((e) => (e.type === 'call' ? [e.index] : e.calls));
    expect(placed.sort((a, b) => a - b)).toEqual([0, 3, 6, 7, 8, 9]);
  });

  it('opens the newest step and its parallel authoring level only while streaming', () => {
    const entries = groupActs(acts);
    expect([...openSteps(acts, entries, true)].sort()).toEqual([4, 5]);
    expect(openSteps(acts, entries, false).size).toBe(0);
    const laid: PlanChangeProgress[] = [{ kind: 'laying', target: 'X' }, call()];
    expect([...openSteps(laid, groupActs(laid), true)]).toEqual([0]);
    expect(openSteps([call()], groupActs([call()]), true).size).toBe(0);
  });

  it('counts failed and refused calls, not skipped ones', () => {
    const marked: PlanChangeProgress[] = [
      call({ outcome: 'failed' }),
      call({ outcome: 'refused' }),
      call({ outcome: 'skipped' }),
      call(),
      { kind: 'submitted' },
    ];
    expect(failedCount(marked, [0, 1, 2, 3, 4])).toBe(2);
  });
});

describe('barTarget — what the pinned bar repeats', () => {
  function target(acts: PlanChangeProgress[], streaming = true) {
    const entries = groupActs(acts);
    return barTarget(acts, entries, openSteps(acts, entries, streaming));
  }

  it('nothing to repeat on an empty record; a plain newest row repeats itself', () => {
    expect(target([])).toBeNull();
    expect(target([{ kind: 'laying', target: 'X' }, call(), { kind: 'note', text: 'n' }])).toEqual({
      type: 'act',
      index: 2,
    });
  });

  it('one open step: its newest call, or its own line before it has one', () => {
    expect(target([{ kind: 'laying', target: 'X' }, call(), call({ callId: 'c2' })])).toEqual({
      type: 'call',
      index: 2,
      step: null,
    });
    expect(target([{ kind: 'laying', target: 'X' }])).toEqual({ type: 'act', index: 0 });
  });

  it('two open author steps: the most recently started call, with its step', () => {
    const acts: PlanChangeProgress[] = [
      { kind: 'authoring', title: 'A' },
      { kind: 'authoring', title: 'B' },
      call({ callId: 'b', itemRef: 'B' }),
      call({ callId: 'a', itemRef: 'A' }),
    ];
    expect(target(acts)).toEqual({ type: 'call', index: 3, step: 0 });
    expect(target(acts.slice(0, 2))).toEqual({ type: 'act', index: 1 });
  });

  it('a call with no step repeats itself', () => {
    expect(target([call()])).toEqual({ type: 'call', index: 0, step: null });
  });
});

describe('the announcer — rows and marks, never plain calls', () => {
  const step: PlanChangeProgress = { kind: 'laying', target: 'X' };

  it('holds the newest row on mount, or nothing', () => {
    expect(latestRowAnnouncement([step, call()])).toEqual({ index: 0, mark: null });
    expect(latestRowAnnouncement([call()])).toBeNull();
  });

  it('a row appended replaces it; a call appended does not', () => {
    expect(nextAnnouncement([step], [step, call()])).toBeNull();
    expect(nextAnnouncement([step], [step, call(), { kind: 'validating' }])).toEqual({
      index: 2,
      mark: null,
    });
  });

  it('a call marked failed or refused replaces it; a skipped one does not', () => {
    const running = [step, call()];
    expect(nextAnnouncement(running, [step, call({ outcome: 'failed' })])).toEqual({
      index: 1,
      mark: 'failed',
    });
    expect(nextAnnouncement(running, [step, call({ outcome: 'refused' })])).toEqual({
      index: 1,
      mark: 'refused',
    });
    expect(nextAnnouncement(running, [step, call({ outcome: 'skipped' })])).toBeNull();
  });

  it('a record that does not continue the last one is announced afresh', () => {
    expect(nextAnnouncement([{ kind: 'reading' }], [{ kind: 'redirected' }])).toEqual({
      index: 0,
      mark: null,
    });
    expect(nextAnnouncement([step, call()], [])).toBeNull();
  });
});
