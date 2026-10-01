import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { boardsService } from '@/lib/services/boardsService';
import { componentsService } from '@/lib/services/componentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  PERSON_FALLBACK_LABEL,
  personDisplayName,
  personName,
  toPersonLabel,
} from '@/lib/people/personLabel';
import { visitorServiceContext } from '@/lib/visitor/context';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { resolvableGateSubject } from '../helpers/resolvableGateSubject';
import { consentedVisitor } from './_consentedVisitor';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// A Visitor sees names, never emails (Story MOTIR-6170 · MOTIR-6646). Every
// payload a Visitor reads through the real resolver and datastore is serialised
// and scanned: no `@`, no email local part, and a person with no name reads as
// the neutral label. A member's payloads are unchanged — they keep the email
// where they carried it.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('toPersonLabel / personName / personDisplayName', () => {
  it('uses the trimmed name, else the neutral label — never any part of an email', () => {
    expect(toPersonLabel({ id: 'u1', name: '  Ada  ' })).toEqual({ id: 'u1', name: 'Ada' });
    for (const name of [null, '', '   ']) {
      const label = toPersonLabel({ id: 'u2', name });
      expect(label.name).toBe(PERSON_FALLBACK_LABEL);
      expect(label.name).not.toContain('@');
      expect(personName(name)).toBe(PERSON_FALLBACK_LABEL);
    }
    // A client object that still carries an email is never read for it.
    const withEmail = { name: '', email: 'hidden-local@example.com' };
    expect(personDisplayName(withEmail)).toBe(PERSON_FALLBACK_LABEL);
    expect(personDisplayName(withEmail, '项目成员')).toBe('项目成员');
    expect(personDisplayName(null)).toBe(PERSON_FALLBACK_LABEL);
  });
});

let seq = 0;

async function fixture() {
  const identifier = `VN${seq++}`;
  const fx = await makeWorkItemFixture({ name: `VN ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: projectAccessData('public'),
  });
  const ada = await adminDb.user.create({
    data: { email: `ada-${identifier}@example.com`, name: 'Ada', emailVerified: true },
  });
  const nameless = await adminDb.user.create({
    data: { email: `nameless-${identifier}@example.com`, name: '', emailVerified: true },
  });
  for (const u of [ada, nameless]) {
    await adminDb.workspaceMembership.create({
      data: { userId: u.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
  }
  const byAda = await createTestWorkItem(fx, { kind: 'task', title: 'Assigned to Ada' });
  const byNameless = await createTestWorkItem(fx, {
    kind: 'task',
    title: 'Assigned to nobody-named',
  });
  await adminDb.workItem.update({
    where: { id: byAda.id },
    data: { status: 'todo', assigneeId: ada.id, reporterId: nameless.id },
  });
  await adminDb.workItem.update({
    where: { id: byNameless.id },
    data: { status: 'todo', assigneeId: nameless.id },
  });
  await adminDb.component.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'API',
      nameLower: 'api',
      defaultAssigneeId: nameless.id,
    },
  });
  await adminDb.board.updateMany({
    where: { projectId: fx.projectId },
    data: { swimlaneGroupBy: 'assignee' },
  });
  // An approval Ada decided — its label STORED as `Name <email>` — and one routed
  // to the nameless person, still awaiting.
  await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: byAda.id,
      kind: 'design_result',
      subjectId: `sub-${byAda.id}`,
      state: 'changes_requested',
      decidedById: ada.id,
      decidedAt: new Date(),
      decidedByLabel: `Ada <${ada.email}>`,
      noteMd: 'Please change.',
    },
  });
  await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: byNameless.id,
      kind: 'design_result',
      // A subject that RESOLVES — the room withdraws a gone one on read (MOTIR-7146).
      subjectId: await resolvableGateSubject(fx, byNameless.id, 'design_result'),
      state: 'awaiting',
      routedToId: nameless.id,
    },
  });
  const visitorCtx = await consentedVisitor(identifier);
  return {
    fx,
    identifier,
    visitor: visitorCtx,
    ada,
    nameless,
    byAda,
    byNameless,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Every payload a Visitor view reads through the services this card covers. */
async function visitorPayloads(t: Fixture) {
  const svc = visitorServiceContext(t.visitor);
  return {
    members: await assignableMembersService.listPersonLabels(t.visitor),
    board: await boardsService.getBoard(t.fx.projectId, t.visitor),
    components: await componentsService.listComponents(t.identifier, t.visitor),
    ready: await workItemsService.listReady(t.fx.projectId, {}, t.visitor),
    records: await approvalGatesService.listRecords(t.visitor, {}),
    gateOnAda: await approvalGatesService.getForWorkItem(
      { workItemId: t.byAda.id, kind: 'design_result' },
      svc,
    ),
    gateOnNameless: await approvalGatesService.getForWorkItem(
      { workItemId: t.byNameless.id, kind: 'design_result' },
      svc,
    ),
    refusal: await approvalGatesService.latestRefusalFor(t.byAda.id, svc),
  };
}

describe('every Visitor payload names people without an email', () => {
  it('carries no `@`, no email local part, and the neutral label for the nameless person', async () => {
    const t = await fixture();
    const payloads = await visitorPayloads(t);
    const wire = JSON.stringify(payloads);
    expect(wire).not.toContain('@');
    expect(wire).not.toContain('example.com');
    expect(wire).not.toContain(`nameless-${t.identifier}`);
    expect(wire).not.toContain(`ada-${t.identifier}`);
    expect(wire).not.toMatch(/"email"\s*:/);

    expect(payloads.members).toEqual(
      expect.arrayContaining([
        { id: t.ada.id, name: 'Ada' },
        { id: t.nameless.id, name: PERSON_FALLBACK_LABEL },
      ]),
    );
    const lanes = payloads.board.swimlanes.map((l) => l.label);
    expect(lanes).toEqual(expect.arrayContaining(['Ada', PERSON_FALLBACK_LABEL]));
    expect(payloads.components[0]!.defaultAssignee).toEqual({
      id: t.nameless.id,
      name: PERSON_FALLBACK_LABEL,
    });
    const readyNames = payloads.ready.items.map((i) => i.assignee?.name).filter(Boolean);
    expect(readyNames).toEqual(expect.arrayContaining(['Ada', PERSON_FALLBACK_LABEL]));

    expect(payloads.gateOnAda.gate?.decidedByLabel).toBe('Ada');
    expect(payloads.refusal?.decidedByLabel).toBe('Ada');
    expect(payloads.gateOnNameless.routedToLabel).toBe(PERSON_FALLBACK_LABEL);
    const decided = payloads.records.sections.decided.items.map((r) => r.decidedByLabel);
    expect(decided).toEqual(['Ada']);
  });

  it('an approval whose decider lost their name shows the neutral label, never the stored label', async () => {
    const t = await fixture();
    await adminDb.user.update({ where: { id: t.ada.id }, data: { name: '' } });
    const svc = visitorServiceContext(t.visitor);
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: t.byAda.id, kind: 'design_result' },
      svc,
    );
    expect(read.gate?.decidedByLabel).toBe(PERSON_FALLBACK_LABEL);
  });
});

describe("a member's payloads are unchanged", () => {
  it('keeps the stored decided-by label and the email lane fallback', async () => {
    const t = await fixture();
    const memberCtx = { userId: t.fx.ownerId, workspaceId: t.fx.workspaceId };
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: t.byAda.id, kind: 'design_result' },
      memberCtx,
    );
    expect(read.gate?.decidedByLabel).toBe(`Ada <${t.ada.email}>`);
    const board = await boardsService.getBoard(t.fx.projectId, t.fx.ctx);
    expect(board.swimlanes.map((l) => l.label)).toContain(t.nameless.email);
    const components = await componentsService.listComponents(t.identifier, memberCtx);
    expect(components[0]!.defaultAssignee?.email).toBe(t.nameless.email);
    const members = await assignableMembersService.list({
      projectId: t.fx.projectId,
      accessMode: 'public',
      ctx: memberCtx,
    });
    expect(members.find((m) => m.userId === t.ada.id)?.email).toBe(t.ada.email);
  });
});
