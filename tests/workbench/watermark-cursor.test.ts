import { describe, expect, it } from 'vitest';
import {
  decodeWatermarkCursor,
  encodeWatermarkCursor,
  movedTabs,
} from '@/lib/workbench/watermarkCursor';
import { WORKBENCH_TAB_KEYS, type WorkbenchTabWatermarkDto } from '@/lib/dto/workbench';

// THE WATERMARK CURSOR (Story MOTIR-5238 · Subtask MOTIR-5240) — the codec that
// carries a live reader's position, and the comparison that turns two readings
// into a list of tabs.
//
// The resume contract has THREE cases and only two of them are obvious. Absent
// and unreadable are opposite answers — *nothing has moved under me* versus *I
// may be holding a list this stream can no longer speak about* — and collapsing
// them is how a client that upgrades mid-session silently stops updating. The
// service owns that branch; this file pins the codec's half of it, which is that
// an unreadable cursor is reported as unreadable rather than as empty.

const pair = (count: number, latest: string | null): WorkbenchTabWatermarkDto => ({
  count,
  latest,
});

const reading = (
  overrides: Partial<Record<(typeof WORKBENCH_TAB_KEYS)[number], WorkbenchTabWatermarkDto>> = {},
): Record<(typeof WORKBENCH_TAB_KEYS)[number], WorkbenchTabWatermarkDto> => ({
  toDo: pair(3, '2026-09-17T10:00:00.000Z'),
  inProgress: pair(1, '2026-09-17T09:00:00.000Z'),
  recentlyFinished: pair(0, null),
  approvals: pair(2, '2026-09-17T11:30:00.000Z'),
  watching: pair(5, '2026-09-16T08:15:00.000Z'),
  ...overrides,
});

describe('the cursor round-trips every tab, including an empty one', () => {
  it('decodes to the reading it encoded', () => {
    const now = reading();
    expect(decodeWatermarkCursor(encodeWatermarkCursor(now))).toEqual(now);
  });

  it('is URL-safe — it survives a query string without escaping', () => {
    const cursor = encodeWatermarkCursor(reading());
    expect(cursor).toBe(encodeURIComponent(cursor));
  });

  it('keeps an EMPTY tab distinguishable from one whose latest is the epoch', () => {
    // `null` and "nothing here yet" are the same thing and travel as `0`; a tab
    // that genuinely holds a row stamped at the epoch is not a state this
    // product can reach, and conflating the two costs nothing that can occur.
    const decoded = decodeWatermarkCursor(encodeWatermarkCursor(reading()));
    expect(decoded?.recentlyFinished).toEqual({ count: 0, latest: null });
  });
});

describe('an unreadable cursor is reported as unreadable, never as empty', () => {
  it.each([
    ['a cursor from another format version', 'w2.eyJhIjoxfQ'],
    ['a truncated payload', 'w1.'],
    ['a payload that is not base64url JSON', 'w1.!!!!'],
    [
      'a payload whose array is the wrong length',
      `w1.${Buffer.from('[[1,2]]').toString('base64url')}`,
    ],
    [
      'a payload whose pairs are not numbers',
      `w1.${Buffer.from(
        JSON.stringify([
          ['3', 0],
          [1, 0],
          [0, 0],
          [2, 0],
          [5, 0],
        ]),
      ).toString('base64url')}`,
    ],
    ['a cursor with no version at all', 'not-a-cursor'],
  ])('answers null for %s', (_label, cursor) => {
    expect(decodeWatermarkCursor(cursor)).toBeNull();
  });

  it('answers null for an ABSENT cursor too — the caller distinguishes the two', () => {
    // ⚠️ The codec cannot tell *never presented* from *unreadable*, and it does
    // not try: the two differ in what the READER is holding, which only the
    // service knows. This assertion exists so that nobody "fixes" the codec by
    // making absent decode to an empty reading, which would silently turn the
    // unreadable case into *nothing moved*.
    expect(decodeWatermarkCursor(null)).toBeNull();
    expect(decodeWatermarkCursor(undefined)).toBeNull();
    expect(decodeWatermarkCursor('')).toBeNull();
  });
});

describe('movedTabs names exactly the tabs whose pair differs', () => {
  it('names nothing when the reading is unchanged — so replaying a cursor is idempotent', () => {
    expect(movedTabs(reading(), reading())).toEqual([]);
  });

  it('names a tab whose COUNT moved', () => {
    expect(movedTabs(reading(), reading({ toDo: pair(4, '2026-09-17T10:00:00.000Z') }))).toEqual([
      'toDo',
    ]);
  });

  it('names a tab whose LATEST moved while its count stood still — the EDIT case', () => {
    expect(
      movedTabs(reading(), reading({ approvals: pair(2, '2026-09-17T11:31:00.000Z') })),
    ).toEqual(['approvals']);
  });

  it('names several tabs in strip order', () => {
    const now = reading({
      watching: pair(6, '2026-09-16T08:15:00.000Z'),
      inProgress: pair(2, '2026-09-17T09:05:00.000Z'),
    });
    expect(movedTabs(reading(), now)).toEqual(['inProgress', 'watching']);
  });

  it('names nothing for a null cursor — an unread reader has had nothing move', () => {
    expect(movedTabs(null, reading())).toEqual([]);
  });
});
