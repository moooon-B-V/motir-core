import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { foldersService } from '@/lib/services/foldersService';
import { plansService } from '@/lib/services/plansService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { makeCliWorkspace, writeFakeAgent, type CliWorkspace } from '../helpers/cliHarness';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';

// MOTIR-8698 · row 4 of `run-found-trigger-dispatched-path.md` AMENDMENT 1 — a CLI
// dispatch whose agent has NO Motir MCP still files the planning bug.
//
// Driven through the BUILT `motir` binary. The agent is the harness's scripted fake:
// it calls no Motir tool at all — it has none — and does only what the prompt's STOP
// step 4 tells an agent with `$MOTIR_AGENT_REPORT` to do: it writes its reason into
// that file as `unbuildable`. Everything after that is real: `runAgent` reads the
// file, the leg posts `POST /api/v1/dispatch-runs/{id}/unbuildable` with the CLI's
// own credential, and the server files ONE bug into Motir's planner-bug home.
//
// Every wait is on an authoritative signal: the CLI process's exit, then rows.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const REASON = 'SENTINEL-REASON: the card names a table that does not exist';

let server: McpTestServer;
let ws: CliWorkspace;

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
  ws = makeCliWorkspace();
});

/** Motir's own tenant: the meta project, its planner-bug folder and the system principal. */
async function makeMeta(): Promise<{ fx: WorkItemFixture; planningFolderId: string }> {
  const fx = await makeWorkItemFixture({ name: 'moooon', identifier: 'MOTIR' });
  const planning = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name: 'Planning bugs' },
    fx.ctx,
  );
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { plannerBugDestinationFolderId: planning.id },
  });
  await seedSystemPrincipal({ workspaceId: fx.workspaceId, projectId: fx.projectId });
  return { fx, planningFolderId: planning.id };
}

/** A card an approved NATIVE plan shaped, untouched since. */
async function nativeCard(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: 'A plan',
      authorSource: 'native',
      authorHarness: 'Motir',
      authorModel: 'motir-planner',
    },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A planned card', kind: 'task', type: 'code' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  const row = await adminDb.planItem.findFirstOrThrow({ where: { planId: plan.id, op: 'add' } });
  return adminDb.workItem.findUniqueOrThrow({ where: { id: row.workItemId! } });
}

describe('motir run — an agent with no Motir MCP still reports the unbuildable card', () => {
  it('the CLI posts the report with its own credential, and ONE planning bug lands in Motir’s home', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'cli',
      fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
    });
    expect(
      (await ws.run(['auth', 'login', '--server', server.url, '--token', token])).exitCode,
    ).toBe(0);
    expect((await ws.run(['link', '--project', fx.projectIdentifier])).exitCode).toBe(0);
    const item = await nativeCard(fx);

    const agent = writeFakeAgent(join(ws.root, '.agent'));
    agent.script([{ report: { model: 'e2e-model', unbuildable: REASON } }]);
    const ran = await ws.run(['run', item.identifier, '--agent', agent.command]);
    expect(agent.invocations(), ran.output).toHaveLength(1);
    // The prompt the agent was handed tells it to use the file, not a tool.
    const prompt = agent.invocations()[0]!.stdin;
    expect(prompt).toContain('"unbuildable": "<the SAME text as your step-3 comment>"');

    const legs = await adminDb.dispatchRunCard.findMany({ where: { workItemId: item.id } });
    expect(legs).toHaveLength(1);
    const reports = await adminDb.runFoundReport.findMany({
      where: { dispatchRunCardId: legs[0]!.id },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: 'filed' });

    const bugs = await adminDb.workItem.findMany({
      where: { projectId: meta.fx.projectId, kind: 'bug' },
    });
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.folderId).toBe(meta.planningFolderId);
    expect(reports[0]!.filedWorkItemId).toBe(bugs[0]!.id);

    // The reason stays on the tenant's leg; nothing is filed into the tenant.
    const events = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunCardId: legs[0]!.id, kind: 'unbuildable_reported' },
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.data as Record<string, unknown>)['reason']).toBe(REASON);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId, kind: 'bug' } })).toBe(
      0,
    );
  });

  it('an agent that built the card and reported only its model files nothing', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'cli',
      fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
    });
    expect(
      (await ws.run(['auth', 'login', '--server', server.url, '--token', token])).exitCode,
    ).toBe(0);
    expect((await ws.run(['link', '--project', fx.projectIdentifier])).exitCode).toBe(0);
    const item = await nativeCard(fx);

    const agent = writeFakeAgent(join(ws.root, '.agent'));
    agent.script([{ report: { model: 'e2e-model' } }]);
    await ws.run(['run', item.identifier, '--agent', agent.command]);
    expect(agent.invocations()).toHaveLength(1);

    expect(await adminDb.runFoundReport.count()).toBe(0);
    expect(
      await adminDb.workItem.count({ where: { projectId: meta.fx.projectId, kind: 'bug' } }),
    ).toBe(0);
  });
});
