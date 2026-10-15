// THE SEED AND THE RESET, BELOW THEIR COMMANDS (Story MOTIR-8538 · MOTIR-8673).
//
// `seed.ts` and `reset.ts` check the environment and the target first and only then
// import this module, because importing it opens the database and loads
// `lib/auth/index.ts` (which `requiredEnv`s its secrets at module load).
//
// ⚠️ EVERYTHING GOES THROUGH THE SHIPPED SERVICES, as the e2e seeds do
// (`tests/e2e/_helpers/agent-authored-plan-seed.ts`). That is what makes RLS,
// membership, legal acceptance, the token hash, the plan state machine, card keys
// and ordering hold — a reader never meets a row the product could not have written.
// No raw SQL touches a tenant table. Nothing here mails, calls GitHub or motir-ai,
// or connects a repository: members are added with `addMember` (the path that does
// not invite), and projects get no repository.
//
// ⚠️ RE-SEEDING WITH ONE RUN TAG IS IDEMPOTENT ON EVERYTHING BUT CREDENTIALS. Users
// are found by their deterministic email, workspaces by name under their owner,
// projects by name, cards and plans by title; the pools are then put back to their
// seeded state exactly as a reset would. The tag's previous TOKENS are deleted and
// new ones minted, and new session cookies are minted — the plaintext of the old
// ones cannot be recovered, so a manifest cannot be rebuilt without them.

import { randomBytes } from 'node:crypto';
import { auth } from '@/lib/auth';
import { resolveTwoFactorHold } from '@/lib/auth/requireCompliantSession';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { legalAcceptanceService } from '@/lib/services/legalAcceptanceService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces/middleware';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CreateWorkItemInput } from '@/lib/dto/workItems';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { SYNTHETIC_EMAIL_DOMAIN } from './guard';
import {
  MANIFEST_VERSION,
  type ManifestAgent,
  type ManifestCard,
  type ManifestProject,
  type ManifestUser,
  type ManifestWorkspace,
  type SeedManifest,
} from './manifest';
import { AGENT_ROLES, type AgentRole, type SeedShape } from './shape';

/** Rows created at once. Bounded so ~1000 clients seed in minutes without exhausting the pool. */
const CONCURRENCY = 8;
/** Proposals on each read plan — fixed and small, so reader latency does not depend on the shape. */
const READ_PLAN_PROPOSALS = 3;

export interface SeedTarget {
  runTag: string;
  /** The endpoint host the guard admitted — recorded in the manifest. */
  databaseHost: string;
  log?: (line: string) => void;
}

// ── Naming: deterministic, so a re-seed finds what an earlier one wrote ─────────

export const syntheticEmail = (tag: string, u: number) =>
  `lt-${tag}-u${u}@${SYNTHETIC_EMAIL_DOMAIN}`;
const workspaceName = (tag: string, w: number) => `Loadtest ${tag} W${w}`;
const projectName = (tag: string, w: number, p: number) => `Loadtest ${tag} W${w} P${p}`;
const projectIdentifier = (w: number, p: number) => `L${w}P${p}`;
const tokenLabelPrefix = (tag: string) => `loadtest:${tag}:`;
const title = (tag: string, what: string) => `[loadtest ${tag}] ${what}`;

/** The memberships of user `u`: workspaces (u + j) mod W, j < workspacesPerUser. */
export function workspacesOfUser(shape: SeedShape, u: number): number[] {
  return Array.from({ length: shape.workspacesPerUser }, (_, j) => (u + j) % shape.workspaces);
}

// ── Small helpers ───────────────────────────────────────────────────────────

async function mapLimit<T, R>(items: readonly T[], fn: (item: T, i: number) => Promise<R>) {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

const card = (dto: { id: string; identifier: string }): ManifestCard => ({
  id: dto.id,
  key: dto.identifier,
});

export class TwoFactorHoldError extends Error {
  constructor(readonly email: string) {
    super(
      `seeded user ${email} is HELD by the two-factor policy: every cookie request it makes ` +
        `would answer 403. Relax the policy for the synthetic tenants, or exempt them, and re-seed.`,
    );
    this.name = 'TwoFactorHoldError';
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * Sign a cookie value exactly as Better-Auth does: better-call's `signCookieValue`
 * (better-auth 1.7.7 → better-call `dist/crypto.mjs`), HMAC-SHA-256 over the value
 * with the auth secret, `<value>.<base64 signature>`, URI-encoded. better-call is a
 * dependency of better-auth, not of this repository, so the function is restated
 * here; the seed test proves the result against `auth.api.getSession`.
 */
async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return encodeURIComponent(`${value}.${b64}`);
}

/**
 * Mint a session for `userId` through Better-Auth's own server side — at 1.7.7,
 * `(await auth.$context).internalAdapter.createSession(userId)`, which runs the
 * configured `session.create` hooks and writes the row the app reads — and return
 * the cookie the app would set. The NAME comes from `authCookies.sessionToken`,
 * which Better-Auth builds from this process's config (`MOTIR_BASE_URL`'s scheme
 * decides a `__Secure-` prefix), so it is never hard-coded here.
 */
export async function mintSessionCookie(userId: string) {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId);
  return {
    cookieName: ctx.authCookies.sessionToken.name,
    cookieValue: await signCookieValue(session.token, ctx.secret),
    lifetimeSeconds: ctx.sessionConfig.expiresIn,
  };
}

// ── The run token's grant ───────────────────────────────────────────────────

/**
 * What a project-bound `run` agent holds: `CLI_TOKEN_GRANT` — the keys `motir run`
 * holds — narrowed to what the token's OWNER can confer in that project.
 *
 * ⚠️ NOT ALWAYS ALL OF CLI_TOKEN_GRANT. A chosen grant is validated against what
 * the minting user holds (`resolveGrant` → `InvalidTokenGrantError: Not a grantable
 * permission`), and the built-in workspace `member` role holds neither
 * `lesson:view` (search_lessons) nor `lesson:reinforce` (reinforce_lesson)
 * (lib/permissions/builtinRoles.ts). So a workspace OWNER's run token carries the
 * whole list, and a MEMBER's lacks exactly those two lesson keys; the run-lifecycle
 * scenario must not call the lesson tools with a member's run token. The device
 * credential gets them through its FIXED grant, which `assertLegalBinding` forbids
 * beside a project. The seed test pins both cases.
 */
export function runTokenGrant(grantable: readonly PermissionKey[]): PermissionKey[] {
  const offered = new Set(grantable);
  return CLI_TOKEN_GRANT.filter((key) => offered.has(key));
}

// ── Users, workspaces, projects (find-or-create) ────────────────────────────

async function findOrCreateUser(tag: string, u: number) {
  const email = syntheticEmail(tag, u);
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  if (existing) return { id: existing.user.id, email };
  // The password is random and discarded: synthetic users never sign in, their
  // sessions are minted. Legal acceptance is the second half of sign-up — without
  // it every signed-in page holds the user at /re-consent (tests/e2e/_helpers/testPerson.ts).
  const user = await usersService.createUser({
    email,
    password: randomBytes(24).toString('base64url'),
    name: `Loadtest ${tag} user ${u}`,
  });
  await legalAcceptanceService.recordAcceptance(user.id);
  return { id: user.id, email };
}

async function findOrCreateWorkspace(tag: string, w: number, ownerUserId: string) {
  const name = workspaceName(tag, w);
  const mine = await workspacesService.listUserWorkspaces(ownerUserId);
  const found = mine.find((ws) => ws.name === name);
  if (found) return { id: found.id, name };
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId });
  return { id: workspace.id, name };
}

async function ensureMember(userId: string, workspaceId: string) {
  if (await workspacesService.findMembership(userId, workspaceId)) return;
  await workspacesService.addMember({ userId, workspaceId });
}

async function findOrCreateProject(
  tag: string,
  w: number,
  p: number,
  workspaceId: string,
  ownerUserId: string,
): Promise<ProjectDTO> {
  const name = projectName(tag, w, p);
  const existing = (await projectsService.listProjects(workspaceId, ownerUserId)).find(
    (pr) => pr.name === name,
  );
  if (existing) return existing;
  return projectsService.createProject({
    workspaceId,
    actorUserId: ownerUserId,
    name,
    identifier: projectIdentifier(w, p),
  });
}

// ── Cards and plans (find-or-create by title) ───────────────────────────────

type CardIndex = Map<string, { id: string; identifier: string }>;

async function indexProjectCards(projectId: string, ctx: ServiceContext): Promise<CardIndex> {
  const index: CardIndex = new Map();
  let after: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const page = await workItemsService.listProjectWorkItemsPage(
      projectId,
      { ...(after ? { after } : {}), limit: 100 },
      ctx,
    );
    for (const item of page.items)
      index.set(item.title, { id: item.id, identifier: item.identifier });
    if (!page.hasMore || page.items.length === 0) break;
    const last = page.items[page.items.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
  }
  return index;
}

class ProjectWriter {
  constructor(
    readonly project: ProjectDTO,
    readonly ctx: ServiceContext,
    private readonly index: CardIndex,
    private readonly tag: string,
  ) {}

  async card(
    what: string,
    input: Omit<CreateWorkItemInput, 'projectId' | 'title'>,
  ): Promise<ManifestCard> {
    const t = title(this.tag, what);
    const hit = this.index.get(t);
    if (hit) return card(hit);
    const created = await workItemsService.createWorkItem(
      { ...input, projectId: this.project.id, title: t },
      this.ctx,
    );
    this.index.set(t, created);
    return card(created);
  }

  story(what: string) {
    return this.card(what, { kind: 'story' });
  }

  /** A `code` leaf under `parent`; `executor: coding_agent` makes it a dispatch-run target. */
  leaf(what: string, parent: ManifestCard, opts: { agent?: boolean } = {}) {
    return this.card(what, {
      kind: 'subtask',
      parentId: parent.id,
      type: 'code',
      ...(opts.agent ? { executor: 'coding_agent' as const } : {}),
    });
  }
}

async function listPlanTitles(projectId: string, ctx: ServiceContext) {
  const plans: { id: string; title: string | null; status: string }[] = [];
  let cursor: string | null = null;
  do {
    const page = await plansService.listPlans(projectId, ctx, cursor ? { cursor } : {});
    plans.push(...page.plans);
    cursor = page.nextCursor;
  } while (cursor);
  return plans;
}

async function createReadPlan(projectId: string, planTitle: string, ctx: ServiceContext) {
  const plan = await plansService.createPlan(
    projectId,
    { title: planTitle, summary: planTitle },
    ctx,
  );
  await plansService.addProposals(
    plan.id,
    Array.from({ length: READ_PLAN_PROPOSALS }, (_, i) => ({
      op: 'add' as const,
      proposedFields: { title: `${planTitle} · proposal ${i + 1}`, kind: 'task' as const },
    })),
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);
  return plan.id;
}

async function createScratchPlan(projectId: string, planTitle: string, ctx: ServiceContext) {
  return (await plansService.createPlan(projectId, { title: planTitle, summary: planTitle }, ctx))
    .id;
}

// ── Putting the pools back ──────────────────────────────────────────────────

/** Return a consumable card to `todo`, unassigned, under `parentId`. */
async function restoreCard(cardId: string, parentId: string, ctx: ServiceContext) {
  let current = await workItemsService.getWorkItem(cardId, ctx);
  if (current.parentId !== parentId) {
    current = await workItemsService.moveWorkItem(cardId, { newParentId: parentId }, ctx);
  }
  if (current.assigneeId !== null) await workItemsService.assignWorkItem(cardId, null, ctx);
  if (current.status !== 'todo') await workItemsService.updateStatus(cardId, 'todo', ctx);
}

/**
 * A scratch plan is fresh while it is `generating` and has no items. A grown or
 * moved-on one is declined (when still open) and replaced, so a run never starts
 * on a plan an earlier run already filled.
 */
async function freshScratchPlan(
  planId: string,
  projectId: string,
  planTitle: string,
  ctx: ServiceContext,
): Promise<string> {
  const plan = await plansService.getPlan(planId, ctx);
  if (plan.status === 'generating' && plan.items.length === 0) return planId;
  if (plan.status === 'generating' || plan.status === 'planned' || plan.status === 'stale') {
    await plansService.declinePlan(planId, ctx);
  }
  return createScratchPlan(projectId, planTitle, ctx);
}

// ── The seed ────────────────────────────────────────────────────────────────

/**
 * Seed `shape` under `target.runTag` and return the manifest (the caller writes it).
 * Every step is find-or-create; see the file header for what a re-seed changes.
 */
export async function seedTenants(shape: SeedShape, target: SeedTarget): Promise<SeedManifest> {
  const log = target.log ?? (() => {});
  const tag = target.runTag;

  // 1. Users.
  const userRows = await mapLimit(
    Array.from({ length: shape.users }, (_, u) => u),
    (u) => findOrCreateUser(tag, u),
  );
  log(`users: ${userRows.length}`);

  // 2. Workspaces (owned by user w) and memberships.
  const workspaceRows = await mapLimit(
    Array.from({ length: shape.workspaces }, (_, w) => w),
    (w) => findOrCreateWorkspace(tag, w, userRows[w]!.id),
  );
  await mapLimit(userRows, async (user, u) => {
    for (const w of workspacesOfUser(shape, u)) await ensureMember(user.id, workspaceRows[w]!.id);
  });
  log(`workspaces: ${workspaceRows.length}`);

  // 3. Projects, their backlog and pool parents, read plans.
  const projectsByWs: { dto: ProjectDTO; writer: ProjectWriter; manifest: ManifestProject }[][] =
    [];
  await mapLimit(workspaceRows, async (ws, w) => {
    const ownerId = userRows[w]!.id;
    const list: (typeof projectsByWs)[number] = [];
    for (let p = 0; p < shape.projectsPerWorkspace; p++) {
      const dto = await findOrCreateProject(tag, w, p, ws.id, ownerId);
      const ctx: ServiceContext = { userId: ownerId, workspaceId: ws.id };
      const writer = new ProjectWriter(dto, ctx, await indexProjectCards(dto.id, ctx), tag);
      const stories: ManifestCard[] = [];
      const subtasks: ManifestCard[] = [];
      for (let s = 0; s < shape.content.stories; s++) {
        const story = await writer.story(`story ${s}`);
        stories.push(story);
        for (let t = 0; t < shape.content.subtasksPerStory; t++) {
          subtasks.push(await writer.leaf(`story ${s} subtask ${t}`, story));
        }
      }
      const parents = {
        claim: await writer.story('claim pool'),
        run: await writer.story('run pool'),
        write: await writer.story('write pool'),
      };
      const pool = async (name: 'claim' | 'run' | 'write', n: number) => {
        const cards: ManifestCard[] = [];
        for (let i = 0; i < n; i++) {
          cards.push(await writer.leaf(`${name} ${i}`, parents[name], { agent: name === 'run' }));
        }
        return cards;
      };
      list.push({
        dto,
        writer,
        manifest: {
          id: dto.id,
          key: dto.identifier,
          workspaceId: ws.id,
          content: { stories, subtasks },
          pools: {
            claim: await pool('claim', shape.pools.claim),
            run: await pool('run', shape.pools.run),
            write: await pool('write', shape.pools.write),
            parents,
          },
          readPlanIds: [],
          scratchPlanIds: [],
        },
      });
    }
    // Read plans live in the workspace's first project, `planned`, fixed size.
    const first = list[0]!;
    const plans = await listPlanTitles(first.dto.id, first.writer.ctx);
    for (let r = 0; r < shape.readPlansPerWorkspace; r++) {
      const planTitle = title(tag, `read plan ${r}`);
      const hit = plans.find((pl) => pl.title === planTitle && pl.status === 'planned');
      first.manifest.readPlanIds.push(
        hit ? hit.id : await createReadPlan(first.dto.id, planTitle, first.writer.ctx),
      );
    }
    projectsByWs[w] = list;
  });
  const allProjects = projectsByWs.flat();
  log(`projects: ${allProjects.length} (backlog, pools and read plans in place)`);

  // 4. The tag's previous tokens go: their plaintext is unrecoverable, so a re-seed
  //    can only replace them.
  let deleted = 0;
  await mapLimit(userRows, async (user) => {
    for (const t of await apiTokensService.listForUser(user.id)) {
      if (t.label.startsWith(tokenLabelPrefix(tag))) {
        await apiTokensService.deleteToken(user.id, t.id);
        deleted++;
      }
    }
  });
  if (deleted > 0) log(`deleted ${deleted} previous ${tag} tokens (new ones are minted below)`);

  // 5. Agents: one token per (user, workspace, role, i), bound round-robin to the
  //    workspace's projects. A `run` token holds `runTokenGrant` (above) bound to a
  //    project — the legal "chosen grant + project" shape (`assertLegalBinding`);
  //    every other role takes the project default (permissions omitted). That
  //    default is everything the member can confer minus `work_item:delete`, which
  //    for a workspace member includes `work_item:edit` (create_plan,
  //    update/transition) and `ai:view_plan` (add_plan_items) — the seed test
  //    asserts both. CLI_TOKEN_GRANT deliberately lacks `ai:view_plan`: a run token
  //    never appends.
  interface AgentSlot {
    u: number;
    w: number;
    role: AgentRole;
    i: number;
  }
  const slots: AgentSlot[] = [];
  for (let u = 0; u < shape.users; u++) {
    for (const w of workspacesOfUser(shape, u)) {
      for (const role of AGENT_ROLES) {
        for (let i = 0; i < shape.agentRoles[role]; i++) slots.push({ u, w, role, i });
      }
    }
  }
  const runGrants = new Map<string, Promise<PermissionKey[]>>();
  const runGrant = (userId: string, workspaceId: string, projectId: string) => {
    const k = `${userId}:${projectId}`;
    if (!runGrants.has(k)) {
      runGrants.set(
        k,
        apiTokensService
          .listGrantablePermissions(userId, workspaceId, projectId)
          .then((grantable) => runTokenGrant(grantable)),
      );
    }
    return runGrants.get(k)!;
  };
  const perWsCursor = new Map<number, number>();
  const agents: ManifestAgent[] = await mapLimit(slots, async (slot) => {
    const user = userRows[slot.u]!;
    const ws = workspaceRows[slot.w]!;
    const list = projectsByWs[slot.w]!;
    const n = perWsCursor.get(slot.w) ?? 0;
    perWsCursor.set(slot.w, n + 1);
    const project = list[n % list.length]!;
    const minted = await apiTokensService.create(user.id, ws.id, {
      label: `${tokenLabelPrefix(tag)}${slot.role}:w${slot.w}:u${slot.u}:${slot.i}`,
      projectId: project.dto.id,
      ...(slot.role === 'run'
        ? { permissions: await runGrant(user.id, ws.id, project.dto.id) }
        : {}),
    });
    return {
      tokenId: minted.dto.id,
      token: minted.token,
      role: slot.role,
      userId: user.id,
      workspaceId: ws.id,
      projectId: project.dto.id,
      projectKey: project.dto.identifier,
      scratchPlanIds: [],
    };
  });
  log(
    `agents: ${agents.length} (${AGENT_ROLES.map((r) => `${r} ${agents.filter((a) => a.role === r).length}`).join(', ')})`,
  );

  // 6. Burst pools (the first `burstAgents` write agents) and scratch plans (every
  //    write agent). Both are keyed by the agent's position among the write agents,
  //    which is deterministic, so a re-seed finds the same cards and plans.
  const projectById = new Map(allProjects.map((p) => [p.dto.id, p]));
  const writeAgents = agents.filter((a) => a.role === 'write');
  await mapLimit(writeAgents, async (agent, b) => {
    const project = projectById.get(agent.projectId)!;
    const { writer } = project;
    if (b < shape.burstAgents) {
      const parents: [ManifestCard, ManifestCard] = [
        await writer.story(`burst ${b} parent A`),
        await writer.story(`burst ${b} parent B`),
      ];
      const cards: ManifestCard[] = [];
      for (let i = 0; i < shape.burstSize; i++) {
        cards.push(await writer.leaf(`burst ${b} card ${i}`, parents[0]));
      }
      agent.burst = { cards, parents };
    }
    const plans = await listPlanTitles(project.dto.id, writer.ctx);
    for (let s = 0; s < shape.scratchPlans; s++) {
      const planTitle = title(tag, `scratch ${b}.${s}`);
      const hit = plans.find((pl) => pl.title === planTitle && pl.status === 'generating');
      const id = hit
        ? await freshScratchPlan(hit.id, project.dto.id, planTitle, writer.ctx)
        : await createScratchPlan(project.dto.id, planTitle, writer.ctx);
      agent.scratchPlanIds.push(id);
      project.manifest.scratchPlanIds.push(id);
    }
  });
  log(
    `burst agents: ${Math.min(shape.burstAgents, writeAgents.length)} × ${shape.burstSize} cards; scratch plans: ${writeAgents.length * shape.scratchPlans}`,
  );

  // 7. Readers: pin the workspace and its active project, mint the session, and
  //    refuse a user the two-factor policy would hold.
  let lifetimeSeconds = 0;
  const users: ManifestUser[] = await mapLimit(userRows, async (user, u) => {
    const memberships = workspacesOfUser(shape, u);
    const readerWs = workspaceRows[memberships[0]!]!;
    const readerProject = projectsByWs[memberships[0]!]![0]!.dto;
    await projectsService.setActiveProject({
      userId: user.id,
      workspaceId: readerWs.id,
      projectId: readerProject.id,
    });
    if ((await resolveTwoFactorHold(user.id)) !== null) throw new TwoFactorHoldError(user.email);
    const session = await mintSessionCookie(user.id);
    lifetimeSeconds = session.lifetimeSeconds;
    return {
      id: user.id,
      email: user.email,
      cookieName: session.cookieName,
      readerWorkspaceId: readerWs.id,
      readerProjectId: readerProject.id,
      cookieHeader: `${session.cookieName}=${session.cookieValue}; ${WORKSPACE_COOKIE_NAME}=${readerWs.id}`,
      workspaceIds: memberships.map((w) => workspaceRows[w]!.id),
    };
  });
  log(`sessions: ${users.length} (no two-factor hold)`);

  // 8. Put every consumable card back — a no-op on a first seed, the reset on a re-seed.
  const manifest: SeedManifest = {
    version: MANIFEST_VERSION,
    runTag: tag,
    seededAt: new Date().toISOString(),
    baseUrl: resolveBaseUrlTrimmed(),
    databaseHost: target.databaseHost,
    sessionLifetimeSeconds: lifetimeSeconds,
    sessionsExpireAt: new Date(Date.now() + lifetimeSeconds * 1000).toISOString(),
    shape,
    users,
    agents,
    workspaces: workspaceRows.map((ws, w): ManifestWorkspace => {
      const bound = agents.filter((a) => a.workspaceId === ws.id);
      const counts = Object.fromEntries(
        AGENT_ROLES.map((r) => [r, bound.filter((a) => a.role === r).length]),
      ) as Record<AgentRole, number>;
      return {
        id: ws.id,
        name: ws.name,
        ownerUserId: userRows[w]!.id,
        projectIds: projectsByWs[w]!.map((p) => p.dto.id),
        agentCounts: { ...counts, total: bound.length },
      };
    }),
    projects: allProjects.map((p) => p.manifest),
  };
  await restorePools(manifest, log);
  return manifest;
}

// ── The reset ───────────────────────────────────────────────────────────────

async function restorePools(manifest: SeedManifest, log: (line: string) => void) {
  const ownerOf = new Map(manifest.workspaces.map((w) => [w.id, w.ownerUserId]));
  const ctxOf = (workspaceId: string): ServiceContext => ({
    userId: ownerOf.get(workspaceId)!,
    workspaceId,
  });
  const jobs: { id: string; parentId: string; ctx: ServiceContext }[] = [];
  for (const p of manifest.projects) {
    const ctx = ctxOf(p.workspaceId);
    for (const name of ['claim', 'run', 'write'] as const) {
      for (const c of p.pools[name])
        jobs.push({ id: c.id, parentId: p.pools.parents[name].id, ctx });
    }
  }
  for (const a of manifest.agents) {
    if (!a.burst) continue;
    for (const c of a.burst.cards) {
      jobs.push({ id: c.id, parentId: a.burst.parents[0].id, ctx: ctxOf(a.workspaceId) });
    }
  }
  await mapLimit(jobs, (j) => restoreCard(j.id, j.parentId, j.ctx));
  log(`pool cards restored: ${jobs.length}`);
}

/**
 * Put the pools back to their seeded state without re-seeding: claimed or run cards
 * go back to `todo` and are unassigned, burst cards return to their first parent,
 * and grown scratch plans are replaced with fresh `generating` ones (read plans are
 * left alone). Users, sessions and tokens are kept. Returns the rewritten manifest.
 */
export async function resetPools(
  manifest: SeedManifest,
  log: (line: string) => void = () => {},
): Promise<SeedManifest> {
  await restorePools(manifest, log);
  const ownerOf = new Map(manifest.workspaces.map((w) => [w.id, w.ownerUserId]));
  const writeAgents = manifest.agents.filter((a) => a.role === 'write');
  const replaced = new Map<string, string>();
  await mapLimit(writeAgents, async (agent, b) => {
    const ctx: ServiceContext = {
      userId: ownerOf.get(agent.workspaceId)!,
      workspaceId: agent.workspaceId,
    };
    agent.scratchPlanIds = await Promise.all(
      agent.scratchPlanIds.map(async (planId, s) => {
        const fresh = await freshScratchPlan(
          planId,
          agent.projectId,
          title(manifest.runTag, `scratch ${b}.${s}`),
          ctx,
        );
        if (fresh !== planId) replaced.set(planId, fresh);
        return fresh;
      }),
    );
  });
  for (const p of manifest.projects) {
    p.scratchPlanIds = p.scratchPlanIds.map((id) => replaced.get(id) ?? id);
  }
  log(`scratch plans replaced: ${replaced.size}`);
  return manifest;
}
