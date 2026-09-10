import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAtHead } from '../../scripts/renderDesignMockGit.mjs';
import { exportMockBoards } from '../../scripts/renderDesignMockBoards.mjs';

// MOTIR-4895 — `scripts/render-design-mock.mjs` crashed on the SECOND render of
// a NEW asset.
//
// ── The defect ──────────────────────────────────────────────────────────────
// The drift baseline was read with a bare `execFileSync('git', ['show',
// 'HEAD:<path>'])`, and that was reached whenever the `.png` existed ON DISK.
// For a new asset the first render is what puts it there, so:
//
//   NEW  1200  2400x4992  design/…/approval-control.mock.html     # first render, ok
//   fatal: path 'design/…/approval-control.png' exists on disk, but not in 'HEAD'
//   Error: Command failed: git show HEAD:design/…/approval-control.png
//
// — every render after the first, for exactly the assets that have no committed
// baseline to compare against. `--width` did not help; the crash is before the
// width search. The only workaround was to `rm` the artefact just produced.
//
// ── Why these specs use a REAL repository and a FAKE renderer ───────────────
// The two halves are tested where each one lives. The baseline read is about
// what `git` does with an uncommitted path, so stubbing `git` would assert the
// stub — these specs `git init` a temp repository and ask the real thing. The
// RENDER is not what broke, and the runner launches chromium and `process.exit`s
// at top level, so it is faked exactly as `render-design-mock-boards.test.ts`
// fakes it. What is asserted end-to-end is the card's own criterion: render
// twice into a repository without committing, and the second render succeeds.

/**
 * A PNG-shaped buffer. Everything downstream reads only the IHDR width/height at
 * bytes 16 and 20, plus the whole buffer's md5 for the EXACT verdict. (The same
 * helper `render-design-mock-boards.test.ts` uses, for the same reason.)
 */
const png = (width: number, height: number, salt = 0): Buffer => {
  const buffer = Buffer.alloc(25);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(salt, 24);
  return buffer;
};

const MOCK = 'design/work-items/approval-control.mock.html';
const LIGHT_PNG = 'design/work-items/approval-control.png';
const COMMITTED = 'design/work-items/detail.png';

let repo: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'render-design-mock-git-'));
  git('init', '-b', 'main');
  // A committed baseline to prove the read still READS — a guard that answers
  // `null` to everything would satisfy every other spec here.
  mkdirSync(join(repo, 'design/work-items'), { recursive: true });
  writeFileSync(join(repo, COMMITTED), png(2400, 17392));
  git('add', COMMITTED);
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'baseline');
  // And the asset under test: on disk, never committed — the state the first
  // render of a new mock leaves behind.
  writeFileSync(join(repo, MOCK), '<!doctype html><html><body>board</body></html>');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('the HEAD baseline read (MOTIR-4895)', () => {
  it('returns the committed content when HEAD carries the path', () => {
    // The half that must not regress: the drift comparison this script exists
    // for reads its baseline through here.
    const head = readAtHead(COMMITTED, { cwd: repo });
    expect(head).not.toBeNull();
    expect(head!.subarray(16, 24)).toEqual(png(2400, 17392).subarray(16, 24));
  });

  it('returns null — never throws — for a path that exists ON DISK but not in HEAD', () => {
    // THE DEFECT, in one assertion. `writeFileSync` is what the previous render
    // did; `git show` then exits 128 with `exists on disk, but not in 'HEAD'`.
    writeFileSync(join(repo, LIGHT_PNG), png(2400, 4992));
    expect(() => readAtHead(LIGHT_PNG, { cwd: repo })).not.toThrow();
    expect(readAtHead(LIGHT_PNG, { cwd: repo })).toBeNull();
  });

  it('returns null for a path that exists nowhere, and in a repository with no HEAD', () => {
    // The other two ways there is no committed baseline. All three mean the same
    // thing to the caller, so all three answer the same way.
    expect(readAtHead('design/work-items/nothing-here.png', { cwd: repo })).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), 'render-design-mock-git-empty-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: empty, stdio: 'ignore' });
      expect(readAtHead(COMMITTED, { cwd: empty })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('rendering a NEW asset TWICE without committing (MOTIR-4895)', () => {
  /**
   * The runner's own wiring, verbatim: `readCommitted` is the on-disk check plus
   * the HEAD read, and `write` really writes — which is what makes the second
   * pass meet the state the first one created.
   */
  const runOnce = (fresh: string) =>
    exportMockBoards({
      mock: MOCK,
      boards: [{ theme: 'light', png: fresh }],
      shootTarget: (width, _height, scale) => Promise.resolve(png(width * scale, 4992)),
      shootBaseline: () => {
        throw new Error('a NEW asset has no baseline to shoot');
      },
      readCommitted: (path: string) => readAtHead(path, { cwd: repo }),
      write: (path: string, buffer: Buffer) => writeFileSync(join(repo, path), buffer),
      forcedWidth: 1200,
    });

  it('exports on the first pass and AGAIN on the second, with no crash in between', async () => {
    const fresh = 'design/work-items/second-render.png';

    const first = await runOnce(fresh);
    expect(first.written).toEqual([fresh]);
    expect(first.lines[0]).toContain('NEW');
    expect(first.failed).toBe(0);

    // The PNG now exists on disk and still does not exist in HEAD — the exact
    // state that used to throw `status: 128` out of `execFileSync`, before a
    // single pixel had been compared.
    const second = await runOnce(fresh);
    expect(second.written).toEqual([fresh]);
    expect(second.lines[0]).toContain('NEW');
    expect(second.failed).toBe(0);
  });

  it('still reports NEW without --width, rather than crashing', async () => {
    // The other arm of the `NEW` branch: no committed baseline and no asserted
    // viewport is a legible refusal that tells the runner what to pass. Before
    // the guard it never got that far.
    const uncommitted = 'design/work-items/no-width.png';
    writeFileSync(join(repo, uncommitted), png(2400, 4992));
    const result = await exportMockBoards({
      mock: MOCK,
      boards: [{ theme: 'light', png: uncommitted }],
      shootTarget: () => Promise.resolve(png(2400, 4992)),
      shootBaseline: () => {
        throw new Error('a NEW asset has no baseline to shoot');
      },
      readCommitted: (path: string) => readAtHead(path, { cwd: repo }),
      write: () => {
        throw new Error('nothing is written without an asserted viewport');
      },
    });
    expect(result.lines[0]).toContain('pass --width to export it');
    expect(result.failed).toBe(1);
  });
});
