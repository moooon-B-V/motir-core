import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { parseChoiceOptions } from '@/lib/approvalGates/choiceOptions';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// THE STORY'S motir-core GATE (Story MOTIR-4914 · Subtask MOTIR-5898) — the seam the
// per-subtask suites each saw only a slice of, run whole on real Postgres with no
// unit's mocks: a body → the parse → the raise → `choose` through the REAL decide
// route → `done`, the stamped record, and the two edits (after the decision, which
// must change nothing; before it, which must re-ask). Then the guards coverage
// cannot see: authority, and tenancy.

const signedIn = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  signedIn.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const BODY = [
  '## Question',
  'Where do exported reports live?',
  '## Why this is a choice',
  '**Situation:** contradicts your decision',
  '**You said:** "Keep every export forever."',
  'Research found the retention law caps it at seven years.',
  '## Options',
  '### Seven years, then delete',
  '**Best if you want:** less to operate',
  'The law’s own ceiling.',
  '### Keep, but anonymise after seven',
  '**Best if you want:** more customisable later',
  'The data stays useful.',
  '## What this choice gates',
  'The retention story.',
].join('\n');

async function createChoice(descriptionMd = BODY, ctx = fx.ctx, projectId = fx.projectId) {
  return workItemsService.createWorkItem(
    {
      projectId,
      kind: 'task',
      title: 'Choose how long exports live',
      type: 'choice',
      executor: 'human',
      descriptionMd,
    },
    ctx,
  );
}

const choiceGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'decision_choice' },
    orderBy: { createdAt: 'asc' },
  });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

function decide(gateId: string, body: Record<string, unknown>) {
  return decideRoute(
    new Request(`http://localhost/api/approval-gates/${gateId}/decide`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: gateId }) },
  );
}

async function readGate(workItemId: string, ctx = fx.ctx) {
  return approvalGatesService.getForWorkItem({ workItemId, kind: 'decision_choice' }, ctx);
}

describe('the SEAM — body → parse → raise → choose → done', () => {
  it('raises at the parser’s stamp, routed, in review; choosing stamps exactly what the parser returned', async () => {
    const parsed = parseChoiceOptions(BODY);
    if (!parsed.ok) throw new Error('fixture body must parse');
    const item = await createChoice();

    const [gate] = await choiceGates(item.id);
    expect(gate).toMatchObject({
      state: 'awaiting',
      subjectVersion: parsed.subjectVersion,
      routedToId: fx.ownerId,
    });
    expect(await statusOf(item.id)).toBe('in_review');

    const { stamp } = await readGate(item.id);
    const option = parsed.options[1]!;
    const res = await decide(gate!.id, { decision: 'choose', optionId: option.id, stamp });
    expect(res.status).toBe(200);

    expect(await statusOf(item.id)).toBe('done');
    const decided = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
    expect(decided).toMatchObject({ state: 'approved', outcomeRef: option.id });
    expect(decided.chosenOption).toEqual({
      optionId: option.id,
      label: option.label,
      bestFor: option.bestFor,
      followUp: parsed.followUpMd,
      situation: parsed.why.situation,
    });

    // AN EDIT AFTER THE DECISION changes nothing on the record — and asks nothing,
    // because the item is done.
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: BODY.replace('The law’s own ceiling.', 'Changed later.') },
      fx.ctx,
    );
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
    expect(after.chosenOption).toEqual(decided.chosenOption);
    expect(after.outcomeRef).toBe(option.id);
    expect((await choiceGates(item.id)).map((g) => g.state)).toEqual(['approved']);
  });

  it('an edit BEFORE the decision supersedes the question and asks it again', async () => {
    const item = await createChoice();
    await workItemsService.updateWorkItem(
      item.id,
      {
        descriptionMd: BODY.replace('The data stays useful.', 'The data stays useful, anonymised.'),
      },
      fx.ctx,
    );
    const gates = await choiceGates(item.id);
    expect(gates.map((g) => g.state)).toEqual(['superseded', 'awaiting']);
    expect(gates[0]!.supersededCause).toBe('republished');
  });
});

describe('the GUARDS coverage cannot see', () => {
  it('a `type: decision` work item of EITHER executor raises no choice gate', async () => {
    for (const executor of ['human', 'coding_agent'] as const) {
      const item = await workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: `Decide ${executor}`,
          type: 'decision',
          executor,
          descriptionMd: BODY,
        },
        fx.ctx,
      );
      expect(await choiceGates(item.id)).toHaveLength(0);
    }
  });

  it('a defective body raises none, and the item page carries the reason', async () => {
    const item = await createChoice(BODY.replace(/## What this choice gates[\s\S]*$/, ''));
    expect(await choiceGates(item.id)).toHaveLength(0);
    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);
    expect(detail.choiceBody).toMatchObject({
      ok: false,
      defects: [{ reason: 'no_follow_up_section' }],
    });
  });

  it('a reader without authority sees canDecide: false, and their choose is refused', async () => {
    const item = await createChoice();
    const member = await createTestUser({ email: 'member@ex.com', name: 'Member' });
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: member.id,
      role: 'member',
    });
    const memberCtx = { userId: member.id, workspaceId: fx.workspaceId };
    const read = await readGate(item.id, memberCtx);
    expect(read.canDecide).toBe(false);

    signedIn.current = memberCtx;
    const [gate] = await choiceGates(item.id);
    const res = await decide(gate!.id, {
      decision: 'choose',
      optionId: 'seven-years-then-delete',
      stamp: read.stamp,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'APPROVAL_GATE_NOT_AUTHORISED' });
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('the immutability trigger refuses a chosenOption write after the decision', async () => {
    const item = await createChoice();
    const [gate] = await choiceGates(item.id);
    const { stamp } = await readGate(item.id);
    await decide(gate!.id, { decision: 'choose', optionId: 'seven-years-then-delete', stamp });
    await expect(
      adminDb.approvalGate.update({ where: { id: gate!.id }, data: { chosenOption: {} } }),
    ).rejects.toThrow(/AG_DECIDED_IMMUTABLE/);
  });

  it('CROSS-TENANT — a choice in one workspace is invisible to another’s routing read and decide route', async () => {
    const item = await createChoice();
    const [gate] = await choiceGates(item.id);
    const { stamp } = await readGate(item.id);

    const theirs = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTH' });
    const theirCtx = { ...theirs.ctx, projectId: theirs.projectId };
    expect((await approvalGatesService.listAwaitingMe(theirCtx)).total).toBe(0);

    signedIn.current = { userId: theirs.ownerId, workspaceId: theirs.workspaceId };
    const res = await decide(gate!.id, {
      decision: 'choose',
      optionId: 'seven-years-then-delete',
      stamp,
    });
    expect(res.status).toBe(404);
    expect(await statusOf(item.id)).toBe('in_review');
  });
});
