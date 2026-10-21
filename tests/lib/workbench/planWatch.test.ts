import { describe, expect, it } from 'vitest';
import {
  formatWatchParams,
  parseWatchParams,
  WORKBENCH_STREAM_MAX_WATCHED_PLANS,
  type WatchedPlan,
} from '@/lib/workbench/planWatch';

// THE WATCHED-PLAN SET (Story MOTIR-8542 · MOTIR-8730) — the one encoder the
// client builds the stream URL with and the one parser the server reads it with.

function parse(query: string) {
  return parseWatchParams(new URLSearchParams(query));
}

describe('parseWatchParams / formatWatchParams', () => {
  it('round-trips a set, with and without a held version', () => {
    const plans: WatchedPlan[] = [
      { planId: 'cmplanaaaa0001', version: 'rv1.0123456789abcdef0123456789abcdef' },
      { planId: 'cmplanbbbb0002', version: null },
    ];
    const query = formatWatchParams(plans);

    expect(query).toBe(
      'watch=cmplanaaaa0001%3Arv1.0123456789abcdef0123456789abcdef&watch=cmplanbbbb0002%3A',
    );
    expect(parse(query)).toEqual(plans);
  });

  it('reads no watch parameter as the empty set, and formats the empty set as nothing', () => {
    expect(parse('since=w1.abc')).toEqual([]);
    expect(formatWatchParams([])).toBe('');
  });

  it('keeps a plan named twice once, with its first version', () => {
    expect(parse('watch=p1:rv1.a&watch=p1:rv1.b&watch=p2:')).toEqual([
      { planId: 'p1', version: 'rv1.a' },
      { planId: 'p2', version: null },
    ]);
  });

  it('rejects an entry with no version separator', () => {
    expect(parse('watch=p1')).toEqual({ error: expect.stringContaining('<planId>') });
  });

  it('rejects a bad plan id — empty, too long, or with characters outside the id alphabet', () => {
    for (const bad of [':rv1.a', `${'x'.repeat(65)}:rv1.a`, 'p%2F1:rv1.a', 'p 1:rv1.a', "p'1:"]) {
      expect(parse(`watch=${bad}`), bad).toEqual({ error: expect.stringContaining('plan id') });
    }
  });

  it('rejects a bad version', () => {
    expect(parse('watch=p1:rv1.a:b')).toEqual({
      error: expect.stringContaining('review version'),
    });
    expect(parse(`watch=p1:${'v'.repeat(129)}`)).toEqual({
      error: expect.stringContaining('review version'),
    });
  });

  it(`accepts ${WORKBENCH_STREAM_MAX_WATCHED_PLANS} plans and rejects the next one`, () => {
    const ids = Array.from({ length: WORKBENCH_STREAM_MAX_WATCHED_PLANS + 1 }, (_, i) => `p${i}`);
    const ten = formatWatchParams(ids.slice(0, -1).map((planId) => ({ planId, version: null })));
    const eleven = formatWatchParams(ids.map((planId) => ({ planId, version: null })));

    expect(parse(ten)).toHaveLength(WORKBENCH_STREAM_MAX_WATCHED_PLANS);
    expect(parse(eleven)).toEqual({ error: expect.stringContaining('at most') });
  });
});
