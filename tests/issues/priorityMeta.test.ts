import { describe, expect, it } from 'vitest';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

const WORK_ITEM_PRIORITIES: WorkItemPriorityDto[] = PRIORITY_OPTIONS.map((o) => o.value);

// MOTIR-1273 · 1266.2 — the headline "palettes can't differentiate priority"
// fix: `medium` AND `lowest` were both `tone: 'neutral'` (one grey). Each
// priority now routes through the dedicated `priority` Pill axis so all 5 are
// DISTINCT.

describe('PRIORITY_META', () => {
  it('covers exactly the five priorities', () => {
    expect(Object.keys(PRIORITY_META).sort()).toEqual([...WORK_ITEM_PRIORITIES].sort());
  });

  it('routes every priority through the dedicated `priority` Pill axis (not severity/tone)', () => {
    for (const p of WORK_ITEM_PRIORITIES) {
      const { pill } = PRIORITY_META[p];
      expect(pill.priority).toBe(p);
      // The old collapsed axes must be gone, so two priorities can't share a tone.
      expect(pill.severity).toBeUndefined();
      expect(pill.tone).toBeUndefined();
    }
  });

  it('gives all five priorities a DISTINCT pill tone (un-collapses medium vs lowest)', () => {
    const tones = WORK_ITEM_PRIORITIES.map((p) => PRIORITY_META[p].pill.priority);
    expect(new Set(tones).size).toBe(WORK_ITEM_PRIORITIES.length);
    // The exact regression that was reported: medium and lowest were identical.
    expect(PRIORITY_META.medium.pill.priority).not.toBe(PRIORITY_META.lowest.pill.priority);
  });

  it('keeps the redundant direction icon (non-colour AA cue, finding #35)', () => {
    expect(PRIORITY_META.highest.icon).toBe(ArrowUp);
    expect(PRIORITY_META.high.icon).toBe(ArrowUp);
    expect(PRIORITY_META.medium.icon).toBe(Minus);
    expect(PRIORITY_META.low.icon).toBe(ArrowDown);
    expect(PRIORITY_META.lowest.icon).toBe(ArrowDown);
  });
});
