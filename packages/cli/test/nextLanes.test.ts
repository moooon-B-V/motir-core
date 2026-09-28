import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/errors.js';
import { addExclude } from '../src/sessionExcludes.js';
import type { DispatchItem, ReadyContainerSummary, WorkItemDetail } from '../src/client.js';
import { renderReadyContainers, renderReadyTable } from '../src/render.js';

// `motir next --parent | --bug` and `motir ready --parent | --bug` (Story
// MOTIR-6829 · MOTIR-6837) — the three ready lanes as commands. The session and
// the agent are stubbed, as in `dispatchCommand.test.ts`; what is under test is
// which lane each command reads, that `--parent` hands its pick to the SAME
// scoped path `motir run <KEY>` takes, and the flag refusals.

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as unknown } }));

vi.mock('../src/agentRun.js', () => ({ runAgent: vi.fn() }));
vi.mock('../src/session.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
}));

const { nextCommand } = await import('../src/commands/dispatch.js');
const { readyCommand } = await import('../src/commands/read.js');

const SERVER = 'https://app.motir.co';

function container(key: string, over: Partial<ReadyContainerSummary> = {}): ReadyContainerSummary {
  return {
    key,
    kind: 'story',
    title: `Story ${key}`,
    priority: 'high',
    assignee: null,
    readyLeafCount: 2,
    childCount: 3,
    ...over,
  };
}

function leaf(key: string, over: Partial<DispatchItem> = {}): DispatchItem {
  return {
    key,
    kind: 'subtask',
    title: `Leaf ${key}`,
    priority: 'high',
    status: { key: 'todo', category: 'todo' },
    assigneeId: null,
    type: 'code',
    executor: 'coding_agent',
    inheritedSessionBranch: null,
    containerKey: null,
    ...over,
  };
}

/** A container's detail — what `resolveScopeTarget` reads for `motir run <KEY>`. */
function containerDetail(key: string): WorkItemDetail {
  return {
    item: {
      identifier: key,
      kind: 'story',
      title: `Story ${key}`,
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      type: null,
      executor: null,
      storyPoints: null,
      estimateMinutes: null,
      targetRepo: 'motir-core',
      sprintId: null,
      descriptionMd: null,
    },
    ancestors: [],
    children: [{ key: `${key}-child`, kind: 'subtask', title: 'child', status: 'todo' }],
    blockedBy: [],
    blocks: [],
    relatesTo: [],
    readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
  } as unknown as WorkItemDetail;
}

let calls: { tool: string; args: unknown }[];
let stdout: string;
let stderr: string;
let home: string;

function setup(lanes: {
  containers?: ReadyContainerSummary[];
  leaves?: DispatchItem[];
  bugs?: DispatchItem[];
}) {
  calls = [];
  const client = {
    whoami: async () => ({ user: { id: 'u1', name: 'Me', email: 'm@x' }, workspace: null }),
    nextReady: async (args: { lanes?: string[]; excludeKeys?: string[] }) => {
      calls.push({ tool: 'nextReady', args });
      const lane = args.lanes?.[0] ?? 'leaf';
      const rows = (lane === 'bug' ? lanes.bugs : lanes.leaves) ?? [];
      const held = new Set(args.excludeKeys ?? []);
      return { item: rows.find((r) => !held.has(r.key)) ?? null };
    },
    nextReadyContainer: async (args: { excludeKeys?: string[] }) => {
      calls.push({ tool: 'nextReadyContainer', args });
      const held = new Set(args.excludeKeys ?? []);
      return { container: (lanes.containers ?? []).find((c) => !held.has(c.key)) ?? null };
    },
    listReady: async (args: { lane?: string }) => {
      calls.push({ tool: 'listReady', args });
      const rows = (args.lane === 'bug' ? lanes.bugs : lanes.leaves) ?? [];
      return { items: rows.map((r) => ({ ...r, container: null })), nextCursor: null };
    },
    listReadyContainers: async (args: unknown) => {
      calls.push({ tool: 'listReadyContainers', args });
      return { items: lanes.containers ?? [], nextCursor: null };
    },
    getWorkItem: async (key: string) => {
      calls.push({ tool: 'getWorkItem', args: key });
      return containerDetail(key);
    },
    claimWorkItem: async () => {
      throw new Error('a lane refusal must claim nothing');
    },
  };
  sessionRef.current = { client, serverUrl: SERVER, projectKey: 'PROD', link: { dir: home } };
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-lanes-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  delete process.env['MOTIR_AGENT'];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
});

describe('motir next --parent', () => {
  it('takes the first container and hands it to the SAME scoped path `motir run <KEY>` takes', async () => {
    setup({ containers: [container('PROD-10'), container('PROD-20')] });
    // No agent configured: the scoped path's own requirement is the proof it was
    // reached with PROD-10 — `motir run PROD-10` refuses identically.
    await expect(nextCommand({ parent: true })).rejects.toThrow(/agent/i);
    expect(calls.find((c) => c.tool === 'getWorkItem')?.args).toBe('PROD-10');
    expect(stderr).toContain('Next container: PROD-10');
  });

  it('skips a container on the exclude list', async () => {
    setup({ containers: [container('PROD-10'), container('PROD-20')] });
    addExclude(SERVER, 'PROD', { key: 'PROD-10', reason: 'failed' });
    await expect(nextCommand({ parent: true })).rejects.toThrow(/agent/i);
    expect(calls.find((c) => c.tool === 'getWorkItem')?.args).toBe('PROD-20');
  });

  it.each([
    [{ parent: true, print: true }, /--print/],
    [{ parent: true, kinds: 'subtask' }, /--parent.*--kinds|--kinds/],
    [{ parent: true, bug: true }, /--parent.*--bug/],
  ])('refuses %o before claiming anything', async (opts, message) => {
    setup({ containers: [container('PROD-10')] });
    await expect(nextCommand(opts)).rejects.toThrow(CliError);
    await expect(nextCommand(opts)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('says so, and exits cleanly, when the containers lane is empty', async () => {
    setup({ containers: [] });
    await nextCommand({ parent: true });
    expect(stderr).toContain('No ready work items in the container lane.');
  });
});

describe('motir next --bug', () => {
  it('reads the BUGS lane; a bug whose subtask is ready runs that bug as a parent run', async () => {
    setup({ bugs: [leaf('PROD-31', { containerKey: 'PROD-30' })] });
    await expect(nextCommand({ bug: true })).rejects.toThrow(/agent/i);
    expect(calls[0]).toEqual({
      tool: 'nextReady',
      args: expect.objectContaining({ lanes: ['bug'] }),
    });
    expect(calls.find((c) => c.tool === 'getWorkItem')?.args).toBe('PROD-30');
  });

  it('says so when the bugs lane is empty', async () => {
    setup({ bugs: [] });
    await nextCommand({ bug: true, print: true });
    expect(stderr).toContain('No ready work items in the bug lane.');
  });
});

describe('motir next (the leaf lane)', () => {
  it('asks the LEAVES lane only — a bug is never its pick', async () => {
    setup({ leaves: [], bugs: [leaf('PROD-40', { kind: 'bug' })] });
    await nextCommand({ print: true });
    expect(calls[0]).toEqual({
      tool: 'nextReady',
      args: expect.objectContaining({ lanes: ['leaf'] }),
    });
    expect(stderr).toContain('No ready work items in the leaf lane.');
  });
});

describe('motir ready --parent | --bug', () => {
  it('--parent lists the containers lane, --bug the bugs lane', async () => {
    setup({ containers: [container('PROD-10')], bugs: [leaf('PROD-40', { kind: 'bug' })] });
    await readyCommand({ parent: true });
    expect(stdout).toContain('PROD-10');
    expect(stdout).toContain('2 of 3');
    stdout = '';
    await readyCommand({ bug: true });
    expect(calls.at(-1)).toEqual({
      tool: 'listReady',
      args: expect.objectContaining({ lane: 'bug' }),
    });
    expect(stdout).toContain('PROD-40');
  });

  it('--json emits the lane’s rows', async () => {
    setup({ containers: [container('PROD-10')] });
    await readyCommand({ parent: true, json: true });
    expect(JSON.parse(stdout)).toEqual([container('PROD-10')]);
  });

  it('refuses --parent with --bug', async () => {
    setup({});
    await expect(readyCommand({ parent: true, bug: true })).rejects.toThrow(/--parent.*--bug/);
  });
});

describe('the lane renderers', () => {
  it('prints a container as a header line over its leaves, indented; a standalone row unindented', () => {
    const header = container('PROD-10', { readyLeafCount: 2, childCount: 3 });
    const table = renderReadyTable([
      { key: 'PROD-11', kind: 'subtask', title: 'a', priority: 'high', container: header },
      { key: 'PROD-12', kind: 'subtask', title: 'b', priority: 'high', container: header },
      { key: 'PROD-20', kind: 'task', title: 'c', priority: 'low', container: null },
    ]);
    const lines = table.split('\n');
    const at = (key: string) => lines.findIndex((l) => l.includes(key));
    expect(at('PROD-10')).toBeLessThan(at('PROD-11'));
    expect(lines[at('PROD-10')]).toContain('(2 of 3 ready)');
    expect(lines[at('PROD-11')]).toMatch(/^\s+PROD-11/);
    expect(lines[at('PROD-20')]).toMatch(/^PROD-20/);
    // One header per container, however many rows it holds.
    expect(lines.filter((l) => l.includes('PROD-10'))).toHaveLength(1);
  });

  it('each empty lane says so in one line', () => {
    expect(renderReadyTable([])).toBe('No ready work items in the leaf lane.');
    expect(renderReadyTable([], undefined, 'bug')).toBe('No ready work items in the bug lane.');
    expect(renderReadyContainers([])).toBe('No ready work items in the container lane.');
  });
});
