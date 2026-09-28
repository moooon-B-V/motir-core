import { adminDb } from './db-reset';
import { createTestPerson } from './testPerson';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// Seed for Story MOTIR-6170's E2E + acceptance recording (Subtask MOTIR-6651): a
// PUBLIC project a person outside its organisation watches as a Visitor.
//
// ⚠️ THE FIXTURE IS BUILT SO THE VISITOR'S VIEW AND THE TRUTH GENUINELY DIFFER.
// A private epic E holds two children (C1, C2); a plan, an approval record and a
// run each touch C1, and a twin of each touches the visible story V1. Every "the
// Visitor does not see it" assertion in the walk is therefore about a row that
// EXISTS — a member reading the same project sees all of it — never about an
// empty fixture that could not have leaked anything.
//
// The PEOPLE are there for the no-email scan: every member has a real-looking
// address, one has no name at all (the Visitor sees the neutral label), and the
// approval record decided by the Manager carries a `Name <email>` label in its
// row, which the Visitor's read must not repeat.
//
// The OUTSIDER (O) belongs to another organisation and has no membership in the
// project's workspace and no visitor record — the reader the story is about.

export const VISITOR_PASSWORD = 'visitor-e2e-pass-123';

export interface VisitorSeed {
  manager: { name: string; email: string };
  outsider: { id: string; name: string; email: string };
  /** Every seeded address that is NOT the outsider's — the scan's forbidden list. */
  otherEmails: string[];
  project: { id: string; name: string; key: string };
  workspaceName: string;
  /** The private epic, its hidden children, and the visible work. */
  privateEpic: { key: string; title: string };
  hidden: { key: string; title: string }[];
  visibleEpic: { key: string; title: string };
  visible: { key: string; title: string }[];
  plans: { visible: string; hidden: string };
  runsScope: { visible: string; hidden: string };
  /** A `members`-mode project in the same workspace: no Visitor URL of it exists. */
  membersOnly: { key: string };
  /** A second PUBLIC project nobody has visited (the Visitors list's empty state). */
  quiet: { id: string; name: string; key: string };
}

export async function seedVisitorProject(slug: string): Promise<VisitorSeed> {
  const email = (label: string) => `vis-${label}-${slug}@example.com`;
  const person = (label: string, name: string) =>
    createTestPerson({ email: email(label), password: VISITOR_PASSWORD, name });

  // ── The project's workspace and its people ─────────────────────────────────
  const maya = await person('manager', 'Maya Manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Northwind',
    ownerUserId: maya.id,
  });
  const ctx = { userId: maya.id, workspaceId: workspace.id };
  const fran = await person('fran', 'Fran Full');
  // `User.name` is NOT NULL: the "no name" person is the empty string, which the
  // name-only rule renders as the neutral label.
  const nameless = await person('nameless', '');
  for (const u of [fran, nameless]) {
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
  }

  const makeProject = async (name: string, identifier: string, mode: 'public' | 'members') => {
    const p = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: maya.id,
      name,
      identifier,
    });
    await adminDb.project.update({
      where: { id: p.id },
      data: mode === 'public' ? projectAccessData('public') : projectAccessData('members'),
    });
    return { id: p.id, name, key: p.identifier };
  };
  const project = await makeProject('Lighthouse', 'LHT', 'public');
  const membersOnly = await makeProject('Vault', 'VLT', 'members');
  const quiet = await makeProject('Harbor', 'HRB', 'public');

  const item = async (
    title: string,
    kind: 'epic' | 'story',
    extra: { parentId?: string; assigneeId?: string } = {},
  ) => {
    const w = await workItemsService.createWorkItem(
      { projectId: project.id, kind, title, ...extra },
      ctx,
    );
    return { id: w.id, key: w.identifier, title };
  };

  // ── The private epic and its hidden children ───────────────────────────────
  const privateEpic = await item('Pricing experiments', 'epic');
  const c1 = await item('Secret discount rules', 'story', {
    parentId: privateEpic.id,
    assigneeId: fran.id,
  });
  const c2 = await item('Competitor price scrape', 'story', { parentId: privateEpic.id });
  await adminDb.workItem.update({
    where: { id: privateEpic.id },
    data: { publicChildrenHidden: true },
  });

  // ── The visible work ───────────────────────────────────────────────────────
  const visibleEpic = await item('Public launch', 'epic');
  const v1 = await item('Landing page hero', 'story', {
    parentId: visibleEpic.id,
    assigneeId: fran.id,
  });
  const v2 = await item('Signup confirmation email', 'story', {
    parentId: visibleEpic.id,
    assigneeId: nameless.id,
  });

  // ── A plan, an approval record and a run on each side ──────────────────────
  const base = { workspaceId: workspace.id, projectId: project.id };
  const plan = async (title: string, workItemId: string) => {
    const session = await adminDb.planChangeSession.create({ data: { ...base, targetKeys: [] } });
    const p = await adminDb.plan.create({
      data: { ...base, sessionId: session.id, status: 'planned', title, createdById: maya.id },
    });
    await adminDb.planItem.create({
      data: { workspaceId: workspace.id, planId: p.id, op: 'modify', workItemId },
    });
    return title;
  };
  const visiblePlan = await plan('Polish the launch page', v1.id);
  const hiddenPlan = await plan('Tune the discount rules', c1.id);

  const gate = async (workItemId: string, decided: boolean) => {
    const g = await adminDb.approvalGate.create({
      data: {
        ...base,
        workItemId,
        kind: 'design_result',
        subjectId: `vis-evidence-${workItemId}`,
        routedToId: maya.id,
      },
    });
    if (decided) {
      await adminDb.approvalGate.update({
        where: { id: g.id },
        data: {
          state: 'approved',
          decidedById: maya.id,
          decidedAt: new Date(Date.now() - 1_800_000),
          // The stored label carries the address, as a real decision's does.
          decidedByLabel: `${maya.name} <${maya.email}>`,
          subjectVersion: 'c0ffee15beef',
        },
      });
    }
  };
  await gate(v1.id, true);
  await gate(v2.id, false);
  await gate(c1.id, false);

  const run = (scopeWorkItemId: string) =>
    adminDb.dispatchRun.create({
      data: {
        ...base,
        command: 'run_scope',
        status: 'running',
        scopeWorkItemId,
        cards: { create: { workspaceId: workspace.id, workItemId: scopeWorkItemId, position: 0 } },
      },
    });
  await run(v1.id);
  await run(c1.id);

  // The Manager lands in this project.
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: maya.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  // ── The outsider, in an organisation of their own ──────────────────────────
  const olive = await person('outsider', 'Olive Outsider');
  const own = await workspacesService.createWorkspace({
    name: 'Olive Studio',
    ownerUserId: olive.id,
  });
  const ownProject = await projectsService.createProject({
    workspaceId: own.workspace.id,
    actorUserId: olive.id,
    name: 'Sketches',
    identifier: 'SKT',
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: olive.id, workspaceId: own.workspace.id } },
    data: { activeProjectId: ownProject.id },
  });

  return {
    manager: { name: 'Maya Manager', email: email('manager') },
    outsider: { id: olive.id, name: 'Olive Outsider', email: email('outsider') },
    otherEmails: [email('manager'), email('fran'), email('nameless')],
    project,
    workspaceName: 'Northwind',
    privateEpic: { key: privateEpic.key, title: privateEpic.title },
    hidden: [c1, c2].map(({ key, title }) => ({ key, title })),
    visibleEpic: { key: visibleEpic.key, title: visibleEpic.title },
    visible: [v1, v2].map(({ key, title }) => ({ key, title })),
    plans: { visible: visiblePlan, hidden: hiddenPlan },
    runsScope: { visible: v1.title, hidden: c1.title },
    membersOnly: { key: membersOnly.key },
    quiet,
  };
}
