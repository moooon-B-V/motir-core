import { adminDb } from './db-reset';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { seedHostedRun, HOSTED_RUN_PASSWORD } from './hosted-run-seed';

// STORY MOTIR-693's E2E SEED (MOTIR-6417) — one project the hosted start path accepts
// (`seedHostedRun`: a writable repository and a GitHub installation behind the
// acceptance lane's stubs), with ONE design subtask and ONE card waiting on it.
//
// What the spec does NOT get from here, on purpose: the design RESULT and its gate. The
// spec publishes through the real `publish_design_result` tool, because publishing is
// what raises the gate — and, with the switch off, what approves it.

export const BABYSITTER_TITLES = {
  story: 'Review designs without a babysitter',
  design: 'Draw the empty state for the reports list',
  dependent: 'Build the empty state for the reports list',
} as const;

export interface DesignBabysitterSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  designId: string;
  designKey: string;
  dependentKey: string;
  /** A token holding EXACTLY `CLI_TOKEN_GRANT` — the grant a dispatched run publishes with. */
  token: string;
}

export async function seedDesignBabysitter(
  slug: string,
  identifier: string,
): Promise<DesignBabysitterSeed> {
  const base = await seedHostedRun(`babysitter-${slug}@example.com`, identifier);
  const ctx = { userId: base.userId, workspaceId: base.workspaceId };

  const story = await workItemsService.createWorkItem(
    { projectId: base.projectId, kind: 'story', title: BABYSITTER_TITLES.story },
    ctx,
  );
  // The owner is the ASSIGNEE, so the gate routes to them and they may press it.
  const design = await workItemsService.createWorkItem(
    {
      projectId: base.projectId,
      kind: 'subtask',
      title: BABYSITTER_TITLES.design,
      parentId: story.id,
      type: 'design',
      assigneeId: base.userId,
    },
    ctx,
  );
  const dependent = await workItemsService.createWorkItem(
    {
      projectId: base.projectId,
      kind: 'subtask',
      title: BABYSITTER_TITLES.dependent,
      parentId: story.id,
      type: 'code',
    },
    ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: dependent.id, toId: design.id, kind: 'is_blocked_by' },
    ctx,
  );
  await workItemsService.updateStatus(design.id, 'in_progress', ctx);

  const minted = await apiTokensService.create(base.userId, base.workspaceId, {
    label: 'design-babysitter-e2e',
    projectId: base.projectId,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    email: base.email,
    password: HOSTED_RUN_PASSWORD,
    userId: base.userId,
    workspaceId: base.workspaceId,
    projectId: base.projectId,
    designId: design.id,
    designKey: design.identifier,
    dependentKey: dependent.identifier,
    token: minted.token,
  };
}

/** The design card's LAST run was HOSTED, by the owner, on `model` — the lane the
 *  automatic re-run reuses (`hosted-design-rerun-and-design-approval-switch.md` §1a–§1b). */
export async function seedLastHostedRun(seed: DesignBabysitterSeed, model: string): Promise<void> {
  const startedAt = new Date(Date.now() - 60 * 60_000);
  await adminDb.dispatchRun.create({
    data: {
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      command: 'run',
      origin: 'hosted',
      agent: 'opencode',
      model,
      status: 'succeeded',
      startedAt,
      endedAt: new Date(startedAt.getTime() + 10 * 60_000),
      createdById: seed.userId,
      cards: {
        create: {
          workspaceId: seed.workspaceId,
          workItemId: seed.designId,
          workItemKey: seed.designKey,
          position: 0,
          disposition: 'implemented',
        },
      },
    },
  });
}

/** `count` EARLIER Revise refusals on the design card, pressed in Motir — so the next
 *  Revise is the one past the cap (§1e). Their superseded results carry no bytes. */
export async function seedEarlierRevises(seed: DesignBabysitterSeed, count: number): Promise<void> {
  const base = Date.now() - 50 * 60_000;
  for (let i = 0; i < count; i += 1) {
    const evidence = await adminDb.designEvidence.create({
      data: { workspaceId: seed.workspaceId, workItemId: seed.designId, isCurrent: false },
    });
    await adminDb.approvalGate.create({
      data: {
        workspaceId: seed.workspaceId,
        projectId: seed.projectId,
        workItemId: seed.designId,
        kind: 'design_result',
        subjectId: evidence.id,
        state: 'changes_requested',
        decidedById: seed.userId,
        decidedAt: new Date(base + i * 60_000),
        noteMd: `an earlier round, number ${i + 1}`,
        decisionSource: 'ui',
        decidedUnderAuthority: 'assignee',
        refusalVerdict: 'revise',
      },
    });
  }
}
