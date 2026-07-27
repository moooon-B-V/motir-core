// AI augment & re-plan E2E seed (Subtask 7.11.9 / MOTIR-906).
//
// Mints a sign-in-able tenant through shipped services, then seeds work items
// that exercise the operations: expand (a childless stub) and replan (an epic
// with mixed done/not-done leaves), on a tree with a related neighbourhood.
// (The augment leg + its `AUGMENT_JOB_ID` retired with the "Augment from
// prompt" button — MOTIR-1731.) The spec stubs the browser→motir-ai boundary via
// `page.route` and lets the real approve delta endpoint create real work items,
// then asserts DB state — the same pattern `ai-plan-generation.spec.ts` uses
// (stub the AI, drive the REAL substrate).
//
// The nudge test stubs `GET /api/ready/nudge` to return a fixed suggestion.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

export const AUGMENT_REPLAN_SEED_PASSWORD = 'ai-augment-replan-e2e-pass-9';

export const EXPAND_JOB_ID = 'job_e2e_expand';
export const REPLAN_JOB_ID = 'job_e2e_replan';
/** The two `augment` jobs the plan-change CONVERSATION acceptance spec stubs —
 *  one per turn, so the SECOND (refining) turn returns a DIFFERENT delta and the
 *  in-canvas diff is provably updated rather than merely re-rendered. */
export const PLAN_CHANGE_JOB_ID = 'job_e2e_plan_change_1';
export const PLAN_CHANGE_REFINE_JOB_ID = 'job_e2e_plan_change_2';

export interface AiAugmentReplanSeed {
  email: string;
  password: string;
  ctx: ServiceContext;
  projectId: string;
  /** Epic: "Authentication" — has children, provides the augment neighbourhood. */
  authEpicKey: string;
  /** Story: "Login UI" — child of Authentication. */
  loginKey: string;
  /** Story: "Notifications" — childless stub for expand. */
  notifKey: string;
  /** Epic: "Settings" — has done + not-done leaves for replan. */
  settingsEpicKey: string;
  /** Done subtasks — must be byte-identical after replan. */
  themeKey: string;
  profileKey: string;
  /** Not-done subtasks — the replan may propose changes to these. */
  billingKey: string;
  apiKey: string;
}

/** A sign-in-able tenant with four work-item clusters for all three operations. */
export async function seedAiAugmentReplan(email: string): Promise<AiAugmentReplanSeed> {
  const owner = await usersService.createUser({
    email,
    password: AUGMENT_REPLAN_SEED_PASSWORD,
    name: 'Augment Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Augment E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Augment Replan',
    identifier: 'ARP',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  const pid = project.id;

  // ── Augment neighbourhood: "Authentication" epic with two children ───────
  const authEpic = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'epic', title: 'Authentication' },
    ctx,
  );
  const login = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'story', title: 'Login UI', parentId: authEpic.id },
    ctx,
  );
  await workItemsService.createWorkItem(
    { projectId: pid, kind: 'story', title: 'Password Reset', parentId: authEpic.id },
    ctx,
  );

  // ── Expand target: childless stub story ──────────────────────────────────
  const notif = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'story', title: 'Notifications' },
    ctx,
  );

  // ── Re-plan target: epic with mixed done / not-done leaves ───────────────
  const settingsEpic = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'epic', title: 'Settings' },
    ctx,
  );
  const theme = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'task', title: 'Theme toggle', parentId: settingsEpic.id },
    ctx,
  );
  const profile = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'task', title: 'Profile page', parentId: settingsEpic.id },
    ctx,
  );
  const billing = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'task', title: 'Billing settings', parentId: settingsEpic.id },
    ctx,
  );
  const api = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'task', title: 'API keys', parentId: settingsEpic.id },
    ctx,
  );

  // Mark theme + profile as done (terminal) so replan treats them as locked.
  await db.workItem.update({ where: { id: theme.id }, data: { status: 'done' } });
  await db.workItem.update({ where: { id: profile.id }, data: { status: 'done' } });

  return {
    email,
    password: AUGMENT_REPLAN_SEED_PASSWORD,
    ctx,
    projectId: pid,
    authEpicKey: authEpic.identifier,
    loginKey: login.identifier,
    notifKey: notif.identifier,
    settingsEpicKey: settingsEpic.identifier,
    themeKey: theme.identifier,
    profileKey: profile.identifier,
    billingKey: billing.identifier,
    apiKey: api.identifier,
  };
}

/**
 * Mark the seeded project ESTABLISHED — a project that already ran onboarding
 * and has an approved plan.
 *
 * `/planning` (the MOTIR-1729 host) FORWARDS a project whose `onboardingRanAt`
 * is null to `/onboarding`, which still owns the first-run fork. The plan-change
 * conversation is the established-project case by definition, so its acceptance
 * spec sets the same immutable marker both surfaces split on. `createProject`
 * leaves it null (a fresh project has not onboarded), so the seed cannot carry
 * it for every caller — the augment/replan spec drives `/items`, not `/planning`.
 */
export async function markProjectOnboarded(projectId: string): Promise<void> {
  await db.project.update({
    where: { id: projectId },
    data: { onboardingRanAt: new Date() },
  });
}
