import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_SUBDIR,
  MOTIR_DESIGN_DIR_ENV,
  isSafeSourcePath,
  materializeDesignsFor,
  type DesignsResponse,
} from '../src/designFiles.js';
import { runAgent } from '../src/agentRun.js';

// PUTTING THE APPROVED DESIGN ON DISK (Story MOTIR-5553 · Subtask MOTIR-5562).
//
// Every seam is injected — the read, the downloader, the filesystem, the spawn —
// because the behaviours that matter here are the FAILURE ones, and a test that
// needs a real object store to reach them is a test nobody runs.

const APPROVED = (assets: Array<{ sourcePath: string; state?: string; url?: string }>) => ({
  verdict: 'approved',
  designCardKey: 'PROD-7',
  design: {
    assets: assets.map((a) => ({
      sourcePath: a.sourcePath,
      state: a.state ?? 'available',
      ...(a.url === undefined ? { url: `https://store.example/${a.sourcePath}` } : { url: a.url }),
    })),
  },
});

/** A recording filesystem — what was made, what was written, what was removed. */
function recordingFs() {
  const writes = new Map<string, Buffer>();
  const dirs: string[] = [];
  const removed: string[] = [];
  return {
    writes,
    dirs,
    removed,
    fs: {
      mkdir: (path: string) => void dirs.push(path),
      writeFile: (path: string, bytes: Buffer) => void writes.set(path, bytes),
      remove: (path: string) => void removed.push(path),
    },
  };
}

describe('isSafeSourcePath', () => {
  it('accepts an ordinary repository path', () => {
    expect(isSafeSourcePath('design/work-items/detail.mock.html')).toBe(true);
    expect(isSafeSourcePath('design-notes.md')).toBe(true);
  });

  it('refuses anything that could escape the run directory', () => {
    for (const bad of [
      '/etc/passwd',
      '../../.ssh/id_rsa',
      'design/../../outside.html',
      'design/..',
      '',
      'C:\\Windows\\system32',
      '\\\\server\\share',
      'design//double.html',
    ]) {
      expect(isSafeSourcePath(bad), bad).toBe(false);
    }
  });
});

describe('materializeDesignsFor', () => {
  it('writes every approved design under `<designCardKey>/<sourcePath>` and succeeds', async () => {
    const { writes, fs } = recordingFs();
    const body: DesignsResponse = {
      designs: [
        APPROVED([{ sourcePath: 'design/frame/a.mock.html' }]),
        {
          verdict: 'approved',
          designCardKey: 'PROD-9',
          design: {
            assets: [
              {
                sourcePath: 'design/frame/design-notes.md',
                state: 'available',
                url: 'https://store.example/notes',
              },
            ],
          },
        },
      ],
    };
    const fetched: string[] = [];
    const ok = await materializeDesignsFor('PROD-1', {
      readDesigns: async () => body,
      fetchAsset: async (url) => {
        fetched.push(url);
        return new TextEncoder().encode(`bytes:${url}`).buffer as ArrayBuffer;
      },
      fs,
      warn: () => {
        throw new Error('must not warn on the happy path');
      },
    })('/run/design');

    expect(ok).toBe(true);
    expect([...writes.keys()].sort()).toEqual(
      [
        '/run/design/PROD-7/design/frame/a.mock.html',
        '/run/design/PROD-9/design/frame/design-notes.md',
      ].sort(),
    );
    // Byte-for-byte — the agent greps these files, so a transformed copy is a
    // different design.
    expect(writes.get('/run/design/PROD-9/design/frame/design-notes.md')!.toString()).toBe(
      'bytes:https://store.example/notes',
    );
    expect(fetched).toHaveLength(2);
  });

  it('skips an UNAVAILABLE asset without failing the rest', async () => {
    const { writes, fs } = recordingFs();
    const ok = await materializeDesignsFor('PROD-1', {
      readDesigns: async () => ({
        designs: [
          APPROVED([
            { sourcePath: 'design/frame/a.mock.html' },
            { sourcePath: 'design/frame/gone.mock.html', state: 'unavailable', url: undefined },
          ]),
        ],
      }),
      fetchAsset: async () => new ArrayBuffer(4),
      fs,
    })('/run/design');

    // An approved version whose bytes were reclaimed is a real state, not an
    // error — the run still gets the files that DO exist.
    expect(ok).toBe(true);
    expect([...writes.keys()]).toEqual(['/run/design/PROD-7/design/frame/a.mock.html']);
  });

  it('a failed download leaves NO directory, no success and ONE warning', async () => {
    const { writes, removed, fs } = recordingFs();
    const warnings: string[] = [];
    const ok = await materializeDesignsFor('PROD-1', {
      readDesigns: async () => ({
        designs: [
          APPROVED([
            { sourcePath: 'design/frame/a.mock.html' },
            { sourcePath: 'design/frame/b.mock.html' },
          ]),
        ],
      }),
      fetchAsset: async (url) => {
        if (url.endsWith('b.mock.html')) throw new Error('the object store answered 403');
        return new ArrayBuffer(4);
      },
      fs,
      warn: (m) => void warnings.push(m),
    })('/run/design');

    expect(ok).toBe(false);
    // ALL OR NOTHING: the one file that DID land is removed with the directory.
    expect(removed).toEqual(['/run/design']);
    expect(writes.size).toBe(1); // written, then the whole root removed
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('403');
    expect(warnings[0]).toContain('fetch the design itself');
  });

  it('a failed READ warns and continues, without touching the filesystem', async () => {
    const { writes, dirs, removed, fs } = recordingFs();
    const warnings: string[] = [];
    const ok = await materializeDesignsFor('PROD-1', {
      readDesigns: async () => {
        throw new Error('network down');
      },
      fetchAsset: async () => new ArrayBuffer(0),
      fs,
      warn: (m) => void warnings.push(m),
    })('/run/design');

    expect(ok).toBe(false);
    expect(writes.size).toBe(0);
    expect(dirs).toEqual([]);
    expect(removed).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('an UNSAFE sourcePath is refused BEFORE any write', async () => {
    const { writes, dirs, fs } = recordingFs();
    const warnings: string[] = [];
    let fetches = 0;
    const ok = await materializeDesignsFor('PROD-1', {
      readDesigns: async () => ({
        designs: [
          APPROVED([
            { sourcePath: 'design/frame/a.mock.html' },
            { sourcePath: '../../escape.html' },
          ]),
        ],
      }),
      fetchAsset: async () => {
        fetches += 1;
        return new ArrayBuffer(4);
      },
      fs,
      warn: (m) => void warnings.push(m),
    })('/run/design');

    expect(ok).toBe(false);
    // Nothing was fetched and nothing was written — the batch is refused whole,
    // so there is no partial directory to clean up.
    expect(fetches).toBe(0);
    expect(writes.size).toBe(0);
    expect(dirs).toEqual([]);
    expect(warnings[0]).toContain('escape the run directory');
  });

  it('NO approved verdicts means no directory, no variable and NO warning', async () => {
    const { writes, dirs, fs } = recordingFs();
    const ok = await materializeDesignsFor('PROD-1', {
      readDesigns: async () => ({
        designs: [
          { verdict: 'not_approved', designCardKey: 'PROD-7' },
          { verdict: 'not_approved', designCardKey: 'PROD-8' },
        ],
      }),
      fetchAsset: async () => new ArrayBuffer(0),
      fs,
      // Nothing went wrong, so warning here would train an operator to ignore
      // the line that matters.
      warn: () => {
        throw new Error('must not warn when there is simply no design');
      },
    })('/run/design');

    expect(ok).toBe(false);
    expect(writes.size).toBe(0);
    expect(dirs).toEqual([]);
  });
});

describe('runAgent hands the child `$MOTIR_DESIGN_DIR` — and only on success', () => {
  function fakeSpawn(captured: { env?: NodeJS.ProcessEnv }) {
    return (_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      captured.env = opts.env;
      const child = {
        stdin: { write: () => {}, end: () => {} },
        stdout: null,
        stderr: null,
        on: (event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'close') setTimeout(() => cb(0, null), 0);
          return child;
        },
      };
      return child as never;
    };
  }

  it('sets it when the materializer succeeds, pointing INTO the run directory', async () => {
    const captured: { env?: NodeJS.ProcessEnv } = {};
    // A REAL directory: `runAgent` writes `prompt.md` into it before it spawns,
    // so a fictional path fails the run before the assertion can see an env.
    const tempDir = mkdtempSync(join(tmpdir(), 'motir-design-test-'));
    await runAgent({
      command: { command: 'agent', binary: 'agent', args: [] },
      prompt: 'p',
      cwd: '/repo',
      tempDirFactory: () => tempDir,
      materializeDesigns: async () => true,
      spawnFn: fakeSpawn(captured),
    }).catch(() => undefined);

    expect(captured.env?.[MOTIR_DESIGN_DIR_ENV]).toBe(join(tempDir, DESIGN_SUBDIR));
  });

  it('leaves it UNSET when the materializer fails — and when it THROWS', async () => {
    for (const materializeDesigns of [
      async () => false,
      async () => {
        throw new Error('anything at all');
      },
    ]) {
      const captured: { env?: NodeJS.ProcessEnv } = {};
      await runAgent({
        command: { command: 'agent', binary: 'agent', args: [] },
        prompt: 'p',
        cwd: '/repo',
        tempDirFactory: () => mkdtempSync(join(tmpdir(), 'motir-design-test-')),
        materializeDesigns,
        spawnFn: fakeSpawn(captured),
      }).catch(() => undefined);

      // An unset variable is what sends the agent to the prompt's fetch
      // instruction. Setting it over a missing directory is the one lie here.
      expect(captured.env?.[MOTIR_DESIGN_DIR_ENV]).toBeUndefined();
      // …and the run still happened.
      expect(captured.env?.MOTIR_PROMPT_FILE).toBeDefined();
    }
  });

  it('leaves it unset when no materializer is supplied at all (`--print`, a bare run)', async () => {
    const captured: { env?: NodeJS.ProcessEnv } = {};
    await runAgent({
      command: { command: 'agent', binary: 'agent', args: [] },
      prompt: 'p',
      cwd: '/repo',
      tempDirFactory: () => mkdtempSync(join(tmpdir(), 'motir-design-test-')),
      spawnFn: fakeSpawn(captured),
    }).catch(() => undefined);
    expect(captured.env?.[MOTIR_DESIGN_DIR_ENV]).toBeUndefined();
  });
});

describe('the variable name cannot drift from the prompt', () => {
  it('is exported from ONE constant, whose value the prompt is pinned against', () => {
    // Two files, two audiences: the CLI SETS this variable and the
    // server-assembled prompt TELLS the agent to read it. A drift between them
    // makes the prompt name a variable nothing sets, which reads to the agent
    // as "there is no design" — the failure with no error message.
    //
    // ⚠️ THE EQUALITY IS PINNED ON THE SERVER SIDE (MOTIR-5563's
    // `designReference` suite), because that is the only place BOTH values are
    // reachable: this package cannot import the app's `lib/`, and the prompt
    // template cannot import a CLI module. What this file pins is the other
    // half — that the CLI has exactly one constant to pin AGAINST, so the
    // server's assertion is about a single source rather than a literal
    // repeated at each use.
    expect(MOTIR_DESIGN_DIR_ENV).toBe('MOTIR_DESIGN_DIR');
  });
});
