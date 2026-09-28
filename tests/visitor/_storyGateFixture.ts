import { visitorRecordsService } from '@/lib/services/visitorRecordsService';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// THE STORY GATE'S ONE FIXTURE (Story MOTIR-6170 · MOTIR-6650). A Public project
// in which what a Visitor may see and what is true genuinely differ, and a reader
// at every step of admission.
//
//   work        private epic E → C1 (→ G), C2 · visible V1 (blocks C1, and a
//               comment on it mentions C1) and V2
//   rooms       plan P1 touches C1, plan P2 touches V2 only · an approval record
//               on C1 and one on V2 · a run scoped to C1 and one to V2
//   people      real-looking emails on everyone, and one person with no name
//   readers     R0 no session · R1 another organisation, no record · R2 another
//               organisation, consented · R3 a Limited member of the workspace not
//               added to the project, consented · M1 the Manager (the workspace
//               owner) · M2 a Full member
//
// The readers' consent is taken by `consent(t)`, not here, so the admission seam
// can watch R2 and R3 move from `consent` to `visitor`.

let seq = 0;

async function person(slug: string, name: string, n: number) {
  return adminDb.user.create({
    data: { email: `${slug}.${n}@acme-corp.test`, name, emailVerified: true },
  });
}

export async function storyGateFixture() {
  const n = seq++;
  // A project key is at most five characters; every test truncates, so `seq` is unique enough.
  const identifier = `SG${n}`;
  const fx = await makeWorkItemFixture({ name: `Northwind ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: projectAccessData('public'),
  });

  // M1 — the Manager. The fixture's owner, given a real-looking address.
  const m1 = await adminDb.user.update({
    where: { id: fx.ownerId },
    data: { email: `ada.lovelace.${n}@acme-corp.test`, name: 'Ada Lovelace' },
  });
  const member = async (
    slug: string,
    name: string,
    accessScope: 'full' | 'limited',
  ): Promise<Awaited<ReturnType<typeof person>>> => {
    const u = await person(slug, name, n);
    await adminDb.workspaceMembership.create({
      data: {
        userId: u.id,
        workspaceId: fx.workspaceId,
        role: 'member',
        workspaceRole: 'member',
        accessScope,
      },
    });
    return u;
  };
  const m2 = await member('grace.hopper', 'Grace Hopper', 'full');
  const nameless = await member('quiet.contributor', '', 'full');
  const r3 = await member('linus.limited', 'Linus Limited', 'limited');

  // R1 and R2 — members of ANOTHER organisation.
  const other = await makeWorkItemFixture({ name: `Other ${identifier}`, identifier: `OT${n}` });
  const outsider = async (slug: string, name: string) => {
    const u = await person(slug, name, n);
    await adminDb.workspaceMembership.create({
      data: {
        userId: u.id,
        workspaceId: other.workspaceId,
        role: 'member',
        workspaceRole: 'member',
        accessScope: 'full',
      },
    });
    return u;
  };
  const r1 = await outsider('ravi.outsider', 'Ravi Outsider');
  const r2 = await outsider('riya.sen', 'Riya Sen');

  // The work.
  const E = await createTestWorkItem(fx, { kind: 'epic', title: 'Secret launch epic' });
  const C1 = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Hush pricing story',
    parentId: E.id,
  });
  const C2 = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Hush partner story',
    parentId: E.id,
  });
  const G = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Hush pricing subtask',
    parentId: C1.id,
  });
  const V1 = await createTestWorkItem(fx, { kind: 'story', title: 'Open onboarding story' });
  const V2 = await createTestWorkItem(fx, { kind: 'task', title: 'Open docs task' });
  for (const w of [E, C1, C2, G, V1, V2]) {
    await adminDb.workItem.update({ where: { id: w.id }, data: { status: 'todo' } });
  }
  await adminDb.workItem.update({ where: { id: E.id }, data: { publicChildrenHidden: true } });
  await adminDb.workItem.update({ where: { id: V1.id }, data: { assigneeId: m2.id } });
  await adminDb.workItem.update({ where: { id: V2.id }, data: { assigneeId: nameless.id } });
  await adminDb.workItem.update({ where: { id: C1.id }, data: { assigneeId: m2.id } });

  await adminDb.workItemLink.create({
    data: {
      workspaceId: fx.workspaceId,
      // V1 blocks C1, stored as its one directed row: C1 is_blocked_by V1.
      fromId: C1.id,
      toId: V1.id,
      kind: 'is_blocked_by',
      createdById: m1.id,
    },
  });
  await adminDb.comment.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: V1.id,
      authorId: m2.id,
      // The product's mention: a work-item chip naming C1.
      bodyMd: `Waiting on [${C1.identifier}](motir:${C1.id}) before this ships.`,
    },
  });

  // Plans: P1 touches C1, P2 touches V2 only.
  const base = { workspaceId: fx.workspaceId, projectId: fx.projectId };
  const plan = async (title: string, workItemId: string) => {
    const s = await adminDb.planChangeSession.create({ data: { ...base, targetKeys: [] } });
    const p = await adminDb.plan.create({
      data: { ...base, sessionId: s.id, status: 'planned', title },
    });
    const item = await adminDb.planItem.create({
      data: { workspaceId: fx.workspaceId, planId: p.id, op: 'modify', workItemId },
    });
    return { sessionId: s.id, planId: p.id, itemId: item.id };
  };
  const P1 = await plan('Reshape the hush pricing', C1.id);
  const P2 = await plan('Reshape the docs', V2.id);

  // Approval records on C1 and V2.
  const gate = (workItemId: string) =>
    adminDb.approvalGate.create({
      data: {
        ...base,
        workItemId,
        kind: 'design_result',
        subjectId: `sub-${workItemId}`,
        state: 'awaiting',
      },
    });
  const gateOnC1 = await gate(C1.id);
  const gateOnV2 = await gate(V2.id);

  // Runs scoped to C1 and V2.
  const run = (scopeWorkItemId: string) =>
    adminDb.dispatchRun.create({
      data: {
        ...base,
        command: 'run_scope',
        status: 'running',
        scopeWorkItemId,
        cards: {
          create: { workspaceId: fx.workspaceId, workItemId: scopeWorkItemId, position: 0 },
        },
      },
    });
  const runOnC1 = await run(C1.id);
  const runOnV2 = await run(V2.id);

  // Addressable rows for the write doors, so a leak would land on something real.
  const sprint = await adminDb.sprint.create({ data: { ...base, name: 'Sprint 1', sequence: 1 } });
  const label = await adminDb.label.create({
    data: { ...base, name: 'launch', nameLower: 'launch' },
  });
  const component = await adminDb.component.create({
    data: { ...base, name: 'Web', nameLower: 'web' },
  });
  const attachment = await adminDb.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: V1.id,
      uploaderUserId: m1.id,
      blobPathname: `attachments/${V1.id}/spec.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
      originalFilename: 'spec.pdf',
    },
  });
  const board = await adminDb.board.findFirst({ where: { projectId: fx.projectId } });
  const column = board
    ? await adminDb.boardColumn.findFirst({ where: { boardId: board.id } })
    : null;
  const status = await adminDb.workflowStatus.findFirst({ where: { projectId: fx.projectId } });

  const hidden = [C1, C2, G];
  return {
    fx,
    identifier,
    other,
    people: { m1, m2, nameless, r1, r2, r3 },
    items: { E, C1, C2, G, V1, V2 },
    hidden,
    visible: [E, V1, V2],
    plans: { P1, P2 },
    gates: { onC1: gateOnC1.id, onV2: gateOnV2.id },
    runs: { onC1: runOnC1.id, onV2: runOnV2.id },
    rows: {
      sprintId: sprint.id,
      labelId: label.id,
      componentId: component.id,
      attachmentId: attachment.id,
      boardId: board?.id ?? null,
      columnId: column?.id ?? null,
      statusId: status?.id ?? null,
    },
    /** Every string a Visitor must never be handed: hidden ids, keys and titles. */
    withheld: [
      ...hidden.flatMap((w) => [w.id, w.identifier, w.title]),
      P1.planId,
      P1.sessionId,
      'Reshape the hush pricing',
      gateOnC1.id,
      runOnC1.id,
    ],
  };
}

export type StoryGateFixture = Awaited<ReturnType<typeof storyGateFixture>>;

/** R2 and R3 press Continue on the project's consent screen. */
export async function consent(t: StoryGateFixture) {
  for (const u of [t.people.r2, t.people.r3]) {
    await visitorRecordsService.recordConsent({ identifier: t.identifier, userId: u.id });
  }
}

/** Every fixture person's address and its local part. */
export function emailsOf(t: StoryGateFixture) {
  return Object.values(t.people).map((u) => ({
    id: u.id,
    email: u.email,
    local: u.email.split('@')[0]!,
  }));
}
