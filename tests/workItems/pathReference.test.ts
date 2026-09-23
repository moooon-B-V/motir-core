import { describe, expect, it } from 'vitest';
import {
  bodyNamedFilePaths,
  criterionFilePaths,
  forwardReferenceRepo,
  sharesRepository,
  topLevelDirectory,
} from '@/lib/workItems/pathReference';

// THE PATH-REFERENCE advisory's pure half (MOTIR-5424): what counts as a path, which
// criterion names it, and the resolution verdict. The service half — the other
// namers, the ordering and the host — is `tests/integration/workItems/pathReferenceAdvisory.test.ts`.

describe('criterionFilePaths — the file paths a card is CLOSED against', () => {
  it('reads the acceptance criteria only, numbered 1-based, first criterion wins', () => {
    const md = [
      'Builds against `design/other/context.mock.html` (context, not a criterion).',
      '',
      '## Acceptance criteria',
      '',
      '1. Match `design/work-items/approval-cta.mock.html` exactly.',
      '2. Covered by `tests/e2e/acceptance-design-approval.spec.ts`.',
      '3. Re-reads design/work-items/approval-cta.mock.html after the merge.',
      '',
      '## Context refs',
      '- `lib/services/elsewhere.ts`',
    ].join('\n');
    expect(criterionFilePaths(md)).toEqual([
      { path: 'design/work-items/approval-cta.mock.html', criterionIndex: 1 },
      { path: 'tests/e2e/acceptance-design-approval.spec.ts', criterionIndex: 2 },
    ]);
  });

  it('a body with no acceptance-criteria heading, or no body, names nothing', () => {
    expect(criterionFilePaths('Touches `lib/x.ts`.')).toEqual([]);
    expect(criterionFilePaths(null)).toEqual([]);
    expect(criterionFilePaths(undefined)).toEqual([]);
  });

  it('keeps a Next.js route GROUP and a dynamic SEGMENT whole', () => {
    const md =
      '## Acceptance criteria\n- `app/(authed)/home/page.tsx` and app/api/items/[key]/route.ts render';
    expect(criterionFilePaths(md).map((p) => p.path)).toEqual([
      'app/(authed)/home/page.tsx',
      'app/api/items/[key]/route.ts',
    ]);
  });

  it('trims the punctuation a sentence wraps around a path, and nothing the path carries', () => {
    const md = [
      '## Acceptance criteria',
      '- It lands (see lib/home/cursor.ts).',
      '- [tests/helpers/renderWithIntl.ts] exports it; so does lib/db.ts, and lib/a.ts;',
      '- The route group survives a full stop: app/(authed)/home/page.tsx.',
    ].join('\n');
    expect(criterionFilePaths(md).map((p) => p.path)).toEqual([
      'lib/home/cursor.ts',
      'tests/helpers/renderWithIntl.ts',
      'lib/db.ts',
      'lib/a.ts',
      'app/(authed)/home/page.tsx',
    ]);
  });

  it('trims an UNBALANCED opener or closer on either end', () => {
    const md = [
      '## Acceptance criteria',
      '- (lib/a.ts and [lib/b.ts, then lib/c.ts] and lib/d.ts)',
    ].join('\n');
    expect(criterionFilePaths(md).map((p) => p.path)).toEqual([
      'lib/a.ts',
      'lib/b.ts',
      'lib/c.ts',
      'lib/d.ts',
    ]);
  });

  it('drops what is not a repository file: directories, hosts, URLs, elisions', () => {
    const md = [
      '## Acceptance criteria',
      '- the `lib/workItems/` folder and docs/decisions',
      '- https://github.com/moooon-B-V/motir-core/blob/main/lib/x.ts',
      '- app.motir.co/api/mcp.json and ghcr.io/token',
      '- `src/install-pnpm/bootstrap/.../pnpm-lock.json` and lib//double.ts',
    ].join('\n');
    expect(criterionFilePaths(md)).toEqual([]);
  });

  it('keeps a dot-DIRECTORY, which is a path rather than a host', () => {
    const md = '## Acceptance criteria\n- `.github/workflows/ci.yml` gains the lane';
    expect(criterionFilePaths(md).map((p) => p.path)).toEqual(['.github/workflows/ci.yml']);
  });
});

describe('bodyNamedFilePaths — the second namer reads the WHOLE body', () => {
  it('names a path from the prose, the criteria and the refs alike, as a set', () => {
    const md = [
      'Creates `design/work-items/approval-cta.mock.html`.',
      '## Acceptance criteria',
      '- the mock is design/work-items/approval-cta.mock.html',
      '## Context refs',
      '- `tests/design-asset-addresses.test.ts`',
    ].join('\n');
    expect([...bodyNamedFilePaths(md)]).toEqual([
      'design/work-items/approval-cta.mock.html',
      'tests/design-asset-addresses.test.ts',
    ]);
    expect(bodyNamedFilePaths(null).size).toBe(0);
  });
});

describe('topLevelDirectory', () => {
  it('is the first segment', () => {
    expect(topLevelDirectory('design/work-items/a.mock.html')).toBe('design');
    expect(topLevelDirectory('.github/workflows/ci.yml')).toBe('.github');
  });
});

describe('sharesRepository — the second namer must ship where the card ships', () => {
  it('an EMPTY set on either side has not said where it ships, so it may be anywhere', () => {
    expect(sharesRepository([], ['motir-ai'])).toBe(true);
    expect(sharesRepository(['motir-core'], [])).toBe(true);
  });

  it('two sets share when they intersect, case-insensitively', () => {
    expect(sharesRepository(['motir-core'], ['Motir-Core', 'motir-ai'])).toBe(true);
    expect(sharesRepository(['motir-core'], ['motir-ai'])).toBe(false);
  });
});

describe('forwardReferenceRepo — clauses (2) and (3), and silence on any unknown', () => {
  it('ABSENT under a PRESENT top-level directory is a forward reference, in that repo', () => {
    expect(
      forwardReferenceRepo([{ repo: 'motir-core', path: 'absent', directory: 'present' }]),
    ).toBe('motir-core');
  });

  it('a path that EXISTS is no finding — the second namer is only editing it', () => {
    expect(
      forwardReferenceRepo([{ repo: 'motir-core', path: 'present', directory: 'present' }]),
    ).toBeNull();
  });

  it('an absent top-level directory is somebody else’s file, not a forward reference', () => {
    expect(
      forwardReferenceRepo([{ repo: 'motir-core', path: 'absent', directory: 'absent' }]),
    ).toBeNull();
  });

  it('an UNKNOWN anywhere is silence, never a guess', () => {
    expect(
      forwardReferenceRepo([{ repo: 'motir-core', path: 'unknown', directory: 'present' }]),
    ).toBeNull();
    expect(
      forwardReferenceRepo([{ repo: 'motir-core', path: 'absent', directory: 'unknown' }]),
    ).toBeNull();
  });

  it('across a repository SET: absent in every member, and landing where the directory is', () => {
    expect(
      forwardReferenceRepo([
        { repo: 'motir-ai', path: 'absent', directory: 'absent' },
        { repo: 'motir-core', path: 'absent', directory: 'present' },
      ]),
    ).toBe('motir-core');
    expect(
      forwardReferenceRepo([
        { repo: 'motir-ai', path: 'present', directory: 'present' },
        { repo: 'motir-core', path: 'absent', directory: 'present' },
      ]),
    ).toBeNull();
  });

  it('no repository at all is no finding', () => {
    expect(forwardReferenceRepo([])).toBeNull();
  });
});
