import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import type { TwoInstanceClient, InstanceName } from '../harness';

// Seed helpers for the follow-up cases (MOTIR-8618). They write through the
// app's own services in THIS process, against the database both servers read,
// so every row a case starts from is one the two processes see identically.
//
// Each call makes a FRESH user, workspace and project: no case shares a session,
// a token, a plan or a rate-limit bucket with another.

/** Better-Auth trusts this origin in every build (`trustedOrigins`). */
export const ORIGIN = 'http://localhost:3000';

const PASSWORD = 'two-instance-follow-up-1';

/** A fresh client IP, single-value `x-forwarded-for` (see `limits.spec.ts`). */
export function freshIp(): string {
  const [a = 0, b = 0] = randomBytes(2);
  return `198.18.${a}.${b}`;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

/** A user with a password, their own workspace and one project in it. */
export async function seedMember(label: string): Promise<Member> {
  const tag = randomUUID().slice(0, 8);
  const email = `two-instance-${label}-${tag}@example.com`;
  const name = `Two Instance ${label} ${tag}`;
  const user = await usersService.createUser({ email, password: PASSWORD, name });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Two instance ${label} ${tag}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Follow up ${tag}`,
  });
  return {
    userId: user.id,
    email,
    name,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
  };
}

/** A PAT for the member, able to read and write work items (no project binding). */
export async function seedToken(member: Member): Promise<string> {
  const { token } = await apiTokensService.create(member.userId, member.workspaceId, {
    label: 'two-instance follow-up',
    fixedGrant: grantForLegacyScopes(['read', 'work_items:write']),
  });
  return token;
}

/**
 * Sign the member in through Better-Auth on `machine` and return the session
 * cookie header. Each sign-in uses its own IP so no case spends another's
 * sign-in bucket (3 per 10 s).
 */
export async function signIn(
  app: TwoInstanceClient,
  machine: InstanceName,
  member: Member,
): Promise<string> {
  const res = await app.sendTo(machine, '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ email: member.email, password: PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-in on ${machine} answered ${res.status}: ${await res.text()}`);
  }
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie.includes('session_token')) throw new Error(`sign-in on ${machine} set no session`);
  return cookie;
}

/** A plan in `planned` with one `add` proposal titled `title`, ready to approve. */
export async function seedPlannedPlan(member: Member, title: string): Promise<string> {
  const ctx = { userId: member.userId, workspaceId: member.workspaceId };
  const plan = await plansService.createPlan(member.projectId, { title: 'Two-instance plan' }, ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title, kind: 'task' } }],
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);
  return plan.id;
}

/** How many work items in the member's project carry `title` — the materialized set. */
export async function countItemsTitled(member: Member, title: string): Promise<number> {
  return db.workItem.count({ where: { projectId: member.projectId, title } });
}
