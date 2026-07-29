import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import {
  installFakeGh,
  makeCliWorkspace,
  makeLocalRepo,
  readLinkFile,
  writeFakeAgent,
  type CliWorkspace,
  type FakeAgent,
  type FakeGh,
} from '../helpers/cliHarness';

// STORY-CLOSING suite for the Motir CLI (Story 7.9 · Subtask 7.9.5 · MOTIR-883).
//
// The per-subtask vitest under `packages/cli/test/**` covers each module in
// isolation, in-process, with the MCP client, the agent launcher and git all
// injected. Nothing there proves the ASSEMBLED tool works: that the tsup bundle
// `package.json#bin` points at boots, that it speaks the real protocol to the
// real `/api/mcp` route over a real socket, that a status flip actually lands in
// Postgres as the token's owner, or that a `motir auto` run ends with one pull
// request and a `main` nobody advanced.
//
// So this suite drives the BUILT BINARY as a CHILD PROCESS:
//
//   built `motir` binary  ──HTTP──▶  the real /api/mcp route  ──▶  real Postgres
//          │                         (withMcpAuth + verifyMcpToken +
//          │                          the production resolvers + tool registry)
//          ├─ spawns ──▶ a scripted FAKE AGENT (records its cwd, stdin and
//          │             $MOTIR_PROMPT_FILE; exits per fixture; never an LLM)
//          └─ shells ──▶ real `git` against real on-disk repos, and a fake `gh`
//                        that records what would have been opened
//
// No mocks anywhere in that chain (the repo's testing contract). The two fakes
// are the programs Motir deliberately does NOT own — the user's BYOK agent and
// `gh` — and both are recorded, not stubbed silent, so what the CLI asked them
// to do is itself asserted.
//
// Every command gets at least one happy path and one failure path here.

// Every test here spawns at least one child process (often several, plus real
// git), so the root lane's 15s default is too tight under a loaded CI shard —
// and a timeout there would read as a flaky CLI rather than a slow runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let server: McpTestServer;
let ws: CliWorkspace;

beforeAll(async () => {
  server = await startMcpHttpServer();
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  // A fresh workspace per test: `truncateAuthTables` deletes the tenant the
  // stored PAT belongs to, so a credential store carried across tests would hold
  // a token for a user that no longer exists.
  ws = makeCliWorkspace();
});

// ── fixtures ────────────────────────────────────────────────────────────────

interface LinkedProject {
  fx: WorkItemFixture;
  token: string;
  tokenId: string;
}

/** Mint a full-scope PAT for a fresh tenant (the CLI is an MCP client of the
 *  whole tool surface; scope gating is `tests/mcp/story-roundtrip`'s subject). */
async function mintToken(
  fx: WorkItemFixture,
  label = 'cli',
): Promise<{ token: string; id: string }> {
  const { token, dto } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label,
    scopes: [...TOKEN_SCOPES],
  });
  return { token, id: dto.id };
}

/** A tenant the CLI is logged in to and linked against — the starting state of
 *  almost every test below. */
async function linkedProject(): Promise<LinkedProject> {
  const fx = await makeWorkItemFixture();
  const { token, id } = await mintToken(fx);
  const login = await ws.run(['auth', 'login', '--server', server.url, '--token', token]);
  expect(login.exitCode).toBe(0);
  const link = await ws.run(['link', '--project', fx.projectIdentifier]);
  expect(link.exitCode).toBe(0);
  return { fx, token, tokenId: id };
}

/** Connect a repo to the workspace — the single registry a `targetRepo` pin
 *  validates against (the 7.10.3 installation mirror). */
async function connectRepo(fx: WorkItemFixture, name: string): Promise<void> {
  const inst = await db.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  await db.githubRepo.create({
    data: {
      installationId: inst.id,
      repoId: `repo-${name}-${Math.random().toString(36).slice(2, 10)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
}

interface LeafOptions {
  targetRepo?: string;
  type?: 'code' | 'manual';
  executor?: 'coding_agent' | 'human';
  descriptionMd?: string;
}

/** A ready (todo, unblocked, childless) leaf. */
async function leaf(
  fx: WorkItemFixture,
  title: string,
  opts: LeafOptions = {},
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, ...opts },
    fx.ctx,
  );
}

/** `from` is_blocked_by `to`. */
async function block(fx: WorkItemFixture, fromId: string, toId: string): Promise<void> {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);
}

/** Re-read an item's authoritative state (status + recorded session branch). */
async function stateOf(fx: WorkItemFixture, id: string): Promise<WorkItemDto> {
  return workItemsService.getWorkItem(id, fx.ctx);
}

/** A workspace wired for a session-branch run: a real repo checkout with a real
 *  on-disk origin, a fake `gh`, and a scripted agent. */
function repoRun(name: string): {
  repo: ReturnType<typeof makeLocalRepo>;
  gh: FakeGh;
  agent: FakeAgent;
} {
  return {
    repo: makeLocalRepo(ws.root, name),
    gh: installFakeGh(ws.binDir),
    agent: writeFakeAgent(join(ws.root, '.agent')),
  };
}

// ── auth + linking ──────────────────────────────────────────────────────────

describe('auth + linking', () => {
  it('stores a valid PAT and reports the owner; `auth status` reads it back live', async () => {
    const fx = await makeWorkItemFixture();
    const { token } = await mintToken(fx);

    const login = await ws.run(['auth', 'login', '--server', server.url, '--token', token]);
    expect(login.exitCode).toBe(0);
    expect(login.output).toContain(fx.owner.email);

    const status = await ws.run(['auth', 'status', '--server', server.url]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(fx.owner.email);
    expect(status.stdout).toContain(fx.workspace.name);
    // The stored secret is never echoed back in full.
    expect(status.stdout).not.toContain(token);
  });

  it('rejects an INVALID token at login and stores nothing', async () => {
    const login = await ws.run(['auth', 'login', '--server', server.url, '--token', 'not-a-token']);

    expect(login.exitCode).toBe(1);
    expect(login.stderr).toContain('Run `motir auth login`');

    const status = await ws.run(['auth', 'status', '--server', server.url]);
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain('Not logged in');
  });

  it('rejects a REVOKED token — the same uniform auth failure as an invalid one', async () => {
    const fx = await makeWorkItemFixture();
    const { token, id } = await mintToken(fx);
    await apiTokensService.revoke(fx.ownerId, id);

    const login = await ws.run(['auth', 'login', '--server', server.url, '--token', token]);

    expect(login.exitCode).toBe(1);
    expect(login.stderr).toContain('Run `motir auth login`');
  });

  it('errors with guidance when a command runs outside any linked folder', async () => {
    const fx = await makeWorkItemFixture();
    const { token } = await mintToken(fx);
    await ws.run(['auth', 'login', '--server', server.url, '--token', token]);

    for (const command of [['ready'], ['status'], ['next', '--print'], ['open', 'PROD-1']]) {
      const result = await ws.run(command);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No Motir project link found');
      expect(result.stderr).toContain('Run `motir link`');
    }
  });

  it('resolves `.motir.json` by walking UP from a subdirectory', async () => {
    const { fx } = await linkedProject();
    await leaf(fx, 'Visible from anywhere');
    const deep = ws.path('motir-core', 'lib', 'services');
    mkdirSync(deep, { recursive: true });

    const ready = await ws.run(['ready', '--json'], { cwd: deep });

    expect(ready.exitCode).toBe(0);
    expect(JSON.parse(ready.stdout)).toHaveLength(1);
  });
});

// ── read parity ─────────────────────────────────────────────────────────────

describe('read parity — the CLI never disagrees with the app about "ready"', () => {
  it('`motir ready --json` ≡ the list_ready tool ≡ the /ready set for the same user', async () => {
    const { fx } = await linkedProject();
    await leaf(fx, 'Alpha');
    await leaf(fx, 'Beta');
    const blocked = await leaf(fx, 'Gamma (blocked)');
    const blocker = await leaf(fx, 'Delta (the blocker)');
    await block(fx, blocked.id, blocker.id);

    const cli = await ws.run(['ready', '--json']);
    const cliKeys = (JSON.parse(cli.stdout) as { key: string }[]).map((i) => i.key);

    // The set `GET /api/ready` renders: that route is a thin caller of exactly
    // this service method (app/api/ready/route.ts), so this IS the page's set.
    const page = await workItemsService.listReady(fx.projectId, {}, fx.ctx);

    expect(cli.exitCode).toBe(0);
    expect(cliKeys).toEqual(page.items.map((i) => i.key));
    // …and the blocked item is in neither.
    expect(cliKeys).not.toContain(blocked.identifier);
    expect(cliKeys).toContain(blocker.identifier);
  });

  it('`motir status` reports the pulse, and refuses an unknown project', async () => {
    const { fx } = await linkedProject();
    await leaf(fx, 'One');

    const pulse = await ws.run(['status', '--json']);
    expect(pulse.exitCode).toBe(0);
    expect(JSON.parse(pulse.stdout)).toMatchObject({
      projectKey: fx.projectIdentifier,
      readyCount: 1,
    });

    // A link pointing at a project this token cannot see fails at link time —
    // the CLI never writes a binding it has not proven.
    const bad = await ws.run(['link', '--project', 'NOPE']);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('not accessible');
  });
});

// ── single dispatch ─────────────────────────────────────────────────────────

describe('single dispatch — motir next / run / done', () => {
  it('`next --print` claims the item and prints the SERVER prompt byte-identically', async () => {
    const { fx } = await linkedProject();
    const item = await leaf(fx, 'Print me', {
      type: 'code',
      descriptionMd: 'Do the work.\n\n## Acceptance criteria\n\n- It works\n',
    });

    const next = await ws.run(['next', '--print']);

    expect(next.exitCode).toBe(0);
    expect((await stateOf(fx, item.id)).status).toBe('in_progress');
    // The prompt is a pure function of server state, so the expected text can be
    // assembled independently and compared BYTE FOR BYTE — the contract that the
    // CLI assembles no prompt grammar of its own.
    const expected = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(next.stdout).toBe(expected.prompt);
    // Diagnostics go to stderr, so `motir next --print | pbcopy` pipes the prompt
    // and nothing else.
    expect(next.stderr).toContain('Dispatch:');
    expect(next.stderr).toContain(item.identifier);
  });

  it('reports nothing to do rather than failing when the ready set is empty', async () => {
    await linkedProject();

    const next = await ws.run(['next', '--print']);

    expect(next.exitCode).toBe(0);
    expect(next.stderr).toContain('No ready work items');
  });

  it('`next --agent` on a successful agent lands the item In Review', async () => {
    const { fx } = await linkedProject();
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    const item = await leaf(fx, 'Agent runs this', { type: 'code' });

    const next = await ws.run(['next', '--agent', agent.command]);

    expect(next.exitCode).toBe(0);
    expect((await stateOf(fx, item.id)).status).toBe('in_review');
    // BYOK's delivery contract: the prompt reaches the agent on BOTH channels.
    const [invocation] = agent.invocations();
    expect(invocation?.stdin).toContain(item.identifier);
    expect(invocation?.promptFromFile).toBe(invocation?.stdin);
    expect(invocation?.cwd).toBe(ws.root);
  });

  it('a FAILING agent leaves the item In Progress, exits with its code, and is skipped next time', async () => {
    const { fx } = await linkedProject();
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    agent.script([{ exit: 3 }]);
    const first = await leaf(fx, 'This one breaks', { type: 'code' });
    const second = await leaf(fx, 'The next one');

    const failed = await ws.run(['next', '--agent', agent.command]);

    expect(failed.exitCode).toBe(3);
    expect(failed.stderr).toContain('agent exited 3');
    expect((await stateOf(fx, first.id)).status).toBe('in_progress');

    // The exclude list is PERSISTED, so the next process moves past it.
    const nextUp = await ws.run(['next', '--print']);
    expect(nextUp.stderr).toContain('Skipping 1 previously-failed item');
    expect(nextUp.stdout).toContain(second.identifier);

    // …and `--reset` puts it back in the running (it is In Progress now, so the
    // reset is observable as the skip line disappearing).
    const reset = await ws.run(['next', '--print', '--reset']);
    expect(reset.stderr).toContain('Cleared 1 excluded item');
  });

  it('`run <key>` refuses a NOT-READY item by name, and dispatches it under --force', async () => {
    const { fx } = await linkedProject();
    const blocker = await leaf(fx, 'The blocker');
    const blocked = await leaf(fx, 'The blocked one');
    await block(fx, blocked.id, blocker.id);

    const refused = await ws.run(['run', blocked.identifier, '--print']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(`${blocked.identifier} is not ready`);
    expect(refused.stderr).toContain(blocker.identifier);
    expect(refused.stderr).toContain('--force');
    expect((await stateOf(fx, blocked.id)).status).toBe('todo');

    const forced = await ws.run(['run', blocked.identifier, '--print', '--force']);
    expect(forced.exitCode).toBe(0);
    expect(forced.stderr).toContain('dispatching anyway (--force)');
    expect((await stateOf(fx, blocked.id)).status).toBe('in_progress');
  });

  it('`done` rejects an illegal hop with the allowed targets, and completes via --via', async () => {
    const { fx } = await linkedProject();
    const item = await leaf(fx, 'Close me out');
    await ws.run(['run', item.identifier, '--print']);

    // in_progress → done is not an edge of the default workflow.
    const illegal = await ws.run(['done', item.identifier]);
    expect(illegal.exitCode).toBe(1);
    expect(illegal.stderr).toContain('In Review');
    expect(illegal.stderr).toContain('--via in_review');
    expect((await stateOf(fx, item.id)).status).toBe('in_progress');

    const done = await ws.run(['done', item.identifier, '--via', 'in_review']);
    expect(done.exitCode).toBe(0);
    expect((await stateOf(fx, item.id)).status).toBe('done');
  });

  it('`done` refuses a key AND --session together, and needs one of them', async () => {
    await linkedProject();

    const both = await ws.run(['done', 'PROD-1', '--session', 'motir/auto-1']);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain('not both');

    const neither = await ws.run(['done']);
    expect(neither.exitCode).toBe(1);
    expect(neither.stderr).toContain('A work item key is required');
  });
});

// ── repo routing: the two workspace shapes ──────────────────────────────────

describe('repo routing — where the agent actually runs', () => {
  it('EMPTY root: the scaffold item runs at the root, and the next one routes INTO the checkout it created', async () => {
    const { fx } = await linkedProject();
    await connectRepo(fx, 'motir-core');
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    // The bootstrap agent does what its prompt says: it creates the checkout.
    agent.script([{ create: 'motir-core' }, {}]);

    // The link binds with NO repo entries — checkouts resolve by convention.
    expect(readLinkFile(ws.root)).not.toHaveProperty('repos');

    const scaffold = await leaf(fx, 'Scaffold the repo', { targetRepo: 'motir-core' });
    const followUp = await leaf(fx, 'Then build in it', { targetRepo: 'motir-core' });

    const first = await ws.run(['run', scaffold.identifier, '--agent', agent.command]);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain('no "motir-core" checkout yet');
    expect(agent.invocations()[0]?.cwd).toBe(ws.root);
    expect(existsSync(ws.path('motir-core'))).toBe(true);

    const second = await ws.run(['run', followUp.identifier, '--agent', agent.command]);
    expect(second.exitCode).toBe(0);
    expect(agent.invocations()[1]?.cwd).toBe(ws.path('motir-core'));
    expect(second.stderr).toContain('motir-core checkout (convention)');
  });

  it('TWO-checkout root: each item is dispatched into ITS repo, and an unpinned one at the root', async () => {
    const { fx } = await linkedProject();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    mkdirSync(ws.path('motir-core'), { recursive: true });
    mkdirSync(ws.path('motir-ai'), { recursive: true });
    const agent = writeFakeAgent(join(ws.root, '.agent'));

    const core = await leaf(fx, 'A core item', { targetRepo: 'motir-core' });
    const ai = await leaf(fx, 'An AI item', { targetRepo: 'motir-ai' });
    // No pin, and TWO connected repos → the server says "I cannot say" rather
    // than guessing, and the CLI runs at the root.
    const unpinned = await leaf(fx, 'An unpinned item');

    await ws.run(['run', core.identifier, '--agent', agent.command]);
    await ws.run(['run', ai.identifier, '--agent', agent.command]);
    const last = await ws.run(['run', unpinned.identifier, '--agent', agent.command]);

    expect(agent.invocations().map((i) => i.cwd)).toEqual([
      ws.path('motir-core'),
      ws.path('motir-ai'),
      ws.root,
    ]);
    expect(last.stderr).toContain('the item pins no repo');
  });

  it('a bootstrap that produced NO checkout is reported as suspect — in `next` AND in `auto`', async () => {
    const { fx } = await linkedProject();
    await connectRepo(fx, 'motir-core');
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    // Exit 0, create nothing — the silent-failure shape a real agent can produce.
    agent.script([{ exit: 0 }]);
    const item = await leaf(fx, 'Scaffold that fails quietly', { targetRepo: 'motir-core' });

    const next = await ws.run(['run', item.identifier, '--agent', agent.command]);
    expect(next.stderr).toContain('Suspect dispatch');
    expect(next.stderr).toContain('motir link add motir-core');

    // In the unattended loop the same silence is a FAILED dispatch, not a
    // warning: every later item routed at that repo would repeat the bootstrap.
    const second = await leaf(fx, 'Another one for the same repo', { targetRepo: 'motir-core' });
    const auto = await ws.run(['auto', '--agent', agent.command, '--max', '1']);

    expect(auto.exitCode).toBe(1);
    expect(auto.stderr).toContain('bootstrap checkout missing');
    expect((await stateOf(fx, second.id)).status).toBe('in_progress');
  });
});

// ── the auto loop + session-branch integration ──────────────────────────────

describe('motir auto — the session-branch run', () => {
  it('cascades through the dependency chain, integrates onto ONE branch, and opens ONE pull request', async () => {
    const { fx } = await linkedProject();
    await connectRepo(fx, 'motir-core');
    const { repo, gh, agent } = repoRun('motir-core');
    agent.script([{ integrate: { file: 'a.txt' } }, { integrate: { file: 'b.txt' } }]);
    const mainBefore = repo.originMain();

    const a = await leaf(fx, 'A — the dependency', { targetRepo: 'motir-core', type: 'code' });
    const b = await leaf(fx, 'B — depends on A', { targetRepo: 'motir-core', type: 'code' });
    await block(fx, b.id, a.id);

    const auto = await ws.run(['auto', '--agent', agent.command]);
    expect(auto.exitCode).toBe(0);

    // THE CASCADE: B was NOT ready when the run started — only integrating A made
    // it so, and the loop's per-iteration `next_ready` re-query picked it up.
    const invocations = agent.invocations();
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.stdin).toContain(a.identifier);
    expect(invocations[1]?.stdin).toContain(b.identifier);

    const stateA = await stateOf(fx, a.id);
    const stateB = await stateOf(fx, b.id);
    const branch = stateA.sessionBranch;
    expect(branch).toMatch(/^motir\/auto-\d{8}-\d{6}$/);
    expect(stateA.status).toBe('in_review');
    expect(stateB.status).toBe('in_review');
    // B INHERITED the lineage: the server, not the CLI, put it on A's branch.
    expect(stateB.sessionBranch).toBe(branch);
    expect(invocations[1]?.stdin).toContain(`Integrate the commit into ${branch}`);

    // ONE pull request for the one repo the run touched.
    const prs = gh.pullRequests();
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ head: branch, base: 'main', cwd: repo.path });
    expect(prs[0]?.title).toContain('2 work items');
    expect(prs[0]?.body).toContain(a.identifier);
    expect(prs[0]?.body).toContain(b.identifier);
    // The close-out instruction, and the honest answer if the PR is REJECTED.
    expect(prs[0]?.body).toContain(`motir done --session ${branch}`);
    expect(prs[0]?.body).toContain('rejected');
    expect(auto.stderr).toContain('In Review — awaiting your merge (2)');

    // NO AUTO-MERGE: the branch exists on origin, `main` is exactly where it was,
    // and `gh pr merge` was never even attempted.
    expect(repo.hasBranchOnOrigin(branch as string)).toBe(true);
    expect(repo.originMain()).toBe(mainBefore);
    expect(gh.invocations().some((call) => call.args.join(' ').includes('pr merge'))).toBe(false);

    // The close-out round trip: every item on the branch → Done, branch cleared.
    const done = await ws.run(['done', '--session', branch as string]);
    expect(done.exitCode).toBe(0);
    expect(done.stderr).toContain('2 completed');
    for (const id of [a.id, b.id]) {
      const state = await stateOf(fx, id);
      expect(state.status).toBe('done');
      expect(state.sessionBranch).toBeNull();
    }
  });

  it('SKIPS what an agent cannot do — an unexpanded story and human work — and says so', async () => {
    const { fx } = await linkedProject();
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));

    const codeItem = await leaf(fx, 'Real work', { type: 'code' });
    const human = await leaf(fx, 'Sign the contract', { type: 'manual', executor: 'human' });
    // A childless story IS legitimately ready — it is a PLANNING item, not work.
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Unexpanded story' },
      fx.ctx,
    );

    const auto = await ws.run(['auto', '--agent', agent.command]);

    expect(agent.invocations()).toHaveLength(1);
    expect(agent.invocations()[0]?.stdin).toContain(codeItem.identifier);
    expect(auto.stderr).toContain('needs planning');
    expect(auto.stderr).toContain('needs a human');
    // A skipped item is NOT dispatched, so it is not transitioned either.
    expect((await stateOf(fx, story.id)).status).toBe('todo');
    expect((await stateOf(fx, human.id)).status).toBe('todo');
  });

  it('halts on the first agent failure, and continues past it under --keep-going', async () => {
    const { fx } = await linkedProject();
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    agent.script([{ exit: 2 }]);
    await leaf(fx, 'Breaks first', { type: 'code' });
    await leaf(fx, 'Breaks second', { type: 'code' });

    const halted = await ws.run(['auto', '--agent', agent.command]);
    expect(halted.exitCode).toBe(1);
    expect(agent.invocations()).toHaveLength(1);
    expect(halted.stderr).toContain('halted on the first agent failure');

    const kept = await ws.run(['auto', '--agent', agent.command, '--reset', '--keep-going']);
    // Both were attempted this time (the first is In Progress now, so the second
    // is the only ready one left — the run ends drained, not halted).
    expect(kept.stderr).toContain('the ready set is drained');
    expect(agent.invocations()).toHaveLength(2);
  });

  it('`--max` caps the run, and `--print` / a missing agent are refused with guidance', async () => {
    const { fx } = await linkedProject();
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    for (const title of ['One', 'Two', 'Three']) await leaf(fx, title, { type: 'code' });

    const capped = await ws.run(['auto', '--agent', agent.command, '--max', '2']);
    expect(agent.invocations()).toHaveLength(2);
    expect(capped.stderr).toContain('--max reached');

    const bad = await ws.run(['auto', '--agent', agent.command, '--max', 'lots']);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('--max must be a positive whole number');

    // `--print` is refused — an unattended loop has nobody to paste a prompt.
    // The flag IS registered on `auto` (program.ts) precisely so commander hands
    // it to `autoCommand`'s guard rather than rejecting it as unknown: the user
    // gets the sentence that says what to do instead, not a generic parse error
    // (MOTIR-1828). This asserts the guard's own text end-to-end through the
    // built binary, which is the only place the registration can be proven.
    const printed = await ws.run(['auto', '--print', '--agent', agent.command]);
    expect(printed.exitCode).toBe(1);
    expect(printed.stderr).toContain('`motir auto` cannot run in --print mode.');
    expect(printed.stderr).toContain('motir next --print');

    const agentless = await ws.run(['auto']);
    expect(agentless.exitCode).toBe(1);
    expect(agentless.stderr).toContain('needs an agent to run');
  });
});

describe('motir batch — the frozen snapshot', () => {
  // `batch` carried the IDENTICAL unregistered-`--print` defect (MOTIR-1830):
  // it merged after MOTIR-1828's fix, which was applied to `auto` alone. The
  // package suite now audits the registration for every command
  // (`optionRegistrationAudit.test.ts`); this is the same refusal proven through
  // the shipped binary, beside its `auto` twin above.
  it('`--print` is refused by the GUARD, not as an unknown option', async () => {
    await linkedProject();
    const printed = await ws.run(['batch', '--print', '--agent', 'echo']);
    expect(printed.exitCode).toBe(1);
    expect(printed.stderr).toContain('`motir batch` cannot run in --print mode.');
    expect(printed.stderr).toContain('motir next --print');
    expect(printed.stderr).not.toContain('unknown option');
  });
});

// ── the help surface (the 7.9.12 assembled check) ───────────────────────────

describe('help — against the BUILT binary', () => {
  /** `heading → command names`, parsed back out of the rendered overview. */
  function commandGroups(overview: string): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    let heading: string | undefined;
    for (const line of overview.split('\n')) {
      const title = /^([A-Z][A-Z ]*:)\s*$/.exec(line)?.[1];
      if (title !== undefined) {
        heading = title;
        if (title.endsWith('COMMANDS:') || title === 'HELP TOPICS:') groups.set(title, []);
        continue;
      }
      if (heading === undefined || !groups.has(heading)) continue;
      if (line.trim() === '') {
        heading = undefined;
        continue;
      }
      const item = /^ {2}(\S+)/.exec(line);
      if (item?.[1]) groups.get(heading)?.push(item[1]);
    }
    return groups;
  }

  it('`motir`, `motir help` and `motir --help` all exit 0 on STDOUT with the identical overview', async () => {
    const [bare, helpCommand, helpFlag] = await Promise.all([
      ws.run([]),
      ws.run(['help']),
      ws.run(['--help']),
    ]);

    for (const result of [bare, helpCommand, helpFlag]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('SETUP COMMANDS:');
    }
    expect(helpCommand.stdout).toBe(bare.stdout);
    expect(helpFlag.stdout).toBe(bare.stdout);
  });

  it('lists EVERY command the story shipped, each exactly once, under a group heading', async () => {
    const overview = (await ws.run(['help'])).stdout;
    const listed = [...commandGroups(overview).values()].flat();

    // This is the assertion the package's own unit tests cannot make: it reads
    // the REAL binary's help, so a later command subtask that forgets to declare
    // its group shows up here as a real command missing from real help.
    for (const command of [
      'auth',
      'link',
      'doctor',
      'ready',
      'status',
      'sprints',
      'sprint',
      'show',
      'open',
      'next',
      'run',
      'auto',
      'batch',
      'plan',
      'done',
      'help',
    ]) {
      expect(listed.filter((name) => name === command)).toEqual([command]);
    }
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('fails an unknown command with one line and a hint, not a stack trace', async () => {
    const bogus = await ws.run(['bogus']);

    expect(bogus.exitCode).toBe(1);
    expect(bogus.stderr).toContain('Unknown command "bogus"');
    expect(bogus.stderr).not.toContain('at Object');
  });
});

// ── attribution ─────────────────────────────────────────────────────────────

describe('attribution — every write lands as the PAT owner', () => {
  it('records the token owner in the revision trail for each transition', async () => {
    const { fx } = await linkedProject();
    const item = await leaf(fx, 'Walk the lifecycle');

    await ws.run(['run', item.identifier, '--print']);
    await ws.run(['done', item.identifier, '--via', 'in_review']);

    const revisions = await db.workItemRevision.findMany({
      where: { workItemId: item.id },
      orderBy: { changedAt: 'asc' },
    });
    // create + the three status hops the CLI drove.
    expect(revisions.length).toBeGreaterThanOrEqual(4);
    expect(new Set(revisions.map((r) => r.changedById))).toEqual(new Set([fx.ownerId]));
  });
});
