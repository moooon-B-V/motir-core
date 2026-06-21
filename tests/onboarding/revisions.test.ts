import { describe, expect, it } from 'vitest';
import {
  parseDocDiff,
  normalizeRevisionKind,
  humanizePath,
  formatDiffValue,
  mapRevisions,
  latestRevision,
  hasRevisionHistory,
} from '@/lib/onboarding/revisions';
import type { PreplanRevisionDTO, PreplanStateDTO } from '@/lib/dto/aiPreplan';

// Pure consumer-side helpers for the revise/diff/cascade-back UI (7.3.71). The
// diffs are computed upstream (motir-ai `diffDoc`, 7.3.24) and arrive opaque, so
// the parsing must be defensive: a malformed payload renders "no changes", never
// throws.

describe('parseDocDiff', () => {
  it('narrows a well-formed DocDiff, preserving before/after presence per kind', () => {
    const diff = [
      { path: 'pitch.headline', kind: 'changed', before: 'A', after: 'B' },
      { path: 'mvpScope.includes[2]', kind: 'added', after: 'export' },
      { path: 'risks[0]', kind: 'removed', before: 'churn' },
    ];
    const out = parseDocDiff(diff);
    expect(out).toEqual(diff);
    // `added` carries no `before`; `removed` carries no `after`.
    expect('before' in out[1]!).toBe(false);
    expect('after' in out[2]!).toBe(false);
  });

  it('is defensive: non-array, non-object entries, and bad kinds are dropped', () => {
    expect(parseDocDiff(null)).toEqual([]);
    expect(parseDocDiff('nope')).toEqual([]);
    expect(parseDocDiff(undefined)).toEqual([]);
    expect(
      parseDocDiff([
        null,
        42,
        { path: 'x', kind: 'mutated' }, // unknown kind → dropped
        { kind: 'added', after: 1 }, // missing path → tolerated (path '')
      ]),
    ).toEqual([{ path: '', kind: 'added', after: 1 }]);
  });
});

describe('normalizeRevisionKind', () => {
  it('maps the persisted changeKinds and defaults the rest to "other"', () => {
    expect(normalizeRevisionKind('created')).toBe('created');
    expect(normalizeRevisionKind('direct')).toBe('direct');
    expect(normalizeRevisionKind('cascade')).toBe('cascade');
    expect(normalizeRevisionKind(null)).toBe('other');
    expect(normalizeRevisionKind('weird')).toBe('other');
  });
});

describe('humanizePath', () => {
  it('de-camelCases segments and 1-indexes array positions', () => {
    expect(humanizePath('mvpScope.deferrals[0].whyCut')).toBe(
      'Mvp Scope › Deferrals › 1 › Why Cut',
    );
    expect(humanizePath('risks[2]')).toBe('Risks › 3');
    expect(humanizePath('pitch')).toBe('Pitch');
    expect(humanizePath('')).toBe('');
  });
});

describe('formatDiffValue', () => {
  it('renders scalars, summarises structures, and clamps long strings', () => {
    expect(formatDiffValue('hello')).toBe('hello');
    expect(formatDiffValue(7)).toBe('7');
    expect(formatDiffValue(true)).toBe('true');
    expect(formatDiffValue(null)).toBe('—');
    expect(formatDiffValue(undefined)).toBe('—');
    expect(formatDiffValue(['a', 'b'])).toBe('[2 items]');
    expect(formatDiffValue(['a'])).toBe('[1 item]');
    expect(formatDiffValue({ a: 1, b: 2 })).toBe('{a, b}');
    const long = 'x'.repeat(200);
    const out = formatDiffValue(long, 10);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(10);
  });
});

function rev(version: number, extra: Partial<PreplanRevisionDTO> = {}): PreplanRevisionDTO {
  return {
    version,
    changeReason: null,
    changeKind: version === 1 ? 'created' : 'direct',
    diff: version === 1 ? null : [{ path: 'p', kind: 'changed', before: 'a', after: 'b' }],
    createdAt: `2026-06-2${version}T00:00:00.000Z`,
    ...extra,
  };
}

describe('mapRevisions', () => {
  it('projects the DTO logs by kind, newest-first', () => {
    const dto: PreplanStateDTO = {
      session: null,
      catalog: null,
      docs: [
        { kind: 'discovery', currentBody: '', currentVersion: 2, versions: [rev(1), rev(2)] },
        { kind: 'vision', currentBody: '', currentVersion: 1, versions: [rev(1)] },
      ],
    };
    const byKind = mapRevisions(dto);
    expect(byKind.discovery!.map((v) => v.version)).toEqual([2, 1]);
    expect(byKind.vision!.map((v) => v.version)).toEqual([1]);
    expect(byKind.feasibility).toBeUndefined();
  });
});

describe('latestRevision / hasRevisionHistory', () => {
  it('returns the newest revision only when it is past the baseline', () => {
    expect(latestRevision([rev(1)])).toBeNull(); // baseline only
    expect(latestRevision([])).toBeNull();
    expect(latestRevision(undefined)).toBeNull();
    expect(latestRevision([rev(1), rev(3), rev(2)])!.version).toBe(3);
  });

  it('hasRevisionHistory is true only past the baseline', () => {
    expect(hasRevisionHistory([rev(1)])).toBe(false);
    expect(hasRevisionHistory([rev(1), rev(2)])).toBe(true);
    expect(hasRevisionHistory(undefined)).toBe(false);
  });
});
