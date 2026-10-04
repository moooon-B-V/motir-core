import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunSchema } from '@/lib/api/v1/workLoop/schema';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { workItemsService } from '@/lib/services/workItemsService';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import {
  git,
  installFakeGh,
  makeCliWorkspace,
  makeLocalRepo,
  writeFakeAgent,
  type CliWorkspace,
  type FakeAgent,
} from '../helpers/cliHarness';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import { linkPrByIdentifier } from '../helpers/prLink';

// STORY E2E — MOTIR-7447 · MOTIR-7506: every leg of a run records the model that
// ran it, driven through the BUILT `motir` binary.
//
// The story has no screen, so its end-to-end flow is the CLI's: run a card, read
// the run back over v1, see the model on the leg. Everything between the agent
// and that read is real — the tsup bundle as a child process, `runAgent`'s own
// `$MOTIR_AGENT_REPORT` channel, the reporter, the v1 routes, Postgres. The agent
// is the harness's scripted fake: it writes its self-report file exactly as the
// prompt asks a real one to, or writes none.
//
// Every wait is on an authoritative signal: the CLI process's exit, the agent's
// own invocation log, and the run's closed status read from the API.

// Each test spawns the binary, and the `fix` case waits out one real CI poll
// interval (20s) between the fixing attempt and the green verdict.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const INSTALLATION_ID = 'inst-leg-model-e2e';
const REPO_PROVIDER_ID = '7506';
const REPO = 'acme';

let server: McpTestServer;
let ws: CliWorkspace;
let fx: WorkItemFixture;
let token: string;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  ws = makeCliWorkspace();
  fx = await makeWorkItemFixture();
  ({ token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'cli',
    fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
  }));
  expect((await ws.run(['auth', 'login', '--server', server.url, '--token', token])).exitCode).toBe(
    0,
  );
  expect((await ws.run(['link', '--project', fx.projectIdentifier])).exitCode).toBe(0);
});

async function card(title: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', type: 'code', title },
    fx.ctx,
  );
}

/** The one run of `command` that carried this card. */
async function runFor(workItemId: string, command: 'run' | 'fix') {
  const runs = await adminDb.dispatchRun.findMany({
    where: { command, cards: { some: { workItemId } } },
  });
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

/** The run as `GET /api/v1/dispatch-runs/{id}` returns it, parsed by the route's own schema. */
async function readRun(runId: string) {
  const res = await fetch(`${server.url}/api/v1/dispatch-runs/${runId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return dispatchRunSchema.parse(await res.json());
}

function agentAt(): FakeAgent {
  return writeFakeAgent(join(ws.root, '.agent'));
}

describe('motir run — the leg carries the model the agent reported', () => {
  it('an agent reporting "e2e-model-a" leaves it on the leg, and the run closes', async () => {
    const agent = agentAt();
    agent.script([{ report: { model: 'e2e-model-a' } }]);
    const item = await card('A card the agent names its model on');

    const ran = await ws.run(['run', item.identifier, '--agent', agent.command]);
    expect(ran.exitCode, ran.output).toBe(0);
    expect(agent.invocations()).toHaveLength(1);

    const run = await readRun((await runFor(item.id, 'run')).id);
    expect(run.status).toBe('succeeded');
    const leg = run.cards.find((c) => c.key === item.identifier);
    expect(leg).toMatchObject({ model: 'e2e-model-a', exitCode: 0 });
  });

  it('an agent that reports nothing leaves a null model, and the run still closes normally', async () => {
    const agent = agentAt();
    agent.script([{ exit: 0 }]);
    const item = await card('A card whose agent cannot tell');

    const ran = await ws.run(['run', item.identifier, '--agent', agent.command]);
    expect(ran.exitCode, ran.output).toBe(0);

    const run = await readRun((await runFor(item.id, 'run')).id);
    // Closed, and closed as a success: a missing model is not a failure.
    expect(run.status).toBe('succeeded');
    const leg = run.cards.find((c) => c.key === item.identifier);
    expect(leg).toMatchObject({ model: null, exitCode: 0 });
  });
});

describe('motir fix — the repair leg carries the model of the agent that fixed it', () => {
  const PR = 31;

  const checkSuite = (conclusion: 'failure' | 'success', headSha: string) =>
    githubWebhookService.handleEvent('check_suite', {
      action: 'completed',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      check_suite: {
        head_sha: headSha,
        head_branch: null,
        status: 'completed',
        conclusion,
        app: { slug: 'github-actions' },
        pull_requests: [{ number: PR }],
      },
    });

  /** A card whose run ended with its pull request open, and whose build then went red. */
  async function redCard() {
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: INSTALLATION_ID,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: REPO_PROVIDER_ID,
          owner: 'moooon',
          name: REPO,
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    const item = await card('A card whose build went red');
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    const headRef = `subtask/${item.identifier}-work`;

    // The pull request's branch, really on origin — `motir fix` checks it out.
    const repo = makeLocalRepo(ws.root, REPO);
    git(repo.path, 'checkout', '-b', headRef);
    git(repo.path, 'commit', '--allow-empty', '-m', 'feat: the work');
    git(repo.path, 'push', 'origin', headRef);
    git(repo.path, 'checkout', 'main');

    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: REPO,
      number: PR,
      headRef,
      title: item.title,
    });
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: PR,
        state: 'open',
        merged: false,
        title: item.title,
        head: { ref: headRef },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    await checkSuite('failure', 'sha-red');
    expect((await workItemsService.getWorkItem(item.id, fx.ctx)).status).toBe('implemented');
    return item;
  }

  it('the fixing agent reporting "e2e-model-b" leaves it, and its exit code, on the leg', async () => {
    installFakeGh(ws.binDir);
    const agent = agentAt();
    agent.script([{ report: { model: 'e2e-model-b' } }]);
    const item = await redCard();

    const fixing = ws.run(['fix', item.identifier, '--agent', agent.command]);

    // The fixing attempt has run (the agent's own log says so); its push is what
    // CI judges next, and the build goes green on the new head.
    await expect.poll(() => agent.invocations().length, { timeout: 30_000 }).toBe(1);
    await checkSuite('success', 'sha-green');

    const fixed = await fixing;
    expect(fixed.exitCode, fixed.output).toBe(0);

    const run = await readRun((await runFor(item.id, 'fix')).id);
    expect(run.status).toBe('succeeded');
    const leg = run.cards.find((c) => c.key === item.identifier);
    expect(leg).toMatchObject({ model: 'e2e-model-b', exitCode: 0 });
  });
});
