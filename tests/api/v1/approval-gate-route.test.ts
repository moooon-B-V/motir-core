import { beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { GET } from '@/app/api/v1/work-items/[key]/approval-gate/route';
import { approvalGateRecordSchema } from '@/lib/api/v1/workItems/schema';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { computeGateStamp } from '@/lib/approvalGates/stamp';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// `GET /api/v1/work-items/{key}/approval-gate` (Bug MOTIR-6191) — the one door a
// DISPATCHED agent has onto a gate's decision record, because it speaks
// `/api/v1` and nothing else.
//
// What this file asserts is what only this layer can be wrong about: that the
// note reaches a BEARER token at all (the whole defect), the permission it
// asserts, the `gate: null`-is-an-answer distinction, the 404-not-403 answer, the
// 422 on a kind it cannot parse, the no-store header, and that the body is the
// declared schema's output rather than a service DTO. WHICH gate wins and what a
// key means are `approvalGateAccessService`'s, driven in its own suite.
//
// ⚠️ THE FIXTURE RAISES ITS GATES DIRECTLY, as the gate suites do
// (`tests/approval-gate-read.test.ts`, `tests/integration/approvals/refusalReasonSeam.test.ts`):
// a row plus a real `decide` is the whole substrate this read has, and going
// through each kind's own publisher would test the publishers.

const BASE = 'http://localhost:3000/api/v1';

let caller: V1ProjectCaller;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  caller = await createV1ProjectCaller();
});

/** A card carrying one `awaiting` gate of `kind`, plus the stamp its reader saw. */
async function cardWithGate(kind: ApprovalGateKind, title = 'Decide this') {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.ctx,
  );
  // Somewhere approval can legally take it — the walk the gate suites make for
  // the same reason: from `todo` a decision's own effect raises
  // `IllegalTransitionError`, which would fail this suite for a reason that has
  // nothing to do with reading a note.
  await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', caller.ctx);
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: caller.fixture.workspaceId,
      projectId: caller.fixture.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${item.id}-${kind}`,
      subjectVersion: 'v1',
      state: 'awaiting',
    },
  });
  const stamp = computeGateStamp({
    subjectVersion: 'v1',
    companionSubjectVersion: null,
    descriptionMd: item.descriptionMd ?? null,
  });
  return { item, gate, stamp };
}

const req = (url: string, headers: Record<string, string>) => new Request(url, { headers });

const call = (key: string, query: string, headers = caller.headers) =>
  GET(req(`${BASE}/work-items/${key}/approval-gate${query}`, headers), {
    params: Promise.resolve({ key }),
  });

describe('GET /api/v1/work-items/{key}/approval-gate', () => {
  it('⚠️ THE DEFECT: a REQUEST-CHANGES note reaches a bearer token', async () => {
    // The whole bug in one assertion. Before this route the note was reachable
    // only from a session, so the agent that raised the question — on
    // `decision_approval`, ALWAYS an agent (ADR §8's FIFTH AMENDMENT) — could not
    // read the answer with any credential it holds.
    const { item, gate, stamp } = await cardWithGate('decision_approval');
    await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        noteMd: 'The record does not say what happens when the session has no turns.',
        source: 'ui',
        stamp,
      },
      caller.ctx,
    );

    const res = await call(item.identifier, '?kind=decision_approval');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      workItemKey: item.identifier,
      kind: 'decision_approval',
      gate: {
        state: 'changes_requested',
        noteMd: 'The record does not say what happens when the session has no turns.',
        decisionSource: 'ui',
        subjectVersion: 'v1',
      },
    });
    expect(body.gate.decidedByLabel).not.toBeNull();
    expect(Date.parse(body.gate.decidedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('the body is the DECLARED schema’s output, and carries no render machinery', async () => {
    const { item } = await cardWithGate('design_result');

    const res = await call(item.identifier, '?kind=design_result');
    const body = await res.json();

    // Parses against the schema the OpenAPI document publishes — a mapper that
    // drifted from its own declaration fails here rather than reaching a client.
    expect(() => approvalGateRecordSchema.parse(body)).not.toThrow();
    // The projection is deliberate: `canDecide` would only mislead a caller that
    // may never decide, and a stamp is handed back with a PRESS this API has no
    // door for.
    expect(body.gate).not.toHaveProperty('canDecide');
    expect(body.gate).not.toHaveProperty('stamp');
    expect(body.gate).not.toHaveProperty('subjectId');
  });

  it('an AWAITING gate carries no decision and names who it waits on', async () => {
    const { item } = await cardWithGate('design_result');

    const body = await (await call(item.identifier, '?kind=design_result')).json();

    expect(body.gate).toMatchObject({ state: 'awaiting', noteMd: null, decidedAt: null });
    // A null here is *not yet decided*, never *decided by nobody* — which is why
    // the routed-to name is served beside it.
    expect(body.routedToLabel).not.toBeNull();
  });

  it('a card with NO gate of that kind is a 200 with `gate: null`, never a 404', async () => {
    // The distinction the whole read rests on: *your key was wrong* and *nothing
    // was ever asked here* are different answers, and collapsing them would tell
    // an agent to go looking for a key that is perfectly correct.
    const { item } = await cardWithGate('design_result');

    const res = await call(item.identifier, '?kind=acceptance_result');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ kind: 'acceptance_result', gate: null, routedToLabel: null });
  });

  it('reads an UNREGISTERED kind’s historical row — a record needs no port', async () => {
    // `pull_request_merge` is built and withdrawn, so no surface DRAWS one. Its
    // rows are still the audit artefact §6a describes, and refusing to read one
    // would hide history from a caller entitled to it.
    const { item, gate } = await cardWithGate('pull_request_merge');

    const body = await (await call(item.identifier, '?kind=pull_request_merge')).json();

    expect(body.gate).toMatchObject({ id: gate.id, kind: 'pull_request_merge' });
  });

  it('a key in ANOTHER workspace is the same 404 as one that never existed', async () => {
    const { item } = await cardWithGate('design_result');
    const outsider = await createV1ProjectCaller({
      workspaceName: 'Rival',
      identifier: 'ZZZ',
    });

    const res = await call(item.identifier, '?kind=design_result', outsider.headers);

    // Never a 403: that would confirm the card exists in a tenant the caller has
    // no business knowing about.
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('WORK_ITEM_NOT_FOUND');
  });

  it('a MISSING or unknown `kind` is a 422 naming the vocabulary', async () => {
    const { item } = await cardWithGate('design_result');

    for (const query of ['', '?kind=', '?kind=not_a_gate_kind']) {
      const res = await call(item.identifier, query);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_GATE_KIND');
      expect(body.error).toContain('decision_approval');
    }
  });

  it('a key that is not a key at all is the same 404', async () => {
    // No project prefix to derive, so there is nothing to resolve. It answers the
    // not-found every other unresolvable key answers rather than a 422: the
    // segment is a KEY, and a caller cannot tell a mistyped one from a deleted
    // card anyway — which is the existence contract, not a shortcoming.
    const res = await call('nokey', '?kind=design_result');

    expect(res.status).toBe(404);
  });

  it('serves `private, no-store` — a gate’s state changes under the reader', async () => {
    const { item } = await cardWithGate('design_result');

    const res = await call(item.identifier, '?kind=design_result');

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('a token WITHOUT `project:browse` is refused', async () => {
    // The gate is the browse permission and nothing else — no decide key is
    // asserted, and none should be: this reads a decision, it does not make one.
    const { item } = await cardWithGate('design_result');
    const narrow = await createV1ProjectCaller({ permissions: ['comment:add'] });

    const res = await GET(
      req(`${BASE}/work-items/${item.identifier}/approval-gate?kind=design_result`, narrow.headers),
      { params: Promise.resolve({ key: item.identifier }) },
    );

    expect(res.status).toBe(403);
  });

  it('accepts a lower-case key, like every other key-addressed read', async () => {
    const { item } = await cardWithGate('design_result');

    const res = await call(item.identifier.toLowerCase(), '?kind=design_result');

    expect(res.status).toBe(200);
    expect((await res.json()).workItemKey).toBe(item.identifier);
  });
});
