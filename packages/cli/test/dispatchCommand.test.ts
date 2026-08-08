import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/errors.js';
import { readExcludes } from '../src/sessionExcludes.js';
import type {
  CompleteSessionResult,
  DispatchItem,
  DispatchPrompt,
  WorkItemDetail,
} from '../src/client.js';

// `motir next` / `motir run` / `motir done` orchestration. The MCP session and
// the agent SPAWN are stubbed (both are covered for real elsewhere:
// mcpClient.test.ts and agentRun.test.ts); what is under test here is the
// PIPELINE — which tool calls happen, in what order, what reaches stdout vs
// stderr, and what the failure path records.

const { agentResult, runAgentMock, sessionRef } = vi.hoisted(() => ({
  agentResult: { exitCode: 0, model: null } as { exitCode: number; model: string | null },
  runAgentMock: vi.fn(),
  sessionRef: { current: null as unknown },
}));

vi.mock('../src/agentRun.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
}));

const { doneCommand, nextCommand, runCommand } = await import('../src/commands/dispatch.js');

const SERVER = 'https://app.motir.co';
/** The token owner every dispatch below claims for (MOTIR-2427). */
const OWNER = 'user_me';
const PROMPT_TEXT = 'CONTEXT\nWHAT TO DO\nACCEPTANCE CRITERIA\nGIT WORKFLOW\n';

function dispatchPrompt(over: Partial<DispatchPrompt> = {}): DispatchPrompt {
  return {
    key: 'PROD-7',
    prompt: PROMPT_TEXT,
    parentKey: 'PROD-2',
    targetRepo: 'motir-core',
    workflowMode: 'per_item_pr',
    sessionBranch: null,
    ...over,
  };
}

function readyItem(over: Partial<DispatchItem> = {}): DispatchItem {
  return {
    key: 'PROD-7',
    kind: 'subtask',
    title: 'Add the thing',
    priority: 'high',
    status: { key: 'todo', category: 'todo' },
    assigneeId: null,
    type: 'code',
    executor: 'coding_agent',
    inheritedSessionBranch: null,
    ...over,
  };
}

function workItem(over: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    item: {
      identifier: 'PROD-7',
      kind: 'subtask',
      title: 'Add the thing',
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      type: 'code',
      executor: 'coding_agent',
      storyPoints: 3,
      estimateMinutes: 40,
      targetRepo: 'motir-core',
      sprintId: null,
      descriptionMd: null,
    },
    ancestors: [],
    children: [],
    blockedBy: [],
    blocks: [],
    relatesTo: [],
    readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
    ...over,
  };
}

interface Harness {
  calls: { tool: string; args: unknown }[];
  stdout: string;
  stderr: string;
  root: string;
}

let harness: Harness;
let home: string;

/** Build the fake session + capture the two streams. */
function setup(
  opts: {
    item?: DispatchItem | null;
    detail?: WorkItemDetail;
    prompt?: DispatchPrompt;
    transitionError?: (status: string) => Error | null;
    sessionResult?: CompleteSessionResult;
    repos?: string[];
  } = {},
) {
  const calls: Harness['calls'] = [];
  const root = mkdtempSync(join(tmpdir(), 'motir-root-'));
  for (const repo of opts.repos ?? ['motir-core']) mkdirSync(join(root, repo));

  const client = {
    whoami: async () => {
      calls.push({ tool: 'whoami', args: undefined });
      return { user: { id: OWNER, name: 'Me', email: 'me@motir.test' }, workspace: null };
    },
    claimWorkItem: async (args: unknown) => {
      calls.push({ tool: 'claim', args });
      return {};
    },
    nextReady: async (args: unknown) => {
      calls.push({ tool: 'next_ready', args });
      return { item: opts.item === undefined ? readyItem() : opts.item };
    },
    getWorkItem: async (key: string) => {
      calls.push({ tool: 'get_work_item', args: key });
      return opts.detail ?? workItem();
    },
    transitionStatus: async (args: { key: string; status: string }) => {
      calls.push({ tool: 'transition_status', args });
      const err = opts.transitionError?.(args.status);
      if (err) throw err;
      return {};
    },
    dispatchPrompt: async (key: string) => {
      calls.push({ tool: 'dispatch_prompt', args: key });
      return opts.prompt ?? dispatchPrompt();
    },
    markIntegrated: async (args: unknown) => {
      calls.push({ tool: 'mark_integrated', args });
      return {};
    },
    completeSession: async (args: unknown) => {
      calls.push({ tool: 'complete_session', args });
      return (
        opts.sessionResult ?? {
          sessionBranch: 'story/PROD-9',
          results: [{ key: 'PROD-7', outcome: 'completed' as const }],
        }
      );
    },
  };

  sessionRef.current = {
    client,
    serverUrl: SERVER,
    projectKey: 'PROD',
    link: {
      dir: root,
      path: join(root, '.motir.json'),
      config: { serverUrl: SERVER, workspace: 'moooon', project: 'PROD' },
    },
  };

  harness = { calls, stdout: '', stderr: '', root };
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    harness.stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    harness.stderr += String(chunk);
    return true;
  });
  return harness;
}

const toolNames = () => harness.calls.map((c) => c.tool);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  delete process.env['MOTIR_AGENT'];
  agentResult.exitCode = 0;
  agentResult.model = null;
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async () => ({
    exitCode: agentResult.exitCode,
    signal: null,
    model: agentResult.model,
  }));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
  if (harness?.root) rmSync(harness.root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('motir next --print', () => {
  it('claims the item to in_progress and prints the SERVER prompt byte-identical', async () => {
    setup();
    await nextCommand({ print: true });

    expect(toolNames()).toEqual([
      'whoami',
      'next_ready',
      'claim',
      'transition_status',
      'dispatch_prompt',
    ]);
    // The CLAIM lands BEFORE the status moves and long before any agent
    // launches (MOTIR-2427) — a claim written at the end is history.
    expect(harness.calls[2]?.args).toEqual({ key: 'PROD-7', ownerId: OWNER });
    expect(harness.calls[3]?.args).toEqual({ key: 'PROD-7', status: 'in_progress' });
    // The prompt is the ONLY thing on stdout, verbatim — nothing prepended,
    // nothing appended but the single terminating newline.
    expect(harness.stdout).toBe(PROMPT_TEXT);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('puts the repo + RESOLVED path on stderr, so the pipe stays clean', async () => {
    setup();
    await nextCommand({ print: true });
    expect(harness.stderr).toContain('motir-core');
    expect(harness.stderr).toContain(join(harness.root, 'motir-core'));
    expect(harness.stdout).not.toContain('motir-core');
  });

  it('reports an empty ready set without touching any status', async () => {
    setup({ item: null });
    await nextCommand({ print: true });
    expect(toolNames()).toEqual(['whoami', 'next_ready']);
    expect(harness.stderr).toContain('No ready work items.');
  });

  it('passes --kinds through to next_ready', async () => {
    setup();
    await nextCommand({ print: true, kinds: 'subtask,bug' });
    expect(harness.calls[1]?.args).toMatchObject({ kinds: ['subtask', 'bug'] });
  });

  it('does NOT re-flip an item that is already In Progress', async () => {
    setup({ item: readyItem({ status: { key: 'in_progress', category: 'in_progress' } }) });
    await nextCommand({ print: true });
    expect(toolNames()).toEqual(['whoami', 'next_ready', 'claim', 'dispatch_prompt']);
    expect(harness.stderr).toContain('already In Progress');
  });
});

describe('motir next --agent', () => {
  it('runs the agent in the target repo checkout and lands the item In Review', async () => {
    setup();
    await nextCommand({ agent: 'claude --yolo' });

    expect(runAgentMock).toHaveBeenCalledOnce();
    const call = runAgentMock.mock.calls[0]?.[0];
    expect(call.prompt).toBe(PROMPT_TEXT);
    expect(call.cwd).toBe(join(harness.root, 'motir-core'));
    expect(call.command).toMatchObject({ binary: 'claude', args: ['--yolo'] });
    expect(toolNames()).toEqual([
      'whoami',
      'next_ready',
      'claim',
      'transition_status',
      'dispatch_prompt',
      'transition_status',
    ]);
    expect(harness.calls[5]?.args).toEqual({ key: 'PROD-7', status: 'in_review' });
    expect(harness.stderr).toContain('motir done PROD-7');
  });

  it('a SESSION-LINEAGE item is mark_integrated on its inherited branch, not PR-flipped', async () => {
    setup({
      prompt: dispatchPrompt({ workflowMode: 'session_lineage', sessionBranch: 'story/PROD-9' }),
    });
    await nextCommand({ agent: 'claude' });

    expect(toolNames()).toContain('mark_integrated');
    expect(harness.calls.find((c) => c.tool === 'mark_integrated')?.args).toMatchObject({
      key: 'PROD-7',
      sessionBranch: 'story/PROD-9',
    });
    // it must NOT also hand-flip to in_review — mark_integrated does that move
    expect(harness.calls.filter((c) => c.tool === 'transition_status')).toHaveLength(1);
    expect(harness.stderr).toContain('motir done --session story/PROD-9');
  });

  it('stamps the AGENT and its self-reported model as implementation provenance', async () => {
    // `motir run` is the other seam that launches an agent and records what
    // built the item — it must answer the same way `motir auto` does
    // (MOTIR-2419), or the provenance depends on which command you used.
    agentResult.model = 'claude-opus-5';
    setup({
      prompt: dispatchPrompt({ workflowMode: 'session_lineage', sessionBranch: 'story/PROD-9' }),
    });
    await nextCommand({ agent: '/usr/local/bin/cursor-agent --force' });

    expect(harness.calls.find((c) => c.tool === 'mark_integrated')?.args).toMatchObject({
      implementationHarness: 'cursor',
      implementationModel: 'claude-opus-5',
    });
  });

  it('omits the model — and still names the agent — when the agent reported none', async () => {
    setup({
      prompt: dispatchPrompt({ workflowMode: 'session_lineage', sessionBranch: 'story/PROD-9' }),
    });
    await nextCommand({ agent: 'claude' });

    // Null, never defaulted: the harness is derivable and stays truthful, the
    // model is not and stays empty.
    expect(harness.calls.find((c) => c.tool === 'mark_integrated')?.args).toMatchObject({
      implementationHarness: 'claude',
      implementationModel: null,
    });
  });

  it('on a NON-ZERO exit: item stays In Progress, is excluded, and the exit code propagates', async () => {
    agentResult.exitCode = 2;
    setup();
    await nextCommand({ agent: 'claude' });

    // only the dispatch flip — nothing moved the item afterwards
    expect(harness.calls.filter((c) => c.tool === 'transition_status')).toHaveLength(1);
    expect(harness.stderr).toContain('stays In Progress');
    expect(process.exitCode).toBe(2);
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-7' }]);
  });

  // MOTIR-2338: the persisted list holds KEYS, and `next_ready` still narrows by
  // row id — so the skip is now a TRANSLATION. The first ask carries no
  // exclusions; the excluded item is skipped by key inside the client's walk.
  it('the NEXT next skips the excluded item by KEY, in one ask, and --reset un-skips it', async () => {
    agentResult.exitCode = 1;
    setup();
    await nextCommand({ agent: 'claude' });

    agentResult.exitCode = 0;
    setup();
    await nextCommand({ print: true });
    const asks = harness.calls.filter((c) => c.tool === 'next_ready');
    // ONE ask (MOTIR-2398). The hold-out is applied inside the client's walk
    // over the ranked page, so the ask-learn-the-id-ask-again round trip is
    // gone and the KEY goes straight through from the persisted list.
    expect(asks).toHaveLength(1);
    expect(asks[0]?.args).toMatchObject({ excludeKeys: ['PROD-7'] });
    expect(harness.stderr).toContain('Skipping 1 previously-failed item(s): PROD-7');

    setup();
    await nextCommand({ print: true, reset: true });
    expect(harness.calls[1]?.args).not.toHaveProperty('excludeKeys');
  });

  it('a SUCCESSFUL run clears a prior exclusion for that item', async () => {
    agentResult.exitCode = 1;
    setup();
    await nextCommand({ agent: 'claude' });
    expect(readExcludes(SERVER, 'PROD')).toHaveLength(1);

    // Retried by KEY — the explicit path, which does not consult the exclude
    // list. `motir next` would keep holding PROD-7 out until `--reset`, which
    // is what the test above asserts.
    agentResult.exitCode = 0;
    setup();
    await runCommand('PROD-7', { agent: 'claude' });
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  it('BOOTSTRAP: an item whose checkout is missing runs at the ROOT and is reported suspect', async () => {
    setup({ prompt: dispatchPrompt({ targetRepo: 'brand-new' }), repos: [] });
    await nextCommand({ agent: 'claude' });

    expect(runAgentMock.mock.calls[0]?.[0].cwd).toBe(harness.root);
    expect(harness.stderr).toContain('Suspect dispatch');
    expect(harness.stderr).toContain('motir link add brand-new');
  });

  it('BOOTSTRAP is silent when the agent actually created the checkout', async () => {
    setup({ prompt: dispatchPrompt({ targetRepo: 'brand-new' }), repos: [] });
    runAgentMock.mockImplementation(async () => {
      mkdirSync(join(harness.root, 'brand-new'));
      return { exitCode: 0, signal: null };
    });
    await nextCommand({ agent: 'claude' });
    expect(harness.stderr).not.toContain('Suspect dispatch');
  });
});

describe('motir run <key>', () => {
  it('REFUSES a not-ready item without --force, naming the blockers', async () => {
    setup({
      detail: workItem({
        readiness: {
          ready: false,
          openBlockers: [
            { identifier: 'PROD-3', kind: 'subtask', title: 'Schema', status: 'todo' },
          ],
          blockedByAncestor: null,
        },
      }),
    });
    await expect(runCommand('PROD-7', {})).rejects.toThrow(/not ready.*PROD-3/s);
    // nothing was claimed
    expect(toolNames()).toEqual(['get_work_item']);
  });

  it('dispatches a not-ready item WITH --force, and says it did', async () => {
    setup({
      detail: workItem({
        readiness: { ready: false, openBlockers: [], blockedByAncestor: null },
      }),
    });
    await runCommand('PROD-7', { force: true, print: true });
    expect(toolNames()).toEqual([
      'get_work_item',
      'whoami',
      'claim',
      'transition_status',
      'dispatch_prompt',
    ]);
    expect(harness.stderr).toContain('--force');
    expect(harness.stdout).toBe(PROMPT_TEXT);
  });

  it('dispatches a ready item straight through', async () => {
    setup();
    await runCommand('PROD-7', { print: true });
    expect(toolNames()).toEqual([
      'get_work_item',
      'whoami',
      'claim',
      'transition_status',
      'dispatch_prompt',
    ]);
  });

  it('rejects an empty key before any network call', async () => {
    setup();
    await expect(runCommand('   ', {})).rejects.toThrow(CliError);
    expect(toolNames()).toEqual([]);
  });
});

// The PROSE-vs-GRAPH warning (MOTIR-2079). The load-bearing property is what it
// does NOT change: `likely-missing-edge` is a severity, never a gate. A card
// carrying one dispatches exactly like a card carrying none — same tool calls,
// same stdout, status 0, no `--force` — and the only difference is a line of
// diagnostics on stderr. If a future change makes any of these fail, it has
// turned the advisory into a blocker, which would falsely stop the three shapes
// MOTIR-1969 enumerates (a boundary-contract card naming both halves of a
// two-PR split, an acceptance criterion naming a card for contrast, and a
// sibling that will be done first).
describe('the prose-vs-graph advisory WARNING (MOTIR-2079)', () => {
  const WITH_ADVISORY = dispatchPrompt({
    advisories: [
      {
        item: 'PROD-7',
        referenced: 'PROD-5',
        referencedStatus: 'in_review',
        severity: 'likely-missing-edge',
      },
    ],
  });

  it('motir run WARNS and still dispatches — exit code 0, no --force required', async () => {
    setup({ prompt: WITH_ADVISORY });
    await runCommand('PROD-7', { print: true });

    expect(harness.stderr).toContain('PROD-5 (in_review)');
    expect(harness.stderr).toContain('NOT a blocker');
    // Byte-identical to the no-advisory run: same calls, same payload, same code.
    expect(toolNames()).toEqual([
      'get_work_item',
      'whoami',
      'claim',
      'transition_status',
      'dispatch_prompt',
    ]);
    expect(harness.stdout).toBe(PROMPT_TEXT);
    expect(process.exitCode).toBeUndefined();
  });

  it('motir next WARNS too — the same one site serves both commands', async () => {
    setup({ prompt: WITH_ADVISORY });
    await nextCommand({ print: true });

    expect(harness.stderr).toContain('PROD-5 (in_review)');
    expect(toolNames()).toEqual([
      'whoami',
      'next_ready',
      'claim',
      'transition_status',
      'dispatch_prompt',
    ]);
    expect(harness.stdout).toBe(PROMPT_TEXT);
    expect(process.exitCode).toBeUndefined();
  });

  it('the warning is DIAGNOSTICS — stdout stays the prompt alone, so the pipe is clean', async () => {
    setup({ prompt: WITH_ADVISORY });
    await nextCommand({ print: true });
    expect(harness.stdout).toBe(PROMPT_TEXT);
    expect(harness.stdout).not.toContain('PROD-5');
  });

  it('warns in --agent mode too, before the agent is launched', async () => {
    setup({ prompt: WITH_ADVISORY });
    await nextCommand({ agent: 'claude' });
    expect(harness.stderr).toContain('PROD-5 (in_review)');
    expect(runAgentMock).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('says nothing at all when the card carries none', async () => {
    setup({ prompt: dispatchPrompt({ advisories: [] }) });
    await runCommand('PROD-7', { print: true });
    expect(harness.stderr).not.toContain('NOT a blocker');
  });

  it('says nothing when the SERVER omits the field — an older self-hosted Motir', async () => {
    setup({ prompt: dispatchPrompt() });
    await runCommand('PROD-7', { print: true });
    expect(harness.stderr).not.toContain('NOT a blocker');
    expect(harness.stdout).toBe(PROMPT_TEXT);
  });
});

describe('motir done', () => {
  it('flips a single item to done and clears its exclusion', async () => {
    setup();
    await doneCommand('PROD-7', {});
    expect(harness.calls).toEqual([
      { tool: 'transition_status', args: { key: 'PROD-7', status: 'done' } },
    ]);
    expect(harness.stderr).toContain('PROD-7: done.');
  });

  it('surfaces the service’s ALLOWED-TARGETS error verbatim, plus a one-hop hint', async () => {
    const illegal = new CliError(
      'ILLEGAL_TRANSITION: In Progress → Done is not allowed. Allowed: To Do, Blocked, In Review, Cancelled.',
    );
    setup({ transitionError: (status) => (status === 'done' ? illegal : null) });

    await expect(doneCommand('PROD-7', {})).rejects.toMatchObject({
      message: illegal.message,
      hint: expect.stringContaining('--via in_review'),
    });
  });

  it('--via walks through the named status first', async () => {
    setup();
    await doneCommand('PROD-7', { via: 'in_review' });
    expect(harness.calls.map((c) => c.args)).toEqual([
      { key: 'PROD-7', status: 'in_review' },
      { key: 'PROD-7', status: 'done' },
    ]);
  });

  it('--session bulk-closes a merged session branch and prints per-item outcomes', async () => {
    setup({
      sessionResult: {
        sessionBranch: 'story/PROD-9',
        results: [
          { key: 'PROD-7', outcome: 'completed' },
          { key: 'PROD-8', outcome: 'failed', reason: 'no legal path' },
        ],
      },
    });
    await doneCommand(undefined, { session: 'story/PROD-9' });
    expect(toolNames()).toEqual(['complete_session']);
    expect(harness.stderr).toContain('PROD-7: completed');
    expect(harness.stderr).toContain('PROD-8: failed — no legal path');
  });

  it('reports the SOURCE and nothing else — it knows no agent and no model', async () => {
    // MOTIR-2447. The close-out ran after a human merged, days after the agents
    // exited. Sending `motir-cli/<version>` as the harness here overwrote the
    // agent name and model `mark_integrated` recorded during the run.
    setup();
    await doneCommand(undefined, { session: 'story/PROD-9' });

    const args = harness.calls.find((c) => c.tool === 'complete_session')?.args as Record<
      string,
      unknown
    >;
    expect(args).toEqual({ sessionBranch: 'story/PROD-9', implementationSource: 'byok' });
    // Named explicitly, because it is the whole defect: `toEqual` above already
    // fails on it, and saying so keeps the reason attached to the assertion.
    expect(args).not.toHaveProperty('implementationHarness');
    expect(JSON.stringify(args)).not.toContain('motir-cli');
  });

  describe('the CLAIM — every dispatch says who took the card (MOTIR-2427)', () => {
    it('`motir next` claims BEFORE the status moves and before any agent launches', async () => {
      setup();
      await nextCommand({ print: true });

      const names = toolNames();
      expect(names.indexOf('claim')).toBeLessThan(names.indexOf('transition_status'));
      expect(names.indexOf('claim')).toBeLessThan(names.indexOf('dispatch_prompt'));
      expect(harness.calls.find((c) => c.tool === 'claim')?.args).toEqual({
        key: 'PROD-7',
        ownerId: OWNER,
      });
    });

    it('`motir run <key>` claims a NAMED card too', async () => {
      // Being told which card to take is not being told it is unclaimed.
      setup();
      await runCommand('PROD-7', { print: true });

      expect(harness.calls.find((c) => c.tool === 'claim')?.args).toEqual({
        key: 'PROD-7',
        ownerId: OWNER,
      });
    });

    it('asks WHOAMI once per invocation, not once per item', async () => {
      setup();
      await nextCommand({ print: true });
      expect(harness.calls.filter((c) => c.tool === 'whoami')).toHaveLength(1);
    });

    it('`motir run <key>` WARNS on a card claimed by someone else — and dispatches it', async () => {
      // `run` is GIVEN a key by a person with a reason, so the rule warns rather
      // than refuses. Refusing would break the documented recovery for a card an
      // agent left in progress; saying nothing is what made the collision
      // invisible in the first place.
      setup({
        detail: workItem({
          item: { ...workItem().item, assigneeId: 'user_them' },
        }),
      });
      await runCommand('PROD-7', { print: true });

      expect(harness.stderr).toContain('assigned to someone else');
      expect(harness.stderr).toContain('two agents on one card');
      // …and it still went ahead: the human asked for it.
      expect(toolNames()).toContain('dispatch_prompt');
    });

    it('`motir run <key>` says nothing about a card that was pickable anyway', async () => {
      setup();
      await runCommand('PROD-7', { print: true });
      expect(harness.stderr).not.toContain('assigned to someone else');
    });
  });

  it('refuses a key AND --session together', async () => {
    setup();
    await expect(doneCommand('PROD-7', { session: 'story/PROD-9' })).rejects.toThrow(/not both/);
  });

  it('requires a key when no --session is given', async () => {
    setup();
    await expect(doneCommand(undefined, {})).rejects.toThrow(CliError);
  });
});
