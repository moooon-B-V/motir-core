// Repository-set E2E seed + the fake GitHub's control/journal (Story MOTIR-1775 ·
// MOTIR-1785).
//
// The Story's claim is that an APPROVED PLAN gets the project as many repositories
// as its architecture needs, before any executor runs — so the seed builds the
// state the journey STARTS from and nothing further: a tenant with a `planned`
// plan whose proposals pin repo ROLES. Everything after that (the approve, the
// derivation into rows, the create, the invitations, the pins) is the SHIPPED path
// the spec drives and asserts, never something set up behind its back.
//
// Seeds ride the real services — the one sanctioned cross-layer reach for E2E
// setup, the same convention `plans-review-seed.ts` and `backlog-seed.ts` use.
//
// The GitHub half is faked at the HTTP boundary inside the Next server
// (`lib/test-github-repos-mock.ts`), so this module's other job is the runner's
// side of that seam: WRITE the control file (what GitHub should do) and READ the
// journal (what it was actually asked). No real repository is ever created.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { plansService } from '@/lib/services/plansService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { withUserContext } from '@/lib/workspaces/context';
import { seedGithubInstallation } from './github-seed';
import type { GithubCall, GithubReposControl } from '@/lib/test-github-repos-mock';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/** Satisfies the credential-strength rule (same shape as the sibling seeds'). */
export const REPO_SET_PASSWORD = 'repo-set-e2e-pass-7';

/** The GitHub LOGIN the connected identity carries — who the invitations go to. */
export const REPO_SET_LOGIN = 'e2e-octocat';

export interface RepositorySetSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  /** `PROD-<n>`-style project key — how `/api/ready/next` is addressed. */
  projectKey: string;
  /** The project's slug — the stem every derived repo name is built from (ADR §1.4). */
  projectSlug: string;
  /** The `planned` plan the SPEC approves (on camera, for the headline journey). */
  planId: string;
  /** The titles the plan's `add` proposals carry, by role. */
  frontendTitle: string;
  backendTitle: string;
  /** `<slug>-web` / `<slug>-api` — what the derivation names the two rows. */
  webRepoName: string;
  apiRepoName: string;
}

export interface SeedRepositorySetOptions {
  /** The repo roles the plan's proposals pin — the derivation's PRIMARY signal.
   *  Two roles propose two rows; one role proposes one (the degenerate case). */
  roles?: readonly ProjectRepoRoleDto[];
  /** Connect a GitHub IDENTITY (grant 1) — what the access step invites. Omit for
   *  the no-identity journey, which must reach the connect prompt, not a failure. */
  withIdentity?: boolean;
  /** Bind an App INSTALLATION (grant 2) — what puts the user on the TECHNICAL
   *  path, where rows, names and per-row state are visible at all. */
  withInstallation?: boolean;
}

/** Give the user a connected GitHub identity — grant 1, the ONLY thing the access
 *  step needs (there is no permission to ask for; see `AccessStep`'s header). */
export async function connectGithubIdentity(
  userId: string,
  login: string = REPO_SET_LOGIN,
): Promise<void> {
  await withUserContext(userId, (tx) =>
    githubIdentityRepository.upsertForUser(
      {
        userId,
        githubUserId: '4242',
        githubLogin: login,
        avatarUrl: 'https://avatars.example/e2e-octocat.png',
        accessTokenEncrypted: 'encrypted-not-read-here',
      },
      tx,
    ),
  );
}

/**
 * A tenant whose plan is READY TO REVIEW and pins the given repo roles.
 *
 * The plan is left `planned` on purpose: approving it is the journey's first
 * step, and the whole point of the Story is what approval PRODUCES. A seed that
 * approved for the spec would assert a set it had arranged rather than one the
 * product derived.
 */
export async function seedRepositorySet(
  email: string,
  projectName: string,
  identifier: string,
  options: SeedRepositorySetOptions = {},
): Promise<RepositorySetSeed> {
  const { roles = ['web', 'api'], withIdentity = false, withInstallation = false } = options;

  const owner = await usersService.createUser({
    email,
    password: REPO_SET_PASSWORD,
    name: 'Repo Set Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Repo Set E2E — ${identifier}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: projectName,
    identifier,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin the project active so the active-project-scoped surfaces (/plans, /items)
  // resolve it on sign-in — the same pin the sibling seeds do.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  if (withIdentity) await connectGithubIdentity(owner.id);
  if (withInstallation) await seedGithubInstallation(workspace.id);

  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };

  // The plan whose ARCHITECTURE separates the app people use from the service
  // behind it — the roles are what make the derivation propose two rows without
  // anybody being asked a question (ADR §0.1.1).
  const frontendTitle = 'Build the booking screen';
  const backendTitle = 'Build the availability service';
  const plan = await plansService.createPlan(
    project.id,
    {
      title: 'Ship online booking',
      summary: 'A booking screen for customers, and the availability service behind it.',
    },
    ctx,
  );
  await plansService.addProposals(
    plan.id,
    roles.map((role) => ({
      op: 'add' as const,
      proposedFields: {
        title: role === 'api' ? backendTitle : frontendTitle,
        kind: 'task' as const,
        targetRepoRole: role,
      },
    })),
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);

  // The slug is derived from the NAME and may take a uniquifying suffix, so read
  // it back rather than re-deriving it — the repo names the spec asserts are
  // built from whatever the project actually got.
  const row = await db.project.findUniqueOrThrow({
    where: { id: project.id },
    select: { slug: true, identifier: true },
  });

  return {
    email,
    password: REPO_SET_PASSWORD,
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: row.identifier,
    projectSlug: row.slug,
    planId: plan.id,
    frontendTitle,
    backendTitle,
    // ADR §1.4: `<slug>-<role>` at two or more rows, bare `<slug>` at one.
    webRepoName: roles.length > 1 ? `${row.slug}-web` : row.slug,
    apiRepoName: `${row.slug}-api`,
  };
}

// ── The fake GitHub's two files ────────────────────────────────────────────────

function controlPath(): string {
  const path = process.env['MOTIR_GITHUB_CONTROL_PATH'];
  if (!path) throw new Error('MOTIR_GITHUB_CONTROL_PATH is not set — check the acceptance config.');
  return path;
}

function journalPath(): string {
  const path = process.env['MOTIR_GITHUB_JOURNAL_PATH'];
  if (!path) throw new Error('MOTIR_GITHUB_JOURNAL_PATH is not set — check the acceptance config.');
  return path;
}

/**
 * The current fixture generation. Carried on every control write so the mock can
 * tell a RESET from a mid-test behaviour change: only the former makes it forget
 * which repositories it has already made. A wall-clock stamp rather than a
 * counter, so it is still monotonic when two spec FILES run in separate runner
 * processes against one long-lived server.
 */
let epoch = Date.now();

/**
 * Tell the fake GitHub how to behave. Re-read by the mock on EVERY request, so a
 * spec can force a create to fail, then clear the failure and assert the RETRY
 * succeeds — the partial-outcome scenario, driven rather than simulated.
 *
 * The epoch is carried through unchanged: changing GitHub's behaviour must not
 * also wipe the repositories it has already made, or a retry would create a
 * second one instead of adopting.
 */
export function setGithubControl(control: GithubReposControl): void {
  writeFileSync(controlPath(), JSON.stringify({ ...control, epoch }), 'utf8');
}

/**
 * Clear both files AND the fake's memory of every repository it made.
 *
 * Call it beside `resetDatabase()`: the two have to move together. The DB reset
 * removes the tenant, so the next test can legitimately derive the SAME project
 * slug — and a fake that still remembered the old repository would answer the
 * create with 422 `already exists` and send the shipped primitive down its ADOPT
 * path, silently testing something else.
 */
export function resetGithubFixture(): void {
  epoch = Date.now();
  writeFileSync(controlPath(), JSON.stringify({ epoch }), 'utf8');
  rmSync(journalPath(), { force: true });
  writeFileSync(journalPath(), '', 'utf8');
}

/** Every call the fake GitHub was asked to serve, in order. JSONL, so a partially
 *  flushed last line is dropped rather than throwing. */
export function githubJournal(): GithubCall[] {
  let raw: string;
  try {
    raw = readFileSync(journalPath(), 'utf8');
  } catch {
    return [];
  }
  const calls: GithubCall[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      calls.push(JSON.parse(line) as GithubCall);
    } catch {
      /* a torn final line — the next read will have it whole */
    }
  }
  return calls;
}

/** The collaborator INVITES, in order — `PUT /repos/{owner}/{repo}/collaborators/{login}`. */
export function collaboratorInvites(): GithubCall[] {
  return githubJournal().filter(
    (c) => c.method === 'PUT' && /\/collaborators\/[^/]+$/.test(c.path),
  );
}

/** The repository CREATES, in order — the template `generate` and the
 *  initialised `POST /orgs/{org}/repos` both count, since both make a repo. */
export function repoCreates(): GithubCall[] {
  return githubJournal().filter(
    (c) =>
      c.method === 'POST' && (/\/generate$/.test(c.path) || /^\/orgs\/[^/]+\/repos$/.test(c.path)),
  );
}
