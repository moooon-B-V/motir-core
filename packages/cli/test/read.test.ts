import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseItemKey,
  parseKinds,
  parseSprintState,
  readyCommand,
  showCommand,
  sprintCommand,
} from '../src/commands/read.js';
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

  // ── the build-order WAVE view (7.9.16b · MOTIR-1848) ──────────────────────
  //
  // `detail` above deliberately carries children WITHOUT the per-child
  // `dependencies` block — an OLDER Motir, which a separately-versioned CLI
  // routinely meets. The two tests above therefore also pin the DEGRADED path:
  // the plain 7.9.13 `CHILDREN` table, and a `--json` pass-through.

  /** The same aggregate from a server that DOES project the children's edges. */
  const graphed = {
    ...detail,
    children: [
      {
        identifier: 'PROD-9',
        kind: 'subtask',
        title: 'The dependent',
        status: 'blocked',
        dependencies: {
          blockedBy: [{ key: 'PROD-8', title: 'The blocker', status: 'todo' }],
          blocks: [],
        },
      },
      {
        identifier: 'PROD-8',
        kind: 'subtask',
        title: 'The blocker',
        status: 'todo',
        dependencies: {
          blockedBy: [],
          blocks: [{ key: 'PROD-9', title: 'The dependent', status: 'todo' }],
        },
      },
    ],
  };

  it('--json emits the tool payload UNCHANGED against a server with no child edges', async () => {
    const stdout = capture();

    await showCommand('PROD-7', { json: true });

    expect(JSON.parse(stdout())).toEqual(detail);
  });

  it('orders the children into build WAVES when the server projects their edges', async () => {
    const stdout = capture();
    server.script({ get_work_item: { structured: graphed } });

    await showCommand('PROD-7', {});
    const printed = stdout();

    expect(printed).toContain('CHILDREN (2) — build order');
    expect(printed).toContain('WAVE  KEY     KIND     STATUS   BLOCKED BY  TITLE');
    // The blocker leads, though the server listed it SECOND — the table is
    // ordered by the graph, not by position.
    const blocker = printed.indexOf('1     PROD-8');
    const dependent = printed.indexOf('2     PROD-9');
    expect(blocker).toBeGreaterThan(-1);
    expect(dependent).toBeGreaterThan(blocker);
    expect(printed).toContain('PROD-8      The dependent');
  });

  it('--json carries the full dependencies block AND the wave, in build order', async () => {
    const stdout = capture();
    server.script({ get_work_item: { structured: graphed } });

    await showCommand('PROD-7', { json: true });
    const payload = JSON.parse(stdout()) as {
      children: { identifier: string; wave: number; dependencies: { blockedBy: unknown[] } }[];
    };

    expect(payload.children.map((c) => [c.identifier, c.wave])).toEqual([
      ['PROD-8', 1],
      ['PROD-9', 2],
    ]);
    // Untruncated — the `+n` budget is a terminal-width concern, not a payload one.
    expect(payload.children[1]?.dependencies.blockedBy).toEqual([
      { key: 'PROD-8', title: 'The blocker', status: 'todo' },
    ]);
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

  // ── the discussion: --activity / --comments (MOTIR-2000) ──────────────────
  //
  // The stream is a SECOND tool call, made only when asked. These pin both
  // halves of that contract: the default read is untouched (one call, and not a
  // byte of new output), and each flag costs exactly one extra call naming the
  // view it stands for.

  /** One comment thread, exactly as `CommentThreadDTO` crosses the wire. */
  const thread = {
    id: 'c1',
    workItemId: 'row-7',
    parentCommentId: null,
    author: { id: 'u1', name: 'Zhu Yue', image: null },
    bodyMd: 'The rationale, in full.\n\nSecond paragraph.',
    editedAt: null,
    createdAt: '2026-07-30T12:00:00.000Z',
    mentionedUserIds: [],
    replies: [],
  };

  /** One page of the merged stream, as `get_work_item_activity` returns it. */
  const activityPage = {
    entries: [
      { type: 'comment', thread },
      {
        type: 'history',
        entry: {
          id: 'r1',
          workItemId: 'row-7',
          changeKind: 'updated',
          changedAt: '2026-08-01T12:00:00.000Z',
          actor: { userId: 'u2', name: 'Mo', image: null },
          parts: [
            {
              kind: 'field',
              field: 'status',
              from: { type: 'status', key: 'todo', label: 'To Do' },
              to: { type: 'status', key: 'in_progress', label: 'In Progress' },
            },
          ],
        },
      },
    ],
    nextCursor: null,
    totalComments: 1,
    totalChanges: 1,
    workItemRefs: {},
  };

  /** One page of the comments-only view. */
  const commentsPage = { threads: [thread], totalCount: 1, nextCursor: null, order: 'asc' };

  it('makes ONE tool call and prints no stream at all without a flag', async () => {
    const stdout = capture();
    server.script({ get_work_item_activity: { structured: activityPage } });

    await showCommand('PROD-7', {});
    const printed = stdout();

    expect(server.calls.map((c) => c.name)).toEqual(['get_work_item']);
    expect(printed).not.toContain('ACTIVITY');
    expect(printed).not.toContain('COMMENTS');
  });

  it('--activity adds exactly ONE call for view "all", and only APPENDS to the read', async () => {
    const plain = capture();
    await showCommand('PROD-7', {});
    const before = plain();
    vi.restoreAllMocks();

    const stdout = capture();
    server.calls.length = 0;
    server.script({ get_work_item_activity: { structured: activityPage } });

    await showCommand('PROD-7', { activity: true });
    const printed = stdout();

    expect(server.calls).toEqual([
      { name: 'get_work_item', args: { key: 'PROD-7' } },
      { name: 'get_work_item_activity', args: { key: 'PROD-7', view: 'all' } },
    ]);
    // Byte-identical to the flagless read, then the stream — the default output
    // cannot regress behind a flag that only ever adds.
    expect(printed.startsWith(before)).toBe(true);
    expect(printed).toContain('ACTIVITY\n1 comment · 1 change');
    expect(printed).toContain('[comment] Zhu Yue · ');
    expect(printed).toContain('The rationale, in full.');
    expect(printed).toContain('Second paragraph.');
    expect(printed).toContain('changed status: To Do → In Progress');
  });

  it('--comments adds ONE call for view "comments" and prints only the threads', async () => {
    const stdout = capture();
    server.script({ get_work_item_activity: { structured: commentsPage } });

    await showCommand('PROD-7', { comments: true });
    const printed = stdout();

    expect(server.calls).toEqual([
      { name: 'get_work_item', args: { key: 'PROD-7' } },
      { name: 'get_work_item_activity', args: { key: 'PROD-7', view: 'comments' } },
    ]);
    expect(printed).toContain('COMMENTS\n1 comment, oldest first');
    expect(printed).not.toContain('changed status');
  });

  it('refuses BOTH flags by name, before it opens a session', async () => {
    capture();

    await expect(showCommand('PROD-7', { activity: true, comments: true })).rejects.toMatchObject({
      message: expect.stringContaining('cannot be combined'),
    });
    expect(server.calls).toHaveLength(0);
  });

  it('--json carries the activity page UNALTERED, and omits the key without a flag', async () => {
    const stdout = capture();
    server.script({ get_work_item_activity: { structured: activityPage } });

    await showCommand('PROD-7', { activity: true, json: true });
    const payload = JSON.parse(stdout()) as Record<string, unknown>;

    // The tool's own page, byte for byte — including the cursor and the totals a
    // script needs in order to know there is more.
    expect(payload['activity']).toEqual(activityPage);
    // …riding ALONGSIDE the aggregate, which is unchanged.
    expect({ ...payload, activity: undefined }).toEqual({ ...detail, activity: undefined });

    vi.restoreAllMocks();
    const plain = capture();
    await showCommand('PROD-7', { json: true });
    expect(JSON.parse(plain())).not.toHaveProperty('activity');
  });
});

// ── the edge columns' machine view (7.9.16 · MOTIR-1845) ────────────────────
//
// The terminal cells abbreviate (a keys budget + `+n`); `--json` must NOT. These
// drive the real command modules against the test MCP server, so what is asserted
// is the payload a script actually receives — not a renderer's return value.

describe('motir ready / sprint — the edge columns and their --json fidelity', () => {
  let server: TestMcpServer;
  let cwd: string;
  let root: string;
  const TOKEN = 'pat_edge_token';

  /** Five `blocks` edges — two past the display budget — plus one already done. */
  const fanOut = {
    blockedBy: [{ key: 'PROD-2', title: 'A done blocker', status: 'done' }],
    blocks: [1, 2, 3, 4, 5].map((n) => ({
      key: `PROD-1${n}`,
      title: `Dependent ${n}`,
      status: 'todo',
    })),
  };

  const readyPage = {
    items: [
      {
        key: 'PROD-7',
        kind: 'subtask',
        title: 'The unblocker',
        priority: 'high',
        assignee: null,
        dependencies: fanOut,
      },
    ],
    nextCursor: null,
  };

  const sprintPage = {
    items: [
      {
        identifier: 'PROD-7',
        kind: 'subtask',
        title: 'The gated one',
        status: 'blocked',
        priority: 'high',
        dependencies: fanOut,
      },
    ],
    total: 1,
    nextCursor: null,
  };

  const sprints = {
    sprints: [
      {
        id: 'sp-1',
        name: 'Journey D',
        state: 'active',
        goal: null,
        startDate: null,
        endDate: null,
        sequence: 1,
        issueCount: 1,
        committedPoints: null,
        committedIssueCount: null,
      },
    ],
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
    server = await startTestMcpServer({ token: TOKEN, tools: { ...DEFAULT_TOOLS } });
  });

  afterAll(async () => {
    process.chdir(cwd);
    await server.close();
  });

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'motir-edges-'));
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
    server.script({
      list_ready: { structured: readyPage },
      list_sprints: { structured: sprints },
      search_work_items: { structured: sprintPage },
    });
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('`ready` prints the BLOCKS column, abbreviated to the budget', async () => {
    const stdout = capture();

    await readyCommand({});
    const printed = stdout();

    expect(printed).toContain('BLOCKS');
    expect(printed).toContain('PROD-11, PROD-12, PROD-13 +2');
    // The blocked-by direction is dead on a ready row and is not printed.
    expect(printed).not.toContain('BLOCKED BY');
  });

  it('`ready --json` carries the FULL dependencies block, untruncated', async () => {
    const stdout = capture();

    await readyCommand({ json: true });
    const payload = JSON.parse(stdout()) as { dependencies: typeof fanOut }[];

    // Both directions, every edge, verbatim — the terminal abbreviates, the
    // machine view never lies.
    expect(payload[0]?.dependencies).toEqual(fanOut);
    expect(payload[0]?.dependencies.blocks).toHaveLength(5);
  });

  it('`sprint` prints BOTH directions, with the done blocker marked rather than counted', async () => {
    const stdout = capture();

    await sprintCommand(undefined, {});
    const printed = stdout();

    expect(printed).toContain('BLOCKED BY');
    expect(printed).toContain('PROD-2✓');
    expect(printed).toContain('✓ = already done');
    expect(printed).toContain('PROD-11, PROD-12, PROD-13 +2');
  });

  it('`sprint --json` carries the FULL dependencies block, untruncated', async () => {
    const stdout = capture();

    await sprintCommand(undefined, { json: true });
    const payload = JSON.parse(stdout()) as { items: { dependencies: typeof fanOut }[] };

    expect(payload.items[0]?.dependencies).toEqual(fanOut);
    expect(payload.items[0]?.dependencies.blocks).toHaveLength(5);
  });

  it('degrades to the pre-7.9.16 tables against a server with no edge projection', async () => {
    const stdout = capture();
    server.script({
      list_ready: {
        structured: {
          items: [{ key: 'PROD-7', kind: 'subtask', title: 'Older server', priority: 'high' }],
          nextCursor: null,
        },
      },
    });

    await readyCommand({});
    const printed = stdout();

    expect(printed).toContain('1 ready work item:');
    expect(printed).toContain('Older server');
    expect(printed).not.toContain('BLOCKS');
  });
});
