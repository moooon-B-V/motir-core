import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { workflowsService } from '@/lib/services/workflowsService';
import { mintJobToken } from '@/lib/ai/jobToken';
import { GET as terminalStatusesGET } from '@/app/api/internal/ai/terminal-statuses/route';
import { makeWorkItemFixture as makeFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST — `GET /api/internal/ai/terminal-statuses` (MOTIR-4158), the
// ai→core read that answers WHICH STATUSES MEAN FINISHED on the token's project.
// Driven end to end through the REAL route against a real Postgres, in the shape
// `readbackRoutes.test.ts` / `pendingPlansRoute.test.ts` established for this
// family.
//
// ⚠️ THE ARM THAT MATTERS IS THE NON-DEFAULT STATUS. Every positive case that
// only reads a fresh project's workflow passes just as well against a route that
// returns the literal `['cancelled', 'done']` — which is a hair's breadth from
// the very defect this endpoint exists to end, one repository over. So the
// derivation is asserted from BOTH sides: a status the project ADDS in the
// `done` category must appear, and a status it adds in another category must
// not. Only those two can fail on a hardcoded answer.
//
// ⚠️ AND `cancelled` IS ASSERTED BY NAME. It is not merely one member of the
// default set: it is the member today's consumer misses, so an assertion that
// happens to cover it as part of a sorted array would still let a regression
// that drops it read as an ordering change. It gets its own line.

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  // Truncating `workspace` CASCADE takes the projects with it, and their
  // workflow statuses with those — which is the whole of this suite's state.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

function terminalStatusesReq(opts: { bearer?: string; token?: string; cookie?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  return new Request('http://core/api/internal/ai/terminal-statuses', { headers });
}

function tokenFor(fx: WorkItemFixture): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

async function readTerminal(fx: WorkItemFixture): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await terminalStatusesGET(
    terminalStatusesReq({ bearer: SERVICE_SECRET, token: tokenFor(fx) }),
  );
  return { status: res.status, body: await res.json() };
}

/** Add a status to the fixture project's workflow, as its owner (a project admin). */
async function addStatus(
  fx: WorkItemFixture,
  key: string,
  category: 'todo' | 'in_progress' | 'done',
): Promise<void> {
  await workflowsService.createStatus({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
    key,
    label: key,
    category,
  });
}

describe('GET /api/internal/ai/terminal-statuses — the project’s terminal set', () => {
  it('returns the default workflow’s terminal keys, sorted', async () => {
    const fx = await makeFixture();
    const { status, body } = await readTerminal(fx);
    expect(status).toBe(200);
    expect(body['terminalStatusKeys']).toEqual(['cancelled', 'done']);
  });

  // ⚠️ THE MEMBER THE CONSUMER MISSED, asserted on its own line. `isDoneStatus()`
  // answered this question with `=== 'done'`, so a `cancelled` card read as
  // mutable and was offered to the planner as something it could still re-scope.
  it('carries `cancelled` for the default workflow', async () => {
    const fx = await makeFixture();
    const { body } = await readTerminal(fx);
    expect(body['terminalStatusKeys']).toContain('cancelled');
  });

  // ⚠️ THE DERIVATION, POSITIVE HALF. A project that defines its own
  // done-category status must see it in the answer — which no hardcoded pair can
  // produce, and which is the whole reason the set comes from
  // `getTerminalStatusKeys` rather than from a literal.
  it('carries a NON-DEFAULT status the project defines in the `done` category', async () => {
    const fx = await makeFixture();
    await addStatus(fx, 'shipped', 'done');
    const { status, body } = await readTerminal(fx);
    expect(status).toBe(200);
    expect(body['terminalStatusKeys']).toEqual(['cancelled', 'done', 'shipped']);
  });

  // ⚠️ THE DERIVATION, NEGATIVE HALF. The predicate is the CATEGORY, so a status
  // added anywhere else must not appear — otherwise "derived from the workflow"
  // would be satisfied by returning every status the project has, which is a
  // different and equally wrong answer.
  it('excludes a status the project defines OUTSIDE the `done` category', async () => {
    const fx = await makeFixture();
    await addStatus(fx, 'awaiting_qa', 'in_progress');
    await addStatus(fx, 'icebox', 'todo');
    const { body } = await readTerminal(fx);
    expect(body['terminalStatusKeys']).toEqual(['cancelled', 'done']);
  });

  it('401s a missing job token', async () => {
    await makeFixture();
    const res = await terminalStatusesGET(terminalStatusesReq({ bearer: SERVICE_SECRET }));
    expect(res.status).toBe(401);
  });

  it('401s a tampered token', async () => {
    const fx = await makeFixture();
    const [payload] = tokenFor(fx).split('.');
    const res = await terminalStatusesGET(
      terminalStatusesReq({ bearer: SERVICE_SECRET, token: `${payload}.deadbeef` }),
    );
    expect(res.status).toBe(401);
  });

  it('401s an expired token', async () => {
    const fx = await makeFixture();
    const expired = mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
      ttlSeconds: -1,
    });
    const res = await terminalStatusesGET(
      terminalStatusesReq({ bearer: SERVICE_SECRET, token: expired }),
    );
    expect(res.status).toBe(401);
  });

  // The route is service-to-service ONLY. Neither credential a human-facing
  // caller holds is one of the two this surface takes: a workspace PAT presented
  // as the `Authorization` bearer is not `CORE_CALLBACK_SECRET`, and a cookie
  // session is never read here at all.
  it('401s a workspace PAT in the Authorization header', async () => {
    const fx = await makeFixture();
    const res = await terminalStatusesGET(
      terminalStatusesReq({
        bearer: 'motir_pat_a_perfectly_real_looking_token',
        token: tokenFor(fx),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('401s a cookie session, with or without a job token', async () => {
    const fx = await makeFixture();
    const withToken = await terminalStatusesGET(
      terminalStatusesReq({ cookie: 'better-auth.session_token=whatever', token: tokenFor(fx) }),
    );
    expect(withToken.status).toBe(401);
    const bare = await terminalStatusesGET(
      terminalStatusesReq({ cookie: 'better-auth.session_token=whatever' }),
    );
    expect(bare.status).toBe(401);
  });

  // ⚠️ TENANCY, AND THE REASON IT IS NOT INFERABLE FROM THE ANSWER.
  // `workflowsService.getTerminalStatusKeys` returns an EMPTY SET for a foreign
  // project rather than throwing, so a route without the browse gate would
  // answer a cross-tenant token `200 { terminalStatusKeys: [] }` — a leak wearing
  // the shape of a valid reply. The refusal must be the neighbours' 404, and the
  // body must carry nothing about the other project.
  it('404s a foreign-project token, and its body names nothing of that project', async () => {
    const a = await makeFixture();
    const b = await makeFixture({ name: 'Other', identifier: 'OTHR' });
    await addStatus(b, 'archived_elsewhere', 'done');
    // A's user, but a token claiming B's project (which A cannot browse).
    const foreign = mintJobToken({
      userId: a.ctx.userId,
      workspaceId: a.ctx.workspaceId,
      projectId: b.projectId,
    });
    const res = await terminalStatusesGET(
      terminalStatusesReq({ bearer: SERVICE_SECRET, token: foreign }),
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('terminalStatusKeys');
    expect(body).not.toContain('archived_elsewhere');
  });
});

describe('aiBoundaryService.readTerminalStatuses — the set is the SERVICE’s answer', () => {
  // ⚠️ PINNED TO THE SERVICE, NOT TO A LIST. The endpoint's contract is not "these
  // two keys" — it is "whatever `getTerminalStatusKeys` says", because that is the
  // same call `lib/plans/validateProposals.ts` step 4 makes and the two must not be
  // able to disagree. Asserted against the service itself so a future workflow
  // change moves both together or fails here.
  it('is exactly `workflowsService.getTerminalStatusKeys`, whatever the project defines', async () => {
    const fx = await makeFixture();
    await addStatus(fx, 'shipped', 'done');
    await addStatus(fx, 'awaiting_qa', 'in_progress');

    const viaBoundary = await aiBoundaryService.readTerminalStatuses(fx.projectId, fx.ctx);
    const viaService = await workflowsService.getTerminalStatusKeys(
      fx.projectId,
      fx.ctx.workspaceId,
    );
    expect(viaBoundary.terminalStatusKeys).toEqual([...viaService].sort());
    expect(viaBoundary.terminalStatusKeys).toEqual(['cancelled', 'done', 'shipped']);
  });

  it('takes no status argument — a caller cannot ask for a different notion of terminal', () => {
    // The service signature is (projectId, ctx): there is nowhere to pass a
    // category, a key list, or a project other than the token's own, which is
    // the whole of "one decision, in one place".
    expect(aiBoundaryService.readTerminalStatuses.length).toBe(2);
  });
});
