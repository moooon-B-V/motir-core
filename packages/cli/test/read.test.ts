import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseItemKey, parseKinds, parseSprintState, showCommand } from '../src/commands/read.js';
import { openUrl } from '../src/browser.js';
import { setCredential } from '../src/config/userConfig.js';
import { CliError } from '../src/errors.js';
import { DEFAULT_TOOLS, startTestMcpServer, type TestMcpServer } from './helpers/mcpTestServer.js';

describe('parseKinds', () => {
  it('returns undefined for an absent / empty list (any kind)', () => {
    expect(parseKinds(undefined)).toBeUndefined();
    expect(parseKinds('  ,  ')).toBeUndefined();
  });
  it('lower-cases, trims, and accepts the valid kinds', () => {
    expect(parseKinds('Story, BUG ')).toEqual(['story', 'bug']);
  });
  it('throws a guiding CliError on an unknown kind', () => {
    expect(() => parseKinds('story,widget')).toThrow(CliError);
    try {
      parseKinds('widget');
    } catch (err) {
      expect((err as CliError).hint).toMatch(/epic, story, task, bug, subtask/);
    }
  });
});

describe('parseSprintState', () => {
  it('returns undefined for an absent / empty filter (every state)', () => {
    expect(parseSprintState(undefined)).toBeUndefined();
    expect(parseSprintState('   ')).toBeUndefined();
  });
  it('lower-cases, trims, and accepts the three sprint states', () => {
    expect(parseSprintState(' Active ')).toBe('active');
    expect(parseSprintState('PLANNED')).toBe('planned');
    expect(parseSprintState('complete')).toBe('complete');
  });
  it('throws a guiding CliError on an unknown state', () => {
    expect(() => parseSprintState('closed')).toThrow(CliError);
    try {
      parseSprintState('closed');
    } catch (err) {
      expect((err as CliError).hint).toMatch(/planned, active, complete/);
    }
  });
});

describe('openUrl', () => {
  it('skips (resolves false) on a headless Linux box with no display', async () => {
    const launched = await openUrl('https://app.motir.co/issues/PROD-7', {
      platform: 'linux',
      env: {},
    });
    expect(launched).toBe(false);
  });
  it('never rejects even if the launcher is bogus', async () => {
    // darwin path always attempts; spawning a non-existent cmd resolves false
    // via the child 'error' handler rather than throwing.
    await expect(
      openUrl('https://app.motir.co', { platform: 'darwin', env: {} }),
    ).resolves.toBeTypeOf('boolean');
  });
});

// ── coverage gaps closed by 7.9.5 (MOTIR-883) ───────────────────────────────

describe('openUrl per platform', () => {
  it('always attempts on macOS and Windows (no DISPLAY concept there)', async () => {
    // The launcher differs per platform; both resolve a boolean and neither
    // throws, which is the whole contract — the URL is already printed.
    await expect(
      openUrl('https://app.motir.co', { platform: 'win32', env: {} }),
    ).resolves.toBeTypeOf('boolean');
  });

  it('attempts on Linux once a display IS present', async () => {
    await expect(
      openUrl('https://app.motir.co', { platform: 'linux', env: { DISPLAY: ':0' } }),
    ).resolves.toBeTypeOf('boolean');
    await expect(
      openUrl('https://app.motir.co', { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }),
    ).resolves.toBeTypeOf('boolean');
  });
});

// ── `motir show <key>` (7.9.13 · MOTIR-1843) ────────────────────────────────
//
// The command against a REAL MCP server with a scripted `get_work_item`: what
// it asks the server for (one tool call, the normalized key), what it prints,
// and how it fails. The LAYOUT itself is asserted in `render.test.ts`, where the
// renderers are pure — these tests are about the wiring.

describe('parseItemKey', () => {
  it('normalizes a well-formed key to upper case (the server does the same)', () => {
    expect(parseItemKey('  prod-7 ', 'show')).toBe('PROD-7');
    expect(parseItemKey('MOTIR-1843', 'show')).toBe('MOTIR-1843');
  });

  it('rejects an empty or malformed key with a guiding hint, before any call', () => {
    for (const bad of ['', '   ', 'PROD', '7', 'PROD-', '-7', 'PROD 7']) {
      expect(() => parseItemKey(bad, 'show'), bad).toThrow(CliError);
    }
    try {
      parseItemKey('nonsense', 'show');
    } catch (err) {
      expect((err as CliError).message).toContain('is not a work item key');
      expect((err as CliError).hint).toContain('motir show PROD-7');
    }
  });
});

describe('motir show', () => {
  let server: TestMcpServer;
  let cwd: string;
  let root: string;
  const TOKEN = 'pat_show_token';

  /** One `get_work_item` aggregate, as the tool returns it. */
  const detail = {
    item: {
      id: 'row-7',
      identifier: 'PROD-7',
      kind: 'subtask',
      title: 'Read commands',
      status: 'in_progress',
      priority: 'high',
      assigneeId: null,
      type: 'code',
      executor: 'coding_agent',
      storyPoints: 3,
      estimateMinutes: 40,
      targetRepo: null,
      sprintId: null,
      descriptionMd: '## Why\n\nBecause the CLI cannot show you a work item.',
    },
    ancestors: [{ identifier: 'PROD-1', kind: 'epic', title: 'Epic 7', status: 'in_progress' }],
    parent: { identifier: 'PROD-1', kind: 'epic', title: 'Epic 7', status: 'in_progress' },
    children: [{ identifier: 'PROD-8', kind: 'subtask', title: 'A child', status: 'todo' }],
    blockedBy: [
      {
        linkId: 'l1',
        item: { identifier: 'PROD-2', kind: 'subtask', title: 'A blocker', status: 'todo' },
      },
    ],
    blocks: [],
    relatesTo: [],
    readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
  };

  function capture(): () => string {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    return () => chunks.join('');
  }

  beforeAll(async () => {
    cwd = process.cwd();
    server = await startTestMcpServer({
      token: TOKEN,
      tools: { ...DEFAULT_TOOLS, get_work_item: { structured: detail } },
    });
  });

  afterAll(async () => {
    process.chdir(cwd);
    await server.close();
  });

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'motir-show-'));
    const home = join(base, 'config');
    root = join(base, 'workspace');
    mkdirSync(home, { recursive: true });
    mkdirSync(root, { recursive: true });
    vi.stubEnv('MOTIR_CONFIG_HOME', home);
    process.chdir(root);
    setCredential(server.url, { token: TOKEN });
    writeFileSync(
      join(root, '.motir.json'),
      JSON.stringify({ serverUrl: server.url, workspace: 'acme', project: 'PROD' }) + '\n',
    );
    server.calls.length = 0;
    server.script({ get_work_item: { structured: detail } });
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prints header, readiness, lineage, children, every edge group, and the body', async () => {
    const stdout = capture();

    await showCommand('PROD-7', {});
    const printed = stdout();

    expect(printed).toContain('PROD-7  [subtask/code]  Read commands');
    expect(printed).toContain('status in_progress · priority high · type code');
    expect(printed).toContain('READINESS\nready');
    expect(printed).toContain('LINEAGE\nPROD-1 › PROD-7');
    expect(printed).toContain('CHILDREN (1)');
    expect(printed).toContain('PROD-8');
    expect(printed).toContain('BLOCKED BY (1)');
    expect(printed).toContain('PROD-2');
    expect(printed).toContain('BLOCKS (0)');
    expect(printed).toContain('RELATES TO (0)');
    expect(printed).toContain('DESCRIPTION\n## Why');
    // An absent field is absent, not a printed placeholder.
    expect(printed).not.toMatch(/null|undefined/);
  });

  it('reads it with ONE tool call — get_work_item, with the normalized key', async () => {
    capture();

    await showCommand(' prod-7 ', {});

    expect(server.calls).toEqual([{ name: 'get_work_item', args: { key: 'PROD-7' } }]);
  });

  it('--json emits the tool payload UNCHANGED', async () => {
    const stdout = capture();

    await showCommand('PROD-7', { json: true });

    expect(JSON.parse(stdout())).toEqual(detail);
  });

  it('surfaces the SERVER’s own message for an unknown / cross-tenant key', async () => {
    capture();
    // What the tool returns for a key in a project the caller cannot browse:
    // 404-not-403, so the CLI leaks nothing the server would not.
    server.script({ get_work_item: { error: 'NOT_FOUND: Work item PROD-999 not found.' } });

    await expect(showCommand('PROD-999', {})).rejects.toMatchObject({
      message: expect.stringContaining('NOT_FOUND: Work item PROD-999 not found.'),
      exitCode: 1,
    });
  });

  it('rejects a malformed key BEFORE it opens a session', async () => {
    capture();

    await expect(showCommand('not-a-key!', {})).rejects.toThrow(CliError);
    expect(server.calls).toHaveLength(0);
  });
});
