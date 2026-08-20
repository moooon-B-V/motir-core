import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  attributeChangedPaths,
  authHeadersFor,
  buildPublishSet,
  classifyDesignPath,
  collectChangedDesignFiles,
  contentTypeFor,
  extractChangedNoteSections,
  main,
  NotAChildError,
  NotALeafError,
  parseCommitCardKey,
  parseHunkRanges,
  parseWorkItemKey,
  partitionAssetsByCard,
  projectPrefixOf,
  publishDesignResult,
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

// ⚠️ SINCE MOTIR-3213 A PUBLISH REQUIRES A TRUSTED DIFF BASE, so every `main`
// test that expects a publish must supply one. These tests pass a
// `DESIGN_BASE_SHA` that is not a real revision, so the default resolver walks
// all three rungs and lands on `event-base` — from which `main` now refuses to
// publish, correctly. Declaring the base is also the honest thing: what these
// tests are about is the note loop and the publish call, not base resolution.
const TRUSTED_BASE = ({ base }: { base: string }) => ({ base, source: 'merge-parent' as const });

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

describe('resolveDiffBase in a REAL depth-1 clone (MOTIR-3213)', () => {
  // ⚠️ WHY THIS SPEC BUILDS REPOSITORIES INSTEAD OF INJECTING A `git` MOCK, and
  // why the neighbouring describe's mocks are not enough. MOTIR-3104's rung 1
  // reads HEAD's parent list and was documented as "safe in the depth-1 clone
  // this job runs in", because reading a commit's own parents needs no ancestry
  // walk. That is true of git and false of a SHALLOW git: a shallow clone GRAFTS
  // its boundary commits, and a grafted commit reports NO parents at all. So
  // `rev-list --parents -n 1 HEAD` returns one field where a full clone returns
  // three, rung 1 could not fire in the only environment it existed for, and
  // every `pull_request` run fell through to the `event-base` behaviour the fix
  // replaced — publishing another card's design under a green check.
  //
  // A mocked `git` cannot tell the two apart, because the mock is where the
  // three fields come from. Neither can a test run in this repository's own
  // checkout, which is not shallow. The only assertion that distinguishes an
  // inert rung from a working one is one made against a real shallow clone, so
  // that is what these build.

  const TMP: string[] = [];

  afterAll(() => {
    for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
  });

  /** Run git in `cwd`, with an identity so a bare CI runner can commit. */
  const g = (args: string[], cwd: string) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8' },
    );

  /**
   * The exact shape a `pull_request` run sees, built for real:
   *
   *   c0 ─────────────── other card's design ─── M   ← main, and HEAD
   *    └── this PR's commit ──────────────────────┘
   *
   * `eventBase` is c0 — `github.event.pull_request.base.sha`, the base tip when
   * the event was snapshotted, i.e. BEFORE the other card's design merged. HEAD
   * is GitHub's merge commit M, whose first parent already contains that design.
   * So a diff from `eventBase` reports the other card's files as this PR's, and
   * a diff from parent 1 reports only what this branch did — which is the whole
   * distinction, and it is invisible until the clone is shallow.
   *
   * Returns the SHALLOW clone, fetched exactly as `ci.yml`'s step fetches.
   */
  function shallowPullRequestFixture({ branchTouchesDesign }: { branchTouchesDesign: boolean }) {
    const root = mkdtempSync(join(tmpdir(), 'design-shallow-'));
    TMP.push(root);
    const src = join(root, 'src');
    mkdirSync(join(src, 'design/work-items'), { recursive: true });
    g(['init', '-q', '-b', 'main', '.'], src);
    writeFileSync(join(src, 'design/work-items/design-notes.md'), '## Detail\n\nthe card page\n');
    g(['add', '-A'], src);
    g(['commit', '-qm', 'c0'], src);
    const eventBase = g(['rev-parse', 'HEAD'], src).trim();

    g(['checkout', '-q', '-b', 'feat'], src);
    if (branchTouchesDesign) {
      writeFileSync(join(src, 'design/work-items/detail.mock.html'), '<main>mine</main>\n');
    } else {
      writeFileSync(join(src, 'app.ts'), 'export const x = 1;\n');
    }
    g(['add', '-A'], src);
    g(['commit', '-qm', 'this PR'], src);
    const prHead = g(['rev-parse', 'HEAD'], src).trim();

    // The base branch moves on: ANOTHER card's design merges to `main`.
    g(['checkout', '-q', 'main'], src);
    mkdirSync(join(src, 'design/ai-chat'), { recursive: true });
    writeFileSync(join(src, 'design/ai-chat/design-notes.md'), '## Callout\n\nthe orb\n');
    writeFileSync(join(src, 'design/ai-chat/ai-callout-menu.png'), 'png-bytes');
    g(['add', '-A'], src);
    g(['commit', '-qm', "another card's design"], src);
    const parent1 = g(['rev-parse', 'HEAD'], src).trim();

    g(['merge', '-q', '--no-ff', prHead, '-m', 'Merge pull request'], src);

    const clone = join(root, 'clone');
    execFileSync('git', ['clone', '-q', '--depth=1', `file://${src}`, clone], { encoding: 'utf8' });
    // `ci.yml` fetches the base OBJECT and nothing else — the fetch this whole
    // defect hides behind, reproduced rather than described.
    g(['fetch', '-q', '--depth=1', 'origin', eventBase], clone);
    return { clone, eventBase, parent1 };
  }

  it('is genuinely shallow, and the graft HIDES the parents rung 1 reads', () => {
    const { clone } = shallowPullRequestFixture({ branchTouchesDesign: false });

    // The precondition, asserted rather than assumed — without it the test below
    // would pass just as well in a full clone and prove nothing.
    expect(g(['rev-parse', '--is-shallow-repository'], clone).trim()).toBe('true');
    expect(g(['rev-list', '--parents', '-n', '1', 'HEAD'], clone).trim().split(/\s+/)).toHaveLength(
      1,
    );
  });

  it('reaches rung 1 anyway — it buys the parents it needs and returns merge-parent', () => {
    const { clone, eventBase, parent1 } = shallowPullRequestFixture({ branchTouchesDesign: false });

    expect(resolveDiffBase({ base: eventBase, cwd: clone })).toEqual({
      base: parent1,
      source: 'merge-parent',
    });
  });

  it('END TO END: a PR that changed no file under design/** publishes NOTHING', async () => {
    // AC3, and the property this card's own reporting branch violated: the run
    // that filed MOTIR-3213 was a pure `/api/v1` card whose diff touched zero
    // `design/**` files, and it published three of MOTIR-3183's artifacts.
    const { clone, eventBase } = shallowPullRequestFixture({ branchTouchesDesign: false });
    const log = { lines: [] as string[], log: (m: string) => log.lines.push(m) };
    const publish = vi.fn();

    const code = await main(
      {
        DESIGN_BASE_SHA: eventBase,
        DESIGN_PR_REF: 'subtask/MOTIR-3049-scope-claim',
        MOTIR_UPLOAD_TOKEN: 'pat',
      },
      log as never,
      {
        resolveBase: (a: { base: string }) => resolveDiffBase({ ...a, cwd: clone }),
        collect: (a: { base: string }) => collectChangedDesignFiles({ ...a, cwd: clone }),
        extractNote: (a: { notePath: string; base: string }) =>
          extractChangedNoteSections({ ...a, cwd: clone }),
        publish,
      },
    );

    expect(code).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(log.lines.join(' ')).toContain('Nothing to publish');
  });

  it('END TO END: a PR that DID change a design file publishes that file and not the base branch’s', async () => {
    // The other direction, so the fix cannot be "publish nothing, ever". The
    // base branch's `design/ai-chat/**` moved in the same window and must not
    // appear; the branch's own mock must.
    const { clone, eventBase } = shallowPullRequestFixture({ branchTouchesDesign: true });
    const log = { lines: [] as string[], log: (m: string) => log.lines.push(m) };
    const publish = vi.fn(async (_args: Record<string, unknown>) => ({ id: 'ev-3213' }));

    const code = await main(
      {
        DESIGN_BASE_SHA: eventBase,
        DESIGN_PR_REF: 'design/MOTIR-2669-panel',
        MOTIR_UPLOAD_TOKEN: 'pat',
      },
      log as never,
      {
        resolveBase: (a: { base: string }) => resolveDiffBase({ ...a, cwd: clone }),
        collect: (a: { base: string }) => collectChangedDesignFiles({ ...a, cwd: clone }),
        extractNote: (a: { notePath: string; base: string }) =>
          extractChangedNoteSections({ ...a, cwd: clone }),
        publish,
      },
    );

    expect(code).toBe(0);
    const call = publish.mock.calls[0]![0] as unknown as {
      assets: Array<{ sourcePath: string }>;
    };
    expect(call.assets.map((a) => a.sourcePath)).toEqual(['design/work-items/detail.mock.html']);
  });

  it('an UNTRUSTED base publishes nothing and goes RED, naming what it refused', async () => {
    // AC2. Before this the run WARNED and published anyway, which is how a real
    // evidence id landed on a stranger's card under a green check. The assets
    // here are the base branch's — exactly what the old path would have sent.
    const { clone, eventBase } = shallowPullRequestFixture({ branchTouchesDesign: false });
    const log = { lines: [] as string[], log: (m: string) => log.lines.push(m) };
    const publish = vi.fn();

    const code = await main(
      {
        DESIGN_BASE_SHA: eventBase,
        DESIGN_PR_REF: 'subtask/MOTIR-3049-scope-claim',
        MOTIR_UPLOAD_TOKEN: 'pat',
      },
      log as never,
      {
        // The deepen failing is the one way `event-base` is still reachable —
        // no reachable remote, or a server that will not serve the parents.
        resolveBase: ({ base }: { base: string }) => ({ base, source: 'event-base' }),
        collect: (a: { base: string }) => collectChangedDesignFiles({ ...a, cwd: clone }),
        extractNote: (a: { notePath: string; base: string }) =>
          extractChangedNoteSections({ ...a, cwd: clone }),
        publish,
      },
    );

    expect(code).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    const said = log.lines.join('\n');
    expect(said).toContain('Refusing to publish from an untrusted diff base');
    // It names the card it would have written to and the bytes it would have
    // sent — the operator should not have to re-run anything to see the damage
    // that did not happen.
    expect(said).toContain('MOTIR-3049');
    expect(said).toContain('design/ai-chat/ai-callout-menu.png');
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

  /** No commit on the branch claims any path — the MOTIR-3009 decline. */
  const emptyAttribution = { byPath: new Map<string, string>(), coTouched: new Map() };

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

  it('a CONTAINER whose branch NO commit explains publishes nothing and stays GREEN', async () => {
    // MOTIR-3009. A parent run opens ONE pull request per repository, on
    // `parent/MOTIR-<story>-…`, and it carries the design child's asset
    // amendments alongside the code they document. The service refuses a design
    // result addressed to a story, correctly — a result attaches to the leaf
    // that produced it — and before this the refusal red-lit the whole run,
    // whose only remedy would have been deleting a correct amendment.
    //
    // MOTIR-3177 kept this exit for exactly the case it was written for and no
    // wider: the assets reach no card only when NO commit on the branch claims
    // them. A container with producing children takes the test below.
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
      {
        collect: () => oneMock,
        publish,
        attribute: () => emptyAttribution,
        resolveBase: TRUSTED_BASE,
      },
    );

    expect(code).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
    const said = log.lines.join(' ');
    expect(said).toContain('CONTAINER');
    // Same courtesy as the unresolvable-target exit: say what was skipped.
    expect(said).toContain('mock:design/a/x.mock.html');
  });

  it('a CONTAINER whose CHILDREN produced the assets publishes to each child, never the container', async () => {
    // MOTIR-3177, the whole card. A parent run lands one commit per child on the
    // container's branch and opens no per-child pull request, so "the design
    // child's own pull request publishes them" describes a pull request that
    // does not exist — and 235 assets belonging to six design cards reached no
    // card at all. The branch names the container; the COMMITS name the cards.
    const log = logger();
    const publish = vi.fn(async (args: Record<string, unknown>) =>
      args.targetKey === 'MOTIR-2999'
        ? Promise.reject(new NotALeafError('MOTIR-2999', 'DESIGN_EVIDENCE_NOT_A_LEAF'))
        : { id: `ev-${String(args.targetKey).slice(-2)}` },
    );
    const code = await main(
      {
        DESIGN_BASE_SHA: 'base',
        DESIGN_PR_REF: 'parent/MOTIR-2999-faint-ink',
        MOTIR_UPLOAD_TOKEN: 'pat',
      },
      log as never,
      {
        collect: () => ({
          assets: [
            { kind: 'mock', sourcePath: 'design/a/x.mock.html' },
            { kind: 'image', sourcePath: 'design/a/x.png' },
            { kind: 'mock', sourcePath: 'design/b/y.mock.html' },
          ],
          notes: [],
          ignored: [],
          deleted: [],
        }),
        publish,
        resolveBase: TRUSTED_BASE,
        attribute: () => ({
          byPath: new Map([
            ['design/a/x.mock.html', 'MOTIR-11'],
            ['design/a/x.png', 'MOTIR-11'],
            ['design/b/y.mock.html', 'MOTIR-12'],
          ]),
          coTouched: new Map(),
        }),
      },
    );

    expect(code).toBe(0);
    // One container attempt (refused), then one publish per producing child.
    expect(publish).toHaveBeenCalledTimes(3);
    const targets = publish.mock.calls.map((c) => (c[0] as Record<string, unknown>).targetKey);
    expect(targets).toEqual(['MOTIR-2999', 'MOTIR-11', 'MOTIR-12']);
    // The container is declared on each child publish so the tenant can refuse a
    // key a commit subject mistyped — the one thing git cannot check.
    for (const call of publish.mock.calls.slice(1)) {
      expect((call[0] as Record<string, unknown>).withinParentKey).toBe('MOTIR-2999');
      expect((call[0] as Record<string, unknown>).producedByKey).toEqual(
        (call[0] as Record<string, unknown>).targetKey,
      );
    }
    const said = log.lines.join(' ');
    // AC5: the per-card count is what `CLAUDE.md`'s "confirm the result arrived"
    // check reads, and on a parent run there is one line per card to read.
    expect(said).toContain('Published 2 design artifact(s) to MOTIR-11');
    expect(said).toContain('Published 1 design artifact(s) to MOTIR-12');
  });

  it("splits each card's OWN note sections, and reports a path no commit claims", async () => {
    const log = logger();
    const publish = vi.fn(async (args: Record<string, unknown>) =>
      args.targetKey === 'CONT-1'
        ? Promise.reject(new NotALeafError('CONT-1', 'DESIGN_EVIDENCE_NOT_A_LEAF'))
        : { id: 'ev-1' },
    );
    await main(
      { DESIGN_BASE_SHA: 'base', DESIGN_PR_REF: 'parent/CONT-1-x', MOTIR_UPLOAD_TOKEN: 'pat' },
      log as never,
      {
        collect: () => ({
          assets: [
            { kind: 'mock', sourcePath: 'design/a/x.mock.html' },
            { kind: 'mock', sourcePath: 'design/orphan/z.mock.html' },
          ],
          notes: ['design/a/design-notes.md'],
          ignored: [],
          deleted: [],
        }),
        extractNote: () => ({ noteMd: '## A\nbody', reason: 'ok', sections: 1 }),
        publish,
        resolveBase: TRUSTED_BASE,
        attribute: () => ({
          byPath: new Map([
            ['design/a/x.mock.html', 'CONT-9'],
            ['design/a/design-notes.md', 'CONT-9'],
          ]),
          coTouched: new Map([['design/a/x.mock.html', ['CONT-8']]]),
        }),
      },
    );

    const child = publish.mock.calls[1]![0] as Record<string, unknown>;
    // The card's inline note is ITS note_file's own text, not the run-wide
    // concatenation `buildPublishSet` hands the single-card path.
    expect(child.noteMd).toBe('## A\nbody');
    expect((child.assets as Array<{ sourcePath: string }>).map((a) => a.sourcePath)).toEqual([
      'design/a/x.mock.html',
      'design/a/design-notes.md',
    ]);
    const said = log.lines.join(' ');
    // AC2: never silently dropped.
    expect(said).toContain('design/orphan/z.mock.html');
    expect(said).toContain('reach NO card');
    // A shared path is stated, not duplicated and not hidden.
    expect(said).toContain('also touched by CONT-8');
  });

  it('a mistyped commit key is REFUSED by the tenant, named, and leaves the run green', async () => {
    // The real fixture: a commit on `parent/MOTIR-3068-…` subject-tagged
    // `(MOTIR-3147)` — a manual billing task in another epic. It is a leaf, so
    // nothing local can tell it apart from a real child; only the tree can.
    const log = logger();
    const publish = vi.fn(async (args: Record<string, unknown>) =>
      args.targetKey === 'MOTIR-3068'
        ? Promise.reject(new NotALeafError('MOTIR-3068', 'DESIGN_EVIDENCE_NOT_A_LEAF'))
        : Promise.reject(
            new NotAChildError('MOTIR-3147', 'MOTIR-3068', 'DESIGN_EVIDENCE_NOT_A_CHILD'),
          ),
    );
    const code = await main(
      {
        DESIGN_BASE_SHA: 'base',
        DESIGN_PR_REF: 'parent/MOTIR-3068-ink',
        MOTIR_UPLOAD_TOKEN: 'pat',
      },
      log as never,
      {
        collect: () => oneMock,
        publish,
        resolveBase: TRUSTED_BASE,
        attribute: () => ({
          byPath: new Map([['design/a/x.mock.html', 'MOTIR-3147']]),
          coTouched: new Map(),
        }),
      },
    );

    expect(code).toBe(0);
    const said = log.lines.join(' ');
    expect(said).toContain('MOTIR-3147 is not a child of MOTIR-3068');
    expect(said).toContain('design/a/x.mock.html');
  });

  it('history the checkout never fetched is REPORTED, not read as "nothing to publish"', async () => {
    const log = logger();
    const publish = vi.fn(async () => {
      throw new NotALeafError('MOTIR-2999', 'DESIGN_EVIDENCE_NOT_A_LEAF');
    });
    const code = await main(
      { DESIGN_BASE_SHA: 'base', DESIGN_PR_REF: 'parent/MOTIR-2999-x', MOTIR_UPLOAD_TOKEN: 'pat' },
      log as never,
      {
        collect: () => oneMock,
        publish,
        resolveBase: TRUSTED_BASE,
        attribute: () => {
          throw new Error("fatal: bad revision 'base..HEAD'");
        },
      },
    );

    expect(code).toBe(0);
    expect(log.lines.join(' ')).toContain('Could not read base..HEAD');
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
        { collect: () => oneMock, publish, resolveBase: TRUSTED_BASE },
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
        resolveBase: TRUSTED_BASE,
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
        resolveBase: TRUSTED_BASE,
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
        resolveBase: TRUSTED_BASE,
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
        resolveBase: TRUSTED_BASE,
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

describe('attributeChangedPaths / partitionAssetsByCard (MOTIR-3177)', () => {
  // `git log --no-merges --name-only --format=%x00%H %s` output: a NUL-led
  // record per commit, newest first, header then the paths it touched.
  const record = (sha: string, subject: string, paths: string[]) =>
    `\0${sha} ${subject}\n\n${paths.join('\n')}\n`;

  it('gives each path to the newest commit that NAMES a card', () => {
    const git = vi.fn(
      (_args: string[]) =>
        record('c3', 'fix(design): sweep the AI surfaces (MOTIR-3118)', ['design/ai/a.mock.html']) +
        record('c2', 'fix(design): re-export the merged mock', ['design/plans/p.png']) +
        record('c1', 'fix(design): sweep the planning surfaces (MOTIR-3115)', [
          'design/plans/p.png',
          'design/plans/p.mock.html',
        ]),
    );
    const { byPath, coTouched } = attributeChangedPaths({
      base: 'base',
      containerKey: 'MOTIR-3068',
      git: git as never,
    });

    expect(byPath.get('design/ai/a.mock.html')).toBe('MOTIR-3118');
    // The unkeyed re-export commit explains nothing, so the path falls through
    // to the sweep that produced it rather than becoming unattributable.
    expect(byPath.get('design/plans/p.png')).toBe('MOTIR-3115');
    expect(byPath.get('design/plans/p.mock.html')).toBe('MOTIR-3115');
    expect([...coTouched.keys()]).toEqual([]);
    // Merges are excluded: `git merge origin/main` on a resuming parent run
    // carries ANOTHER card's design changes, and attributing those here is
    // exactly the "published onto the wrong card" outcome.
    expect(git.mock.calls[0]![0]).toContain('--no-merges');
  });

  it('reports a CO-TOUCH rather than duplicating or hiding it', () => {
    const git = () =>
      record('c2', 'docs(design): reconcile the notes (MOTIR-3142)', ['design/a/design-notes.md']) +
      record('c1', 'fix(design): sweep design/a (MOTIR-3113)', ['design/a/design-notes.md']);
    const { byPath, coTouched } = attributeChangedPaths({
      base: 'base',
      containerKey: 'MOTIR-3068',
      git: git as never,
    });

    // HEAD's bytes are the newest commit's, so that is the card the published
    // asset is a true statement about.
    expect(byPath.get('design/a/design-notes.md')).toBe('MOTIR-3142');
    expect(coTouched.get('design/a/design-notes.md')).toEqual(['MOTIR-3113']);
  });

  it('ignores a commit naming the CONTAINER itself, and one naming nothing', () => {
    const git = () =>
      record('c2', 'chore: tidy up', ['design/a/x.png']) +
      record('c1', 'docs: the container itself (MOTIR-3068)', ['design/a/x.png']);
    const { byPath } = attributeChangedPaths({
      base: 'base',
      containerKey: 'motir-3068',
      git: git as never,
    });

    expect(byPath.size).toBe(0);
  });

  it('reads the key only within the CONTAINER’s own project prefix', () => {
    expect(projectPrefixOf('MOTIR-3068')).toBe('MOTIR');
    expect(parseCommitCardKey('fix(design): sweep (MOTIR-3113)', 'MOTIR')).toBe('MOTIR-3113');
    // `parseWorkItemKey` is prefix-agnostic because a branch ref is written for
    // it; a commit subject is prose, and prose contains things like this.
    expect(parseWorkItemKey('refactor(auth): drop the UTF-8 fallback')).toBe('UTF-8');
    expect(parseCommitCardKey('refactor(auth): drop the UTF-8 fallback', 'MOTIR')).toBeNull();
    expect(parseCommitCardKey('fix(x): ACME-4 elsewhere', 'MOTIR')).toBeNull();
  });

  it('gives each card ONLY its own note text, and names what nothing claims', () => {
    const { byCard, unattributed } = partitionAssetsByCard({
      assets: [
        { kind: 'mock', sourcePath: 'design/a/x.mock.html' },
        { kind: 'note_file', sourcePath: 'design/a/design-notes.md', text: '## A' },
        { kind: 'note_file', sourcePath: 'design/b/design-notes.md', text: '## B' },
        { kind: 'image', sourcePath: 'design/c/orphan.png' },
      ],
      byPath: new Map([
        ['design/a/x.mock.html', 'MOTIR-11'],
        ['design/a/design-notes.md', 'MOTIR-11'],
        ['design/b/design-notes.md', 'MOTIR-12'],
      ]),
    });

    expect(byCard.map((c) => c.key)).toEqual(['MOTIR-11', 'MOTIR-12']);
    expect(byCard[0]!.noteMd).toBe('## A');
    expect(byCard[1]!.noteMd).toBe('## B');
    expect(unattributed).toEqual(['design/c/orphan.png']);
  });

  it('a card with no note at all carries a null noteMd, not an empty string', () => {
    const { byCard } = partitionAssetsByCard({
      assets: [{ kind: 'mock', sourcePath: 'design/a/x.mock.html' }],
      byPath: new Map([['design/a/x.mock.html', 'MOTIR-11']]),
    });
    expect(byCard[0]!.noteMd).toBeNull();
  });
});
