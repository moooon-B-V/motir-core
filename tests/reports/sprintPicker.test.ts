import { describe, expect, it } from 'vitest';
import type { SprintDto } from '@/lib/dto/sprints';
import { pickReportSprints } from '@/lib/reports/sprintPicker';

// The shared Burndown / Sprint report sprint list (Story MOTIR-8919): active
// first, then completed newest → oldest, planned excluded, and a default that is
// the active sprint else the most recently completed.

const s = (id: string, state: SprintDto['state'], sequence: number): SprintDto =>
  ({ id, name: `Sprint ${sequence}`, state, sequence }) as SprintDto;

describe('pickReportSprints', () => {
  it('lists the active sprint first, then completed newest to oldest, with the default the active one', () => {
    const out = pickReportSprints([
      s('c1', 'complete', 1),
      s('c2', 'complete', 2),
      s('a', 'active', 3),
    ]);
    expect(out.pickerSprints.map((p) => p.id)).toEqual(['a', 'c2', 'c1']);
    expect(out.defaultSprint?.id).toBe('a');
  });

  it('excludes planned sprints', () => {
    const out = pickReportSprints([s('p', 'planned', 1), s('c1', 'complete', 2)]);
    expect(out.pickerSprints.map((p) => p.id)).toEqual(['c1']);
  });

  it('defaults to the most recently completed sprint when none is active', () => {
    const out = pickReportSprints([s('c1', 'complete', 1), s('c2', 'complete', 2)]);
    expect(out.defaultSprint?.id).toBe('c2');
  });

  it('carries id, name and state, and is empty when nothing has started', () => {
    expect(pickReportSprints([s('a', 'active', 1)]).pickerSprints[0]).toEqual({
      id: 'a',
      name: 'Sprint 1',
      state: 'active',
    });
    expect(pickReportSprints([s('p', 'planned', 1)])).toEqual({
      pickerSprints: [],
      defaultSprint: null,
    });
    expect(pickReportSprints([])).toEqual({ pickerSprints: [], defaultSprint: null });
  });
});
