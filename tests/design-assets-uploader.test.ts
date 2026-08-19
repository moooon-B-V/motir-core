import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  authHeadersFor,
  buildPublishSet,
  classifyDesignPath,
  collectChangedDesignFiles,
  contentTypeFor,
  extractChangedNoteSections,
  main,
  NotALeafError,
  parseHunkRanges,
  parseWorkItemKey,
  publishDesignResult,
  resolveTargetKey,
  splitNoteSections,
} from '../scripts/upload-design-assets.mjs';

// The CI design-result publisher (Story MOTIR-2664 · Subtask MOTIR-2668). Every
// stage is exercised with git and the filesystem INJECTED, so the suite needs no
// repository state — except the note-splitting assertions, which run against the
// REAL `design/work-items/design-notes.md`, because the whole reason the note is
// scoped to sections is a property of that actual file.
//
// ⚠️ This spec reads `design/**`, so it is in `vitest.design.config.ts`'s
// include list: a design-only PR can break it, and that is exactly the class of
// failure the design-guard lane exists to catch (MOTIR-2442).

const ROOT = process.cwd();
const REAL_NOTES = join(ROOT, 'design/work-items/design-notes.md');

describe('parseWorkItemKey / resolveTargetKey', () => {
  it('reads a key out of a branch ref or a PR title', () => {
    expect(parseWorkItemKey('design/MOTIR-2669-design-result-panel')).toBe('MOTIR-2669');
    expect(parseWorkItemKey('Design — the result panel (MOTIR-2669)')).toBe('MOTIR-2669');
    expect(parseWorkItemKey('motir-2669')).toBe('MOTIR-2669');
    expect(parseWorkItemKey('no key here')).toBeNull();
    expect(parseWorkItemKey('')).toBeNull();
    expect(parseWorkItemKey(undefined)).toBeNull();
  });

  it('prefers an explicit override, then the branch, then the title', () => {
    expect(resolveTargetKey({ DESIGN_TARGET_KEY: 'motir-1' })).toEqual({
      key: 'MOTIR-1',
      source: 'explicit',
    });
    expect(
      resolveTargetKey({
        DESIGN_PR_REF: 'design/MOTIR-2-slug',
        DESIGN_PR_TITLE: 'something (MOTIR-3)',
      }),
    ).toEqual({ key: 'MOTIR-2', source: 'branch' });
    expect(resolveTargetKey({ DESIGN_PR_TITLE: 'something (MOTIR-3)' })).toEqual({
      key: 'MOTIR-3',
      source: 'title',
    });
  });

  it('resolves to NOTHING rather than guessing — there is no fallback constant', () => {
    // The acceptance uploader falls back to its dogfood story, which is right
    // for a receipt better attached somewhere than nowhere. A design attached to
    // the WRONG card makes another card look designed when it is not.
    expect(resolveTargetKey({})).toEqual({ key: null, source: 'none' });
    expect(resolveTargetKey({ DESIGN_PR_REF: 'chore/tidy-up' })).toEqual({
      key: null,
      source: 'none',
    });
  });
});

describe('classifyDesignPath', () => {
  it('recognises the three artifact kinds and nothing else', () => {
    expect(classifyDesignPath('design/work-items/a.mock.html')).toBe('mock');
    expect(classifyDesignPath('design/work-items/a.png')).toBe('image');
    expect(classifyDesignPath('design/work-items/design-notes.md')).toBe('note');
    expect(classifyDesignPath('design/work-items/notes.md')).toBeNull();
    expect(classifyDesignPath('design/work-items/a.pen')).toBeNull();
    expect(classifyDesignPath('design/README.md')).toBeNull();
  });

  it('maps each kind to the content type the allowlist expects', () => {
    expect(contentTypeFor('mock')).toBe('text/html');
    expect(contentTypeFor('image')).toBe('image/png');
    expect(contentTypeFor('note_file')).toBe('text/markdown');
  });
});

describe('collectChangedDesignFiles', () => {
  const changed = [
    'design/work-items/design-result.mock.html',
    'design/work-items/design-result.png',
    'design/work-items/design-notes.md',
    'design/work-items/detail.pen',
    'design/work-items/gone.mock.html',
  ].join('\n');

  const git = () => changed;
  const exists = (p: string) => !p.endsWith('gone.mock.html');

  it('classifies the changed set and separates what is not publishable', () => {
    const out = collectChangedDesignFiles({ base: 'base', git, exists, cwd: ROOT });

    expect(out.assets).toEqual([
      { kind: 'mock', sourcePath: 'design/work-items/design-result.mock.html' },
      { kind: 'image', sourcePath: 'design/work-items/design-result.png' },
    ]);
    expect(out.notes).toEqual(['design/work-items/design-notes.md']);
    // A `.pen` source is not one of the three published artifacts.
    expect(out.ignored).toEqual(['design/work-items/detail.pen']);
    // A path the PR DELETED publishes nothing for that file.
    expect(out.deleted).toEqual(['design/work-items/gone.mock.html']);
  });

  it('returns empty sets for a PR that touched no design file', () => {
    const out = collectChangedDesignFiles({ base: 'base', git: () => '', exists, cwd: ROOT });
    expect(out.assets).toEqual([]);
    expect(out.notes).toEqual([]);
  });
});

describe('parseHunkRanges', () => {
  it('reads the NEW-side range of each hunk', () => {
    const diff = [
      '@@ -1,3 +1,4 @@',
      '@@ -40 +41 @@',
      '@@ -100,5 +101,0 @@',
      'not a hunk header',
    ].join('\n');

    expect(parseHunkRanges(diff)).toEqual([
      { start: 1, end: 4 },
      { start: 41, end: 41 },
      // A pure DELETION (`+101,0`) still maps to the line it happened at, so the
      // section it was removed from is republished rather than silently skipped.
      { start: 101, end: 101 },
    ]);
  });

  it('finds nothing in an empty diff', () => {
    expect(parseHunkRanges('')).toEqual([]);
  });
});

describe('splitNoteSections — against the REAL design-notes.md', () => {
  const content = readFileSync(REAL_NOTES, 'utf8');
  const sections = splitNoteSections(content);
  const lineCount = content.split('\n').length;

  it('finds the per-AREA file to be many sections long — which is why the note is scoped', () => {
    // The exact count drifts as surfaces are added, so this asserts the SHAPE
    // that makes section-scoping necessary, not a number that would make every
    // design PR edit this test.
    expect(sections.length).toBeGreaterThan(20);
    expect(content.length).toBeGreaterThan(100_000);
  });

  it('splits on `##` only — a `###` subsection travels with its parent', () => {
    for (const section of sections) {
      expect(section.text.startsWith('## ')).toBe(true);
      // Exactly one `##` heading per section (its own); `###` lines are fine.
      const headings = section.text.split('\n').filter((l: string) => /^## /.test(l));
      expect(headings).toHaveLength(1);
    }
    expect(sections.some((s) => s.text.includes('\n### '))).toBe(true);
  });

  it('covers the file contiguously from the first heading to the end', () => {
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i]!.startLine).toBe(sections[i - 1]!.endLine + 1);
    }
    expect(sections.at(-1)!.endLine).toBe(lineCount);
    // Everything above the first heading is the title + the surface index table,
    // deliberately NOT a section.
    expect(sections[0]!.startLine).toBeGreaterThan(1);
  });
});

describe('extractChangedNoteSections', () => {
  const note = [
    '# Area — design notes',
    '',
    '| Surface | Asset |',
    '| --- | --- |',
    '| One | a |',
    '',
    '## One', // line 7
    'first body',
    '',
    '## Two', // line 10
    'second body',
    '',
    '## Three', // line 13
    'third body',
  ].join('\n');

  const readFile = () => note;

  it('publishes ONLY the section a hunk landed in', () => {
    const git = () => '@@ -8 +8 @@';
    const out = extractChangedNoteSections({ notePath: 'n.md', base: 'b', git, readFile });

    expect(out.reason).toBe('ok');
    expect(out.sections).toBe(1);
    expect(out.noteMd).toContain('## One');
    expect(out.noteMd).not.toContain('## Two');
    expect(out.noteMd).not.toContain('## Three');
  });

  it('publishes two changed sections in FILE order, de-duplicated', () => {
    // Deliberately out of order, and with two hunks inside the same section.
    const git = () => ['@@ -14 +14 @@', '@@ -8 +8 @@', '@@ -9 +9 @@'].join('\n');
    const out = extractChangedNoteSections({ notePath: 'n.md', base: 'b', git, readFile });

    expect(out.sections).toBe(2);
    expect(out.noteMd!.indexOf('## One')).toBeLessThan(out.noteMd!.indexOf('## Three'));
    expect(out.noteMd).not.toContain('## Two');
  });

  it('publishes EVERY section of a notes file the PR ADDED — one whole-file hunk', () => {
    // MOTIR-3145. `git diff -U0` renders an ADDED file as a single
    // `@@ -0,0 +1,N @@` hunk covering every line, which is exactly the shape of
    // the card whose deliverable IS the note. Mapping that range to the FIRST
    // section it overlaps published 1 of 25 sections and printed a success line.
    const added = [
      '# Area — design notes', // 1
      '',
      '| Surface | Asset |',
      '| --- | --- |',
      '| One | a |',
      '',
      '## One', // 7
      'first body',
      '',
      '## Two', // 10
      'second body',
      '',
      '## Three', // 13
      'third body',
      '',
      '## Four', // 16
      'fourth body', // 17
    ].join('\n');

    const git = () => '@@ -0,0 +1,17 @@';
    const out = extractChangedNoteSections({
      notePath: 'n.md',
      base: 'b',
      git,
      readFile: () => added,
    });

    expect(out.reason).toBe('ok');
    expect(out.sections).toBe(4);
    for (const heading of ['## One', '## Two', '## Three', '## Four']) {
      expect(out.noteMd).toContain(heading);
    }
    // The title and the index table are still NOT part of the note, even when
    // the same hunk covers them (docs/decisions/design-result.md §1).
    expect(out.noteMd!.startsWith('## One')).toBe(true);
    expect(out.noteMd).not.toContain('| Surface | Asset |');
  });

  it('publishes BOTH sections a single hunk straddles', () => {
    // `@@ -12,2 +12,2 @@` → new-side lines 12–13, which is the last line of
    // section Two and the heading of section Three.
    const git = () => '@@ -12,2 +12,2 @@';
    const out = extractChangedNoteSections({ notePath: 'n.md', base: 'b', git, readFile });

    expect(out.sections).toBe(2);
    expect(out.noteMd).toContain('## Two');
    expect(out.noteMd).toContain('## Three');
    expect(out.noteMd).not.toContain('## One');
  });

  it('publishes NOTHING for a change confined to the surface index table', () => {
    // The table is an INDEX. A card that adds a surface always adds its section
    // too, so the section carries the meaning — and falling back to the whole
    // file would attach a 300 KB, 29-surface document as "this card's note".
    const git = () => '@@ -5 +5 @@';
    const out = extractChangedNoteSections({ notePath: 'n.md', base: 'b', git, readFile });

    expect(out.noteMd).toBeNull();
    expect(out.reason).toBe('above-first-section');
  });

  it('publishes nothing when the diff has no hunks at all', () => {
    const out = extractChangedNoteSections({
      notePath: 'n.md',
      base: 'b',
      git: () => '',
      readFile,
    });
    expect(out.noteMd).toBeNull();
    expect(out.reason).toBe('no-hunks');
  });

  it('publishes nothing from a notes file that has no sections yet', () => {
    const out = extractChangedNoteSections({
      notePath: 'n.md',
      base: 'b',
      git: () => '@@ -1 +1 @@',
      readFile: () => '# Only a title\n',
    });
    expect(out.noteMd).toBeNull();
    expect(out.reason).toBe('no-sections');
  });
});

describe('buildPublishSet', () => {
  it('adds the note as a note_file asset ALONGSIDE the inline note', () => {
    // Both forms always ship: the inline copy is what the panel renders (capped
    // server-side at 64 KiB), the file is what makes that cap a rendering bound
    // rather than a data-loss bound.
    const out = buildPublishSet({
      collected: { assets: [{ kind: 'mock', sourcePath: 'design/a/x.mock.html' }] },
      noteResults: [{ noteMd: '## X\n\nbody', notePath: 'design/a/design-notes.md' }],
    });

    expect(out.noteMd).toBe('## X\n\nbody');
    expect(out.assets).toEqual([
      { kind: 'mock', sourcePath: 'design/a/x.mock.html' },
      { kind: 'note_file', sourcePath: 'design/a/design-notes.md', text: '## X\n\nbody' },
    ]);
  });

  it('carries a note_file PER AREA, and concatenates them for the inline note', () => {
    // MOTIR-3145. Two areas is a legitimate shape — a PR describing two
    // surfaces — and the card is where both belong. Each file carries only its
    // own text, so `sourcePath` stays a true statement about those bytes; the
    // inline copy the panel renders is their concatenation.
    const out = buildPublishSet({
      collected: { assets: [] },
      noteResults: [
        { noteMd: '## Auth\n\nbody', notePath: 'design/auth/design-notes.md' },
        { noteMd: '## Mono\n\nbody', notePath: 'design/typography/design-notes.md' },
      ],
    });

    expect(out.noteMd).toBe('## Auth\n\nbody\n\n## Mono\n\nbody');
    expect(out.assets).toEqual([
      { kind: 'note_file', sourcePath: 'design/auth/design-notes.md', text: '## Auth\n\nbody' },
      {
        kind: 'note_file',
        sourcePath: 'design/typography/design-notes.md',
        text: '## Mono\n\nbody',
      },
    ]);
  });

  it('adds no note_file when the PR changed no section', () => {
    const out = buildPublishSet({
      collected: { assets: [{ kind: 'image', sourcePath: 'design/a/x.png' }] },
      noteResults: [],
    });
    expect(out.noteMd).toBeNull();
    expect(out.assets).toHaveLength(1);
  });
});

describe('authHeadersFor', () => {
  it('marks a keyless publish, and falls back to a bare bearer', () => {
    expect(authHeadersFor('oidc-jwt', 'pat')).toEqual({
      authorization: 'Bearer oidc-jwt',
      'x-motir-auth': 'github-oidc',
    });
    expect(authHeadersFor(null, 'pat')).toEqual({ authorization: 'Bearer pat' });
  });
});

describe('publishDesignResult', () => {
  function fakeFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/upload-token')) {
        return {
          ok: true,
          json: async () => ({
            targets: [
              {
                kind: 'mock',
                sourcePath: 'design/a/x.mock.html',
                pathname: 'design/ws/item/x.mock.html',
                token: 'https://store.example/put/x',
                contentType: 'text/html',
                maxBytes: 100,
              },
              {
                kind: 'note_file',
                sourcePath: 'design/a/design-notes.md',
                pathname: 'design/ws/item/design-notes.md',
                token: 'https://store.example/put/n',
                contentType: 'text/markdown',
                maxBytes: 100,
              },
            ],
          }),
        };
      }
      if (url.startsWith('https://store.example/')) return { ok: true };
      return { ok: true, json: async () => ({ evidence: { id: 'ev-1' } }) };
    });
    return { impl, calls };
  }

  it('mints, PUTs every artifact, then registers the pathnames', async () => {
    const { impl, calls } = fakeFetch();
    const evidence = await publishDesignResult({
      baseUrl: 'https://app.example',
      targetKey: 'MOTIR-1',
      assets: [
        { kind: 'mock', sourcePath: 'design/a/x.mock.html' },
        { kind: 'note_file', sourcePath: 'design/a/design-notes.md' },
      ],
      noteMd: '## X\n\nbody',
      headers: { authorization: 'Bearer t' },
      fetchImpl: impl as never,
      readFileBuffer: () => Buffer.from('<html></html>'),
    });

    expect(evidence).toEqual({ id: 'ev-1' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://app.example/api/work-items/MOTIR-1/design-evidence/upload-token',
      'https://store.example/put/x',
      'https://store.example/put/n',
      'https://app.example/api/work-items/MOTIR-1/design-evidence',
    ]);

    // The note_file's bytes are the EXTRACTED note, not the whole repo file.
    const notePut = calls[2]!;
    expect(notePut.init.body!.toString()).toBe('## X\n\nbody');

    // Register reports the pathnames the mint returned, never a caller-chosen key.
    const registered = JSON.parse(calls[3]!.init.body as string);
    expect(registered.assets.map((a: { pathname: string }) => a.pathname)).toEqual([
      'design/ws/item/x.mock.html',
      'design/ws/item/design-notes.md',
    ]);
    expect(registered.noteMd).toBe('## X\n\nbody');
  });

  it('PUTs each note_file its OWN text, not the concatenation', async () => {
    // MOTIR-3145. With two areas the inline `noteMd` is both notes joined; each
    // stored file must still be the note it is NAMED for, or `sourcePath` is a
    // lie about the bytes behind it.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/upload-token')) {
        return {
          ok: true,
          json: async () => ({
            targets: [
              {
                kind: 'note_file',
                sourcePath: 'design/auth/design-notes.md',
                pathname: 'p/1-design-notes.md',
                token: 'https://store.example/put/auth',
                contentType: 'text/markdown',
              },
              {
                kind: 'note_file',
                sourcePath: 'design/typography/design-notes.md',
                pathname: 'p/2-design-notes.md',
                token: 'https://store.example/put/typography',
                contentType: 'text/markdown',
              },
            ],
          }),
        };
      }
      if (url.startsWith('https://store.example/')) return { ok: true };
      return { ok: true, json: async () => ({ evidence: { id: 'ev-2' } }) };
    });

    await publishDesignResult({
      baseUrl: 'https://app.example',
      targetKey: 'MOTIR-1',
      assets: [
        { kind: 'note_file', sourcePath: 'design/auth/design-notes.md', text: '## Auth\n\nbody' },
        {
          kind: 'note_file',
          sourcePath: 'design/typography/design-notes.md',
          text: '## Mono\n\nbody',
        },
      ],
      noteMd: '## Auth\n\nbody\n\n## Mono\n\nbody',
      headers: {},
      fetchImpl: impl as never,
    });

    expect(calls[1]!.init.body!.toString()).toBe('## Auth\n\nbody');
    expect(calls[2]!.init.body!.toString()).toBe('## Mono\n\nbody');
    // The inline copy the panel renders is still the whole thing.
    expect(JSON.parse(calls[3]!.init.body as string).noteMd).toBe(
      '## Auth\n\nbody\n\n## Mono\n\nbody',
    );
  });

  it('fails loudly when the mint is refused', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'nope' }));
    await expect(
      publishDesignResult({
        baseUrl: 'https://app.example',
        targetKey: 'MOTIR-1',
        assets: [{ kind: 'mock', sourcePath: 'a' }],
        noteMd: null,
        headers: {},
        fetchImpl: impl as never,
      }),
    ).rejects.toThrow(/Minting upload grants failed: 403/);
  });

  it('fails loudly when an upload is refused', async () => {
    const impl = vi.fn(async (url: string) => {
      if (url.endsWith('/upload-token')) {
        return {
          ok: true,
          json: async () => ({
            targets: [
              {
                kind: 'mock',
                sourcePath: 'design/a/x.mock.html',
                pathname: 'p',
                token: 'https://store.example/put/x',
                contentType: 'text/html',
              },
            ],
          }),
        };
      }
      return { ok: false, status: 500 };
    });

    await expect(
      publishDesignResult({
        baseUrl: 'https://app.example',
        targetKey: 'MOTIR-1',
        assets: [{ kind: 'mock', sourcePath: 'design/a/x.mock.html' }],
        noteMd: null,
        headers: {},
        fetchImpl: impl as never,
        readFileBuffer: () => Buffer.from('x'),
      }),
    ).rejects.toThrow(/Uploading design\/a\/x\.mock\.html failed: 500/);
  });
});

describe('main — the ways it exits 0 WITHOUT publishing', () => {
  const logger = () => {
    const lines: string[] = [];
    return { log: (m: string) => lines.push(m), lines };
  };

  it('no base sha → nothing to diff against', async () => {
    const log = logger();
    expect(await main({}, log as never)).toBe(0);
    expect(log.lines.join(' ')).toContain('nothing to publish');
  });

  const oneMock = {
    assets: [{ kind: 'mock', sourcePath: 'design/a/x.mock.html' }],
    notes: [],
    ignored: [],
    deleted: [],
  };

  it('a PR that changed no design artifact publishes nothing', async () => {
    const log = logger();
    const publish = vi.fn();
    const code = await main({ DESIGN_BASE_SHA: 'base' }, log as never, {
      collect: () => ({ assets: [], notes: [], ignored: [], deleted: [] }),
      publish,
    });

    expect(code).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(log.lines.join(' ')).toContain('Nothing to publish');
  });

  it('an UNRESOLVABLE target publishes nothing, and says what it would have sent', async () => {
    const log = logger();
    const publish = vi.fn();
    const code = await main({ DESIGN_BASE_SHA: 'base' }, log as never, {
      collect: () => oneMock,
      publish,
    });

    expect(code).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    const said = log.lines.join(' ');
    expect(said).toContain('NOT publishing');
    // The operator can see what was skipped without re-running anything.
    expect(said).toContain('mock:design/a/x.mock.html');
  });

  it('a CONTAINER target publishes nothing and stays GREEN — the parent-run pull request', async () => {
    // MOTIR-3009. A parent run opens ONE pull request per repository, on
    // `parent/MOTIR-<story>-…`, and it carries the design child's asset
    // amendments alongside the code they document. The service refuses a design
    // result addressed to a story, correctly — a result attaches to the leaf
    // that produced it — and before this the refusal red-lit the whole run,
    // whose only remedy would have been deleting a correct amendment.
    const log = logger();
    const publish = vi.fn(async () => {
      throw new NotALeafError('MOTIR-2999', '{"code":"DESIGN_EVIDENCE_NOT_A_LEAF"}');
    });
    const code = await main(
      {
        DESIGN_BASE_SHA: 'base',
        DESIGN_PR_REF: 'parent/MOTIR-2999-implemented-status',
        MOTIR_UPLOAD_TOKEN: 'pat',
      },
      log as never,
      { collect: () => oneMock, publish },
    );

    expect(code).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
    const said = log.lines.join(' ');
    expect(said).toContain('CONTAINER');
    // Same courtesy as the unresolvable-target exit: say what was skipped.
    expect(said).toContain('mock:design/a/x.mock.html');
  });

  it('ANY OTHER publish failure is still RED — the no-op is scoped to the one refusal', async () => {
    const log = logger();
    const publish = vi.fn(async () => {
      throw new Error('Minting upload grants failed: 500 upstream is down');
    });
    await expect(
      main(
        { DESIGN_BASE_SHA: 'base', DESIGN_PR_REF: 'design/MOTIR-1-x', MOTIR_UPLOAD_TOKEN: 'pat' },
        log as never,
        { collect: () => oneMock, publish },
      ),
    ).rejects.toThrow(/upstream is down/);
  });

  it('no OIDC and no PAT → publishing is opt-in (a fork PR must not fail the build)', async () => {
    const log = logger();
    const publish = vi.fn();
    const code = await main(
      { DESIGN_BASE_SHA: 'base', DESIGN_PR_REF: 'design/MOTIR-1-x' },
      log as never,
      { collect: () => oneMock, requestOidc: async () => null, publish },
    );

    expect(code).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(log.lines.join(' ')).toContain('opt-in');
  });

  it('publishes with the OIDC identity when there is one, and reports what it sent', async () => {
    const log = logger();
    const publish = vi.fn(async (_args: Record<string, unknown>) => ({ id: 'ev-9' }));
    const code = await main(
      {
        DESIGN_BASE_SHA: 'base',
        DESIGN_PR_REF: 'design/MOTIR-2669-panel',
        GITHUB_SHA: 'cafe123',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'moooon-B-V/motir-core',
        GITHUB_RUN_ID: '42',
      },
      log as never,
      {
        collect: () => ({ ...oneMock, notes: ['design/a/design-notes.md'] }),
        extractNote: () => ({ noteMd: '## X\n\nbody', reason: 'ok', sections: 1 }),
        requestOidc: async () => 'oidc-jwt',
        publish,
      },
    );

    expect(code).toBe(0);
    const call = publish.mock.calls[0]![0];
    expect(call.targetKey).toBe('MOTIR-2669');
    expect(call.noteMd).toBe('## X\n\nbody');
    // Keyless: the OIDC marker, not a bearer PAT.
    expect(call.headers).toEqual({
      authorization: 'Bearer oidc-jwt',
      'x-motir-auth': 'github-oidc',
    });
    expect(call.commitSha).toBe('cafe123');
    expect(call.ciRunUrl).toBe('https://github.com/moooon-B-V/motir-core/actions/runs/42');
    // The note ships in BOTH forms.
    expect((call.assets as Array<{ kind: string }>).map((a) => a.kind)).toEqual([
      'mock',
      'note_file',
    ]);
    expect(log.lines.join(' ')).toContain('MOTIR-2669');
  });

  it('publishes BOTH areas when a PR changed two notes files — neither is dropped', async () => {
    // MOTIR-3145. The loop used to `break` on the first note that yielded a
    // section, so a second area was never examined and appeared NOWHERE in the
    // job log — indistinguishable from a PR that only ever touched one area.
    const log = logger();
    const publish = vi.fn(async (_args: Record<string, unknown>) => ({ id: 'ev-11' }));
    const notes = ['design/auth/design-notes.md', 'design/typography/design-notes.md'];

    const code = await main(
      { DESIGN_BASE_SHA: 'base', DESIGN_PR_REF: 'design/MOTIR-1-x', MOTIR_UPLOAD_TOKEN: 'pat' },
      log as never,
      {
        collect: () => ({ assets: [], notes, ignored: [], deleted: [] }),
        extractNote: ({ notePath }: { notePath: string }) =>
          notePath.includes('auth')
            ? { noteMd: '## Auth\n\nbody', reason: 'ok', sections: 18 }
            : { noteMd: '## Mono\n\nbody', reason: 'ok', sections: 7 },
        requestOidc: async () => null,
        publish,
      },
    );

    expect(code).toBe(0);
    const call = publish.mock.calls[0]![0];
    expect(call.assets).toEqual([
      { kind: 'note_file', sourcePath: notes[0], text: '## Auth\n\nbody' },
      { kind: 'note_file', sourcePath: notes[1], text: '## Mono\n\nbody' },
    ]);
    expect(call.noteMd).toBe('## Auth\n\nbody\n\n## Mono\n\nbody');
    // Both areas are NAMED in the log, with their own section counts.
    const said = log.lines.join('\n');
    expect(said).toContain(`Design note: 18 changed section(s) from ${notes[0]}.`);
    expect(said).toContain(`Design note: 7 changed section(s) from ${notes[1]}.`);
  });

  it('NAMES a note it omitted even after another note has already succeeded', async () => {
    // The omission branch was unreachable past the first success, which is what
    // made the drop silent. Order matters: the succeeding note comes FIRST.
    const log = logger();
    const publish = vi.fn(async (_args: Record<string, unknown>) => ({ id: 'ev-12' }));
    const notes = ['design/auth/design-notes.md', 'design/typography/design-notes.md'];

    await main(
      { DESIGN_BASE_SHA: 'base', DESIGN_PR_REF: 'design/MOTIR-1-x', MOTIR_UPLOAD_TOKEN: 'pat' },
      log as never,
      {
        collect: () => ({ assets: [], notes, ignored: [], deleted: [] }),
        extractNote: ({ notePath }: { notePath: string }) =>
          notePath.includes('auth')
            ? { noteMd: '## Auth\n\nbody', reason: 'ok', sections: 1 }
            : { noteMd: null, reason: 'above-first-section', sections: 0 },
        requestOidc: async () => null,
        publish,
      },
    );

    const call = publish.mock.calls[0]![0];
    expect((call.assets as Array<{ sourcePath: string }>).map((a) => a.sourcePath)).toEqual([
      notes[0],
    ]);
    expect(log.lines.join('\n')).toContain(`${notes[1]} changed above the first section`);
  });

  it('omits the note when the PR only touched the surface index table', async () => {
    const log = logger();
    const publish = vi.fn(async (_args: Record<string, unknown>) => ({ id: 'ev-10' }));
    await main(
      { DESIGN_BASE_SHA: 'base', DESIGN_PR_REF: 'design/MOTIR-1-x', MOTIR_UPLOAD_TOKEN: 'pat' },
      log as never,
      {
        collect: () => ({ ...oneMock, notes: ['design/a/design-notes.md'] }),
        extractNote: () => ({ noteMd: null, reason: 'above-first-section', sections: 0 }),
        requestOidc: async () => null,
        publish,
      },
    );

    const call = publish.mock.calls[0]![0];
    expect(call.noteMd).toBeNull();
    expect((call.assets as Array<{ kind: string }>).map((a) => a.kind)).toEqual(['mock']);
    expect(log.lines.join(' ')).toContain('no surface described');
    // PAT fallback, since there is no OIDC identity here.
    expect(call.headers).toEqual({ authorization: 'Bearer pat' });
  });
});
