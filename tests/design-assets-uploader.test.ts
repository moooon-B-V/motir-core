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
  parseHunkRanges,
  parseWorkItemKey,
  publishDesignResult,
  isContainerRunRef,
  resolveDiffBase,
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

describe('isContainerRunRef — a container run can never be a publish target (MOTIR-3105)', () => {
  it('recognises both container-run prefixes, current and legacy', () => {
    expect(isContainerRunRef('parent/MOTIR-3000-agent-attachments')).toBe(true);
    expect(isContainerRunRef('story/MOTIR-1703-ci-optimization')).toBe(true);
  });

  it('leaves every branch that CAN name a leaf alone', () => {
    for (const ref of [
      'design/MOTIR-2669-design-result',
      'subtask/MOTIR-2666-design-asset-source',
      'docs/MOTIR-2695-embedding-residency-adr',
      'main',
      '',
      undefined,
    ]) {
      expect(isContainerRunRef(ref), `${ref} must stay publishable`).toBe(false);
    }
  });

  it('does not match a prefix that merely CONTAINS one', () => {
    // `parent` as a slug word, not as the run prefix.
    expect(isContainerRunRef('design/MOTIR-42-parent-panel')).toBe(false);
  });
});

describe('resolveDiffBase — the PR measures from where IT diverged (MOTIR-3104)', () => {
  // ⚠️ THE BUG THIS REPLACES, stated so the test cannot be "simplified" back
  // into it: the job diffed `github.event.pull_request.base.sha` against a
  // MERGE-COMMIT checkout, so every design change the base branch made between
  // the event snapshot and the merge was attributed to the PR. It fired on a
  // story PR touching no design file at all — and on a `subtask/*` branch the
  // same thing does not fail, it publishes ANOTHER card's design onto this one.

  it('prefers the merge commit’s FIRST PARENT — the base it was actually merged with', () => {
    const git = vi.fn(() => 'mergeSha baseTip prHead\n');
    expect(resolveDiffBase({ base: 'eventBase', git, cwd: ROOT })).toEqual({
      base: 'baseTip',
      source: 'merge-parent',
    });
    // Parent 1, never parent 2: parent 2 is the PR head, and diffing HEAD
    // against itself reports nothing at all.
    expect(git).toHaveBeenCalledWith(['rev-list', '--parents', '-n', '1', 'HEAD'], ROOT);
  });

  it('falls back to the merge BASE when HEAD is not a merge commit', () => {
    const git = vi.fn((args: string[]) => {
      if (args[0] === 'rev-list') return 'headSha parentSha\n'; // two fields — not a merge
      if (args[0] === 'merge-base') return 'forkPoint\n';
      return '';
    });
    expect(resolveDiffBase({ base: 'eventBase', git, cwd: ROOT })).toEqual({
      base: 'forkPoint',
      source: 'merge-base',
    });
  });

  it('falls back to the supplied base when there is no shared history to walk', () => {
    // The depth-1 clone this job runs in: the base object is present but its
    // ancestry is not, so `merge-base` has nothing to compute from. Degrading
    // to today's behaviour is right; degrading SILENTLY is what this returns a
    // source for.
    const git = vi.fn((args: string[]) => {
      if (args[0] === 'rev-list') return 'headSha parentSha\n';
      throw new Error('fatal: refusing to work with shallow history');
    });
    expect(resolveDiffBase({ base: 'eventBase', git, cwd: ROOT })).toEqual({
      base: 'eventBase',
      source: 'event-base',
    });
  });

  it('survives an unreadable HEAD rather than taking the whole job down with it', () => {
    const git = vi.fn(() => {
      throw new Error('fatal: bad revision');
    });
    expect(resolveDiffBase({ base: 'eventBase', git, cwd: ROOT }).source).toBe('event-base');
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
      noteResult: { noteMd: '## X\n\nbody', notePath: 'design/a/design-notes.md' },
    });

    expect(out.noteMd).toBe('## X\n\nbody');
    expect(out.assets).toEqual([
      { kind: 'mock', sourcePath: 'design/a/x.mock.html' },
      { kind: 'note_file', sourcePath: 'design/a/design-notes.md' },
    ]);
  });

  it('adds no note_file when the PR changed no section', () => {
    const out = buildPublishSet({
      collected: { assets: [{ kind: 'image', sourcePath: 'design/a/x.png' }] },
      noteResult: null,
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

  it('a CONTAINER-RUN branch publishes nothing and does not fail the build (MOTIR-3105)', async () => {
    const log = logger();
    const publish = vi.fn();
    const requestOidc = vi.fn();
    const code = await main(
      { DESIGN_BASE_SHA: 'base', DESIGN_PR_REF: 'parent/MOTIR-3000-agent-attachments' },
      log as never,
      { collect: () => oneMock, publish, requestOidc },
    );

    expect(code).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    // Skipped BEFORE the credential is even requested — there is nothing this
    // job could do with one.
    expect(requestOidc).not.toHaveBeenCalled();
    const said = log.lines.join(' ');
    expect(said).toContain('names a story');
    // Actionable, not merely quiet: it says where the design belongs instead.
    expect(said).toContain('design/MOTIR-<n>-<slug>');
    expect(said).toContain('mock:design/a/x.mock.html');
  });

  it('a LEAF branch is untouched by that skip — the publish still runs', async () => {
    // The property most at risk from a fix aimed at silencing the container
    // case: a real design branch must still publish, and a real failure must
    // still be able to go red (MOTIR-2499).
    const log = logger();
    const publish = vi.fn(async () => ({ id: 'ev-1' }));
    const code = await main(
      {
        DESIGN_BASE_SHA: 'base',
        DESIGN_PR_REF: 'design/MOTIR-2669-design-result',
        MOTIR_UPLOAD_TOKEN: 'pat',
      },
      log as never,
      { collect: () => oneMock, requestOidc: async () => null, publish },
    );

    expect(code).toBe(0);
    expect(publish).toHaveBeenCalledOnce();
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
