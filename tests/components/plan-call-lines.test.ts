import { describe, expect, it } from 'vitest';
import {
  continuesRecord,
  isSessionStep,
  isStep,
  latestRowAnnouncement,
  nextAnnouncement,
  openSteps,
  withoutCalls,
} from '@/components/planning/planCallLines';
import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';

// THE ACT RECORD AS DATA (Story MOTIR-7974 · MOTIR-7979, amended by Story
// MOTIR-8060 · MOTIR-8064). The per-call lines are gone
// (`design/ai-chat/design-notes.md` § "⭐ Planner narration in the chat panel"),
// so what is left to pin is that a call never reaches the record's view, and the
// step and announcer rules over what does.

type CallAct = Extract<PlanChangeProgress, { kind: 'call' }>;

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

describe('withoutCalls — the record never draws a call', () => {
  it('drops every call act, in any outcome, and keeps the rest in order', () => {
    const acts: PlanChangeProgress[] = [
      call(),
      { kind: 'laying', target: 'X' },
      call({ outcome: 'failed' }),
      call({ outcome: 'refused' }),
      { kind: 'note', text: 'n' },
      call({ outcome: 'skipped' }),
    ];
    expect(withoutCalls(acts)).toEqual([
      { kind: 'laying', target: 'X' },
      { kind: 'note', text: 'n' },
    ]);
    expect(withoutCalls([call()])).toEqual([]);
  });
});

describe('steps', () => {
  it('names the walk steps, and the two a session head replaces', () => {
    expect(isStep({ kind: 'laying', target: null })).toBe(true);
    expect(isStep({ kind: 'note', text: 'n' })).toBe(false);
    expect(isSessionStep({ kind: 'authoring', title: 'A' })).toBe(true);
    expect(isSessionStep({ kind: 'laying', target: null })).toBe(true);
    expect(isSessionStep({ kind: 'reading' })).toBe(false);
  });

  it('opens the newest step and its parallel authoring level only while streaming', () => {
    const acts: PlanChangeProgress[] = [
      { kind: 'submitted' },
      { kind: 'laying', target: 'X' },
      { kind: 'authoring', title: 'A' },
      { kind: 'authoring', title: 'B' },
      { kind: 'note', text: 'thinking' },
    ];
    expect([...openSteps(acts, true)].sort()).toEqual([2, 3]);
    expect(openSteps(acts, false).size).toBe(0);
    expect([...openSteps([{ kind: 'laying', target: 'X' }], true)]).toEqual([0]);
    expect(openSteps([{ kind: 'submitted' }], true).size).toBe(0);
  });
});

describe('the announcer — the newest row', () => {
  const step: PlanChangeProgress = { kind: 'laying', target: 'X' };

  it('holds the newest row on mount, or nothing', () => {
    expect(latestRowAnnouncement([{ kind: 'submitted' }, step])).toBe(1);
    expect(latestRowAnnouncement([])).toBeNull();
  });

  it('a row appended replaces it; an unchanged record keeps it', () => {
    expect(nextAnnouncement([step], [step, { kind: 'validating' }])).toBe(1);
    expect(nextAnnouncement([step], [step])).toBeNull();
  });

  it('a record that does not continue the last one is announced afresh', () => {
    expect(continuesRecord([{ kind: 'reading' }], [{ kind: 'redirected' }])).toBe(false);
    expect(nextAnnouncement([{ kind: 'reading' }], [{ kind: 'redirected' }])).toBe(0);
    expect(nextAnnouncement([step], [])).toBeNull();
  });
});
