import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { componentsService } from '@/lib/services/componentsService';
import { backlogService } from '@/lib/services/backlogService';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-2562 — the peek payload's EDITOR INPUTS, read BACK through the real
// service rather than asserted against a hand-built fixture.
//
// The whole point of this card is a WIDENED READ, so a fixture test would be
// circular: it would prove the panel renders an object the test itself invented,
// and say nothing about whether `getQuickView` produces one of that shape. A
// field that exists but is subtly wrong — a workflow with no transitions, a
// member list missing the current assignee, a sprint list that omits the item's
// own sprint — passes every fixture test and fails the first time a picker
// opens. Real Postgres, like the archived-state test beside this one.

const PASSWORD = 'hunter2hunter2';

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Alice Chen' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

function peek(s: Awaited<ReturnType<typeof makeScenario>>, identifier: string) {
  return workItemsService.getQuickView(
    s.project.id,
    identifier,
    s.project.accessLevel,
    s.ctx,
    'en',
  );
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('getQuickView() — the editor inputs the editable rail needs (MOTIR-2562)', () => {
  it('carries the item’s INTERNAL id — the key both write paths are addressed by', async () => {
    const s = await makeScenario('peek-id@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Writable' },
      s.ctx,
    );

    const p = await peek(s, item.identifier);

    // `updateIssueAction` / `changeStatusAction` take `id`, not `identifier`.
    // Without this the peek can render every field and write none of them.
    expect(p.id).toBe(item.id);
    expect(p.identifier).toBe(item.identifier);
  });

  it('carries the WORKFLOW the status picker filters legal transitions from', async () => {
    const s = await makeScenario('peek-workflow@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Transitionable' },
      s.ctx,
    );

    const p = await peek(s, item.identifier);

    // StatusPicker takes statuses + transitions + policyMode. A workflow with
    // statuses and NO transitions type-checks and silently offers nothing under
    // the default `restricted` policy — which is why transitions are asserted
    // here and not just the status list.
    expect(p.workflow.statuses.length).toBeGreaterThan(0);
    expect(p.workflow.transitions.length).toBeGreaterThan(0);
    expect(p.workflow.policyMode).toBeTruthy();
    // The raw status KEY is what the picker selects against; the label is display.
    expect(p.workflow.statuses.some((st) => st.key === p.status)).toBe(true);
    expect(p.status).not.toBe(p.statusLabel);
  });

  it('carries the assignable MEMBERS, including the one currently assigned', async () => {
    const s = await makeScenario('peek-members@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Assigned', assigneeId: s.user.id },
      s.ctx,
    );

    const p = await peek(s, item.identifier);

    expect(p.assigneeId).toBe(s.user.id);
    // The current assignee must be IN the option list, or the picker opens with
    // its own value unselectable — the failure a fixture list cannot show.
    expect(p.members.some((m) => m.userId === p.assigneeId)).toBe(true);
  });

  it('carries the project’s SPRINTS, including the item’s own committed one', async () => {
    const s = await makeScenario('peek-sprints@example.com');
    const sprint = await sprintsService.createSprint(s.project.id, { name: 'Sprint 1' }, s.ctx);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'In a sprint' },
      s.ctx,
    );
    await backlogService.assignToSprint(item.id, sprint.id, undefined, s.ctx);

    const p = await peek(s, item.identifier);

    expect(p.sprintId).toBe(sprint.id);
    expect(p.sprints.some((x) => x.id === sprint.id)).toBe(true);
    // The option shape is the four fields SprintPicker reads — deliberately NOT
    // the full SprintDto, whose `issueCount` costs one query per sprint on a
    // payload fetched on every row click.
    const opt = p.sprints.find((x) => x.id === sprint.id)!;
    expect(Object.keys(opt).sort()).toEqual(['id', 'name', 'sequence', 'state']);
  });

  it('carries the project’s COMPONENT taxonomy, not just the item’s components', async () => {
    const s = await makeScenario('peek-components@example.com');
    await componentsService.createComponent(
      { key: s.project.identifier, name: 'Unused elsewhere' },
      s.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'No components of its own' },
      s.ctx,
    );

    const p = await peek(s, item.identifier);

    // The item has none; the PICKER still needs the project's options. Reading
    // only `components` (the item's) would give an empty picker on every
    // unlabelled item.
    expect(p.components).toHaveLength(0);
    expect(p.projectComponents.some((c) => c.name === 'Unused elsewhere')).toBe(true);
  });

  it('adds the raw values ALONGSIDE the display strings, never in place of them', async () => {
    const s = await makeScenario('peek-alongside@example.com');
    const item = await workItemsService.createWorkItem(
      {
        projectId: s.project.id,
        kind: 'task',
        title: 'Both axes',
        estimateMinutes: 90,
        dueDate: '2026-06-12T00:00:00.000Z',
      },
      s.ctx,
    );

    const p = await peek(s, item.identifier);

    // The display strings are what keep the panel presentational; the raw values
    // are what make its controls selectable. Losing either breaks one half.
    expect(p.estimateMinutes).toBe(90);
    expect(p.estimateLabel).toBeTruthy();
    expect(p.estimateLabel).not.toBe(String(p.estimateMinutes));
    expect(p.dueDate).toBeTruthy();
    expect(p.dueLabel).toBeTruthy();
    expect(p.dueLabel).not.toBe(p.dueDate);
  });

  it('does not leak the new option sources to a caller who cannot read the item', async () => {
    const owner = await makeScenario('peek-owner@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: owner.project.id, kind: 'task', title: 'Private work' },
      owner.ctx,
    );
    const outsider = await makeScenario('peek-outsider@example.com');

    // The widened payload must not widen the blast radius: a cross-workspace
    // read still fails the same way, so members / sprints / components never
    // reach someone who could not read the item before this card.
    await expect(
      workItemsService.getQuickView(
        owner.project.id,
        item.identifier,
        owner.project.accessLevel,
        outsider.ctx,
        'en',
      ),
    ).rejects.toThrow();
  });
});
