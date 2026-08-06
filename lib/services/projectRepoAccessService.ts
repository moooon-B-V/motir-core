import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { projectRepoCollaboratorRepository } from '@/lib/repositories/projectRepoCollaboratorRepository';
import { repoCollaboratorClient } from '@/lib/github/repoCollaborators';
import { deriveAccessState, needsCollaboratorInvite } from '@/lib/projectRepos/access';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type {
  GrantTeamAccessResultDto,
  ProjectRepoDto,
  ProjectRepoMemberAccessDto,
  ProjectRepoTeamAccessDto,
  ProjectRepoTeamAccessRowDto,
} from '@/lib/dto/projectRepos';

// COLLABORATOR ACCESS — getting the TEAM into the code Motir made them (Story
// MOTIR-1775 · MOTIR-1900, generalised by MOTIR-1910).
//
// ⚠️ THE GAP THIS CLOSES. The ADR's ownership amendment (MOTIR-1893) made every
// new project's repositories Motir-owned and PRIVATE. Nobody on the team is a
// member of Motir's org, so from that moment they could not clone their own code.
// MOTIR-1900 closed that for exactly ONE person — the approving user — because
// the record it wrote was four columns on the repository row, which hold one
// account. On the six-person workspace Motir dogfoods, five members were still
// locked out, with nowhere in the schema to record letting them in. MOTIR-1910
// replaced those columns with a per-`(repository × user)` record and generalised
// this service over it.
//
// ⚠️ WHO IS INVITED — `canEdit`, never a raw membership query (ADR §3 Q1). The
// invitable set is exactly the members the shipped project-access policy already
// lets EDIT the project, enumerated with the same access-level scoping
// `assignableMembersService` applies. Motir does not invent a second membership
// rule for code. That is load-bearing rather than tidy: on an `open` project any
// workspace member edits with NO `ProjectMembership` row at all, and a workspace
// owner/admin passes regardless of project membership — so a membership-row query
// would have locked out precisely the people who can already change everything in
// the project, its owner included.
//
// ⚠️ AT WHAT LEVEL — `push` for a teammate, `admin` only for the approving user
// (ADR §3 Q2). A teammate clones, branches and pushes; they do not transfer,
// rename or delete the project's repositories. That is why the permission is a
// COLUMN on the record rather than the module constant MOTIR-1900 shipped.
//
// ⚠️ WHOSE ACCOUNT — each member's OWN connected `GithubIdentity`, never a typed
// handle (a typo would invite a stranger to a private repository) and never
// resolved on anyone's behalf: Motir cannot OAuth for a teammate, so a member
// with no identity is reported as not-invited WITH A REASON, and the prompt to
// fix it is theirs alone (ADR §3 Q3).
//
// ⚠️ `created` ROWS ONLY (`needsCollaboratorInvite`). A `connected` row is a
// repository the user already owns and granted Motir; handing out access to it
// would be Motir sharing something that was never its to share. A `skipped` or
// `failed` row has nothing to be invited to.
//
// ⚠️ NEVER FAILS THE ROW, AND NEVER FAILS A SIBLING. Access is granted AFTER the
// repository exists and after its row is committed, so an invite that fails
// leaves a `created` row `created` and a real repository on GitHub — degrading to
// "not invited yet", which the UI renders with a way back to it. One member's
// refusal likewise leaves every other member's record untouched: the invitations
// that DID go out are real, and undoing them to make a report look tidy would be
// a lie about the world (ADR §4.2, one level down).
//
// ⚠️ NO CI GUARD LIVES HERE, and that is decided, not forgotten (ADR §3 Q5).
// Widening push access adds no enforcement surface: the allowance is per-SEAT and
// recomputed from org membership at read time, so a member who can push is a seat
// that already enlarged the pool; and the refusal that actually covers a push
// DISABLES ACTIONS on the repository (MOTIR-1907), which is count-independent.
// Do not add a per-member cap or a second refusal path here.
//
// SCOPE. Granting and observing access. It does not create repositories
// (MOTIR-1781), own the rows or the ADR §4.1 machine (MOTIR-1780), or render
// anything (MOTIR-1945).

/** What one SELF access pass did, and what the UI needs to render next. */
export interface GrantAccessResult {
  /** The project's rows AFTER the pass, in set order — so a caller renders from
   *  one result rather than re-reading to find out what changed. */
  rows: ProjectRepoDto[];
  /**
   * The GitHub login the pass invited, or null when the actor has none connected.
   *
   * Null is the CONNECT-PROMPT signal and the whole reason the prompt belongs
   * here rather than before approval: a user who has not connected cannot be
   * invited, so the ask is framed as "connect GitHub to get access to your code"
   * AFTER their plan is safe and their code exists — never as a gate in front of
   * either.
   */
  login: string | null;
  /** How many rows this pass sent (or re-sent) an invitation for. */
  invited: number;
  /** How many rows this pass could not invite because GitHub refused. Their state
   *  is unchanged and they stay retryable — nothing is rolled back. */
  failed: number;
}

/** One member as a team pass sees them, before any GitHub call. */
interface Candidate {
  userId: string;
  name: string;
  email: string;
  /** Whether `canEdit` admits them (ADR §3 Q1). */
  eligible: boolean;
  /** Their currently connected GitHub login, or null. */
  login: string | null;
}

export const projectRepoAccessService = {
  /**
   * Invite the ACTING member's connected GitHub account to this project's
   * Motir-created repositories.
   *
   * The self-serve path, unchanged in meaning by MOTIR-1910: it is what the
   * establish step's **Connect GitHub** return trip and a row's **Resend
   * invitation** call, and it answers "get ME into my code". It grants `admin` —
   * the level ADR §3 Q2 reserves to the approving user, who is who stands on the
   * step this is reached from.
   *
   * IDEMPOTENT AND RESUMABLE. An already-accepted record is left alone; every
   * other eligible row is invited, and GitHub treats a repeat on a pending
   * invitation as an update rather than a duplicate.
   *
   * SEQUENTIAL, like the creation primitive it follows: a set is 2–5 rows, so
   * serialising costs nothing and keeps the path clear of GitHub's secondary
   * limits. Each row's outcome is committed as it resolves — no transaction spans
   * the host calls — so a crash mid-set leaves a readable partial state the next
   * pass finishes.
   *
   * Throws only for a CALLER-level failure (the project not existing, or the actor
   * not being allowed to edit it — the gate `projectRepoSetService` already owns).
   * A row-level GitHub refusal is counted, never thrown.
   */
  async grantAccess(
    projectId: string,
    ctx: ServiceContext,
    options: { rowId?: string } = {},
  ): Promise<GrantAccessResult> {
    // The set read is the access gate: a missing project — or one in another
    // workspace, or one the actor may not browse — throws before anything reaches
    // GitHub or the identity table.
    const rows = await projectRepoSetService.listByProject(projectId, ctx);

    const identity = await githubIdentityService.getIdentityForUser(ctx.userId);
    if (!identity) return { rows, login: null, invited: 0, failed: 0 };

    let invited = 0;
    let failed = 0;
    for (const row of rows) {
      if (options.rowId !== undefined && row.id !== options.rowId) continue;
      if (!isInvitable(row)) continue;
      // Settled: the account can already clone. Re-inviting would be a request
      // that can only answer "already a collaborator".
      if (row.access.state === 'accepted' && row.access.login === identity.githubLogin) continue;

      const realized = row.realizedRepo;
      if (!realized) continue;
      const ok = await inviteOne({
        rowId: row.id,
        owner: realized.owner,
        repo: realized.name,
        userId: ctx.userId,
        login: identity.githubLogin,
        permission: 'admin',
        ctx,
      });
      if (ok) invited += 1;
      else failed += 1;
    }

    return {
      rows: await projectRepoSetService.listByProject(projectId, ctx),
      login: identity.githubLogin,
      invited,
      failed,
    };
  },

  /**
   * The TEAM matrix: every candidate member × every repository of the set, with
   * each cell's real access state (MOTIR-1910).
   *
   * READS ONLY — no GitHub round-trips — so a surface can render or poll it
   * cheaply; learning that a pending invitation has been accepted is
   * {@link refreshAccess}'s job, deliberately separate for the same reason it was
   * kept off the establish step's 1.5s poll.
   *
   * Every candidate appears, INCLUDING the members who cannot be invited: a list
   * that silently omitted them would answer "who has access?" while excluding the
   * people the reader is most likely looking for. Their `reason` is what makes
   * each absence legible, and the two reasons differ in who can act on them.
   */
  async listTeamAccess(projectId: string, ctx: ServiceContext): Promise<ProjectRepoTeamAccessDto> {
    const rows = await projectRepoSetService.listByProject(projectId, ctx);
    const candidates = await resolveCandidates(projectId, ctx);
    const records = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      (tx) =>
        projectRepoCollaboratorRepository.listByProjectRepoIds(
          rows.map((r) => r.id),
          ctx.workspaceId,
          tx,
        ),
    );

    // Keyed once rather than scanned per cell: the matrix is N × M, and a linear
    // find inside both loops turns a six-person three-repo project into 18 scans
    // of the whole record list for no reason.
    const byCell = new Map(records.map((r) => [`${r.projectRepoId}:${r.userId}`, r]));

    return {
      projectId,
      rows: rows.map<ProjectRepoTeamAccessRowDto>((row) => ({
        rowId: row.id,
        repoRef: row.realizedRepo?.repoRef ?? null,
        invitable: isInvitable(row),
        members: candidates.map<ProjectRepoMemberAccessDto>((c) => {
          const record = byCell.get(`${row.id}:${c.userId}`) ?? null;
          const state = deriveAccessState(record);
          return {
            userId: c.userId,
            name: c.name,
            email: c.email,
            eligible: c.eligible,
            // The RECORD's snapshot wins over the live identity: if the member
            // reconnected a different account, the invitation live on GitHub still
            // belongs to the OLD login, and this must report which account
            // actually holds access — not which one they have connected today.
            login: record?.githubLogin ?? c.login,
            permission: record?.permission ?? null,
            state,
            // Eligibility is checked FIRST: a member their role excludes is
            // settled, and telling them to connect GitHub would offer an action
            // that would not help.
            reason: !c.eligible
              ? 'role_cannot_edit'
              : c.login === null
                ? 'no_github_identity'
                : null,
            invitationUrl: state === 'invited' ? (record?.invitationUrl ?? null) : null,
            invitedAt: record?.invitedAt?.toISOString() ?? null,
            acceptedAt: record?.acceptedAt?.toISOString() ?? null,
          };
        }),
      })),
    };
  },

  /**
   * Invite the TEAM — every eligible member with a connected GitHub account — to
   * this project's Motir-created repositories (MOTIR-1910).
   *
   * `rowId` narrows to ONE repository and `userId` to ONE member; both together
   * are exactly one cell, which is what a per-row **Resend invitation** needs.
   * Rows and members are independent, so re-sending one must never quietly
   * re-send its neighbours.
   *
   * Sequential for the same reason `grantAccess` is — a set is 2–5 rows and a team
   * is a handful of people, so the whole pass is a small number of requests, and
   * serialising keeps it clear of GitHub's secondary rate limits. Each cell is
   * committed as it resolves.
   *
   * ⚠️ A member with no identity is COUNTED, not failed. It is not an error that
   * someone has not connected GitHub — it is the state their own connect prompt
   * resolves, and reporting it as a failure would put a red mark on the surface
   * for something nobody did wrong.
   */
  async grantTeamAccess(
    projectId: string,
    ctx: ServiceContext,
    options: { rowId?: string; userId?: string } = {},
  ): Promise<GrantTeamAccessResultDto> {
    // Inviting OTHER PEOPLE to a repository is `repository:manage_access`
    // (MOTIR-2299) — its own key, because a lead may decide who can clone the
    // code without administering the project. It was `assertCanEdit`, i.e. any
    // project MEMBER, and "can see the project" must never be enough to hand out
    // push access to its code. `grantAccess` above is the SELF-connect path and
    // deliberately keeps its browse gate: connecting your OWN identity is the one
    // action nobody can take on your behalf (project-repository-set ADR §3 Q3).
    await projectAccessService.assertPermission(projectId, ctx, 'repository:manage_access');
    const rows = await projectRepoSetService.listByProject(projectId, ctx);
    const candidates = await resolveCandidates(projectId, ctx);

    let invited = 0;
    let failed = 0;
    let skippedNoIdentity = 0;

    for (const row of rows) {
      if (options.rowId !== undefined && row.id !== options.rowId) continue;
      if (!isInvitable(row)) continue;
      const realized = row.realizedRepo;
      if (!realized) continue;

      for (const c of candidates) {
        if (options.userId !== undefined && c.userId !== options.userId) continue;
        if (!c.eligible) continue;
        if (c.login === null) {
          skippedNoIdentity += 1;
          continue;
        }
        const ok = await inviteOne({
          rowId: row.id,
          owner: realized.owner,
          repo: realized.name,
          userId: c.userId,
          login: c.login,
          // `admin` stays with the approving user, who is the actor on the only
          // path that reaches this — so a team sweep can never DOWNGRADE the level
          // MOTIR-1900 granted them while it grants everyone else `push`.
          permission: c.userId === ctx.userId ? 'admin' : 'push',
          ctx,
        });
        if (ok) invited += 1;
        else failed += 1;
      }
    }

    return {
      access: await this.listTeamAccess(projectId, ctx),
      invited,
      failed,
      skippedNoIdentity,
    };
  },

  /**
   * Re-read GitHub for every PENDING invitation and stamp the ones that have been
   * accepted.
   *
   * GitHub owns acceptance and tells Motir nothing when it happens, so a read is
   * the only honest way to learn it — which is why this is an explicit call the
   * access surface makes rather than something folded into the set read that the
   * establish step polls every 1.5s. Bounded by the pending RECORDS of one project
   * (a handful of rows × a handful of members), and best-effort per record: a
   * refresh that cannot reach GitHub leaves the record saying what it last knew,
   * which is better than reporting a granted account as uninvited.
   */
  async refreshAccess(projectId: string, ctx: ServiceContext): Promise<ProjectRepoDto[]> {
    const rows = await projectRepoSetService.listByProject(projectId, ctx);
    const records = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      (tx) =>
        projectRepoCollaboratorRepository.listByProjectRepoIds(
          rows.map((r) => r.id),
          ctx.workspaceId,
          tx,
        ),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    let changed = false;
    for (const record of records) {
      if (deriveAccessState(record) !== 'invited') continue;
      const realized = byId.get(record.projectRepoId)?.realizedRepo;
      if (!realized) continue;
      try {
        if (
          await repoCollaboratorClient.hasAccepted({
            owner: realized.owner,
            repo: realized.name,
            login: record.githubLogin,
          })
        ) {
          await projectRepoSetService.recordCollaboratorAccepted(
            record.projectRepoId,
            record.userId,
            ctx,
          );
          changed = true;
        }
      } catch (err) {
        console.error(
          `[projectRepoAccessService] could not read access for record ${record.id}:`,
          err,
        );
      }
    }

    return changed ? projectRepoSetService.listByProject(projectId, ctx) : rows;
  },

  /**
   * The POST-ESTABLISH hook: invite the actor to a row that has just become
   * `created`, if they have an identity to invite.
   *
   * Wired into `attachRealizedRepo` — the ONE seam every establish path goes
   * through — for the same reason the repo-pin resolution is (MOTIR-1913): neither
   * caller has to remember it and neither can drift.
   *
   * ⚠️ THE ACTOR ONLY, not the team, and that is deliberate. This runs inside the
   * establish flow, whose latency the user is watching; fanning out to every
   * member would put N GitHub round-trips on it to grant access nobody is waiting
   * for at that instant. The team is invited from its own surface, which is also
   * the only place a member can be told WHY they were not.
   *
   * ⚠️ SWALLOWS EVERYTHING. The repository exists and the row is established by
   * the time this runs; reporting a settled row as failed because an invitation
   * did not go out would be a worse lie than "not invited yet", which the UI
   * renders with its own way forward. On the default path the actor usually has NO
   * identity yet — the connect prompt comes AFTER the code exists — so the common
   * outcome here is deliberately "nothing happened", and the access step is what
   * completes it.
   */
  async inviteAfterEstablish(rowId: string, projectId: string, ctx: ServiceContext): Promise<void> {
    try {
      await this.grantAccess(projectId, ctx, { rowId });
    } catch (err) {
      console.error(
        `[projectRepoAccessService] could not grant access after establishing row ${rowId}:`,
        err,
      );
    }
  },
};

/**
 * Send ONE invitation and record it. Returns false when GitHub refused — counted
 * by the caller, never thrown, so one member's refusal cannot cost the pass.
 */
async function inviteOne(args: {
  rowId: string;
  owner: string;
  repo: string;
  userId: string;
  login: string;
  permission: 'push' | 'admin';
  ctx: ServiceContext;
}): Promise<boolean> {
  try {
    const result = await repoCollaboratorClient.invite({
      // The REALIZED repo's own coordinates, in GitHub's casing — not the row's
      // authored name and not the configured org, so a repository that was
      // renamed or moved on the host still resolves.
      owner: args.owner,
      repo: args.repo,
      login: args.login,
      permission: args.permission,
    });
    await projectRepoSetService.recordCollaboratorInvite(
      args.rowId,
      {
        userId: args.userId,
        login: args.login,
        permission: args.permission,
        invitationUrl: result.invitationUrl,
        alreadyHasAccess: result.alreadyHasAccess,
      },
      args.ctx,
    );
    return true;
  } catch (err) {
    // The repository EXISTS and the record is untouched. Losing the whole pass
    // because one member of one row could not be invited is exactly what per-record
    // independence forbids, so this is reported and the loop continues.
    console.error(
      `[projectRepoAccessService] could not invite ${args.login} to row ${args.rowId}:`,
      err,
    );
    return false;
  }
}

/**
 * The project's candidate members, each tagged with whether the shipped access
 * policy lets them EDIT it (ADR §3 Q1) and which GitHub account they have
 * connected.
 *
 * Enumerated through `assignableMembersService`, the shipped chokepoint for "who
 * is in scope for this project", which already applies the access-level scoping
 * (`private` → the project's own memberships; every other level → the workspace's
 * members). Reusing it is what keeps code access from drifting into a second,
 * parallel notion of membership — and the `canEdit` pass on top is what turns
 * "in scope" into "may be handed the code".
 */
async function resolveCandidates(projectId: string, ctx: ServiceContext): Promise<Candidate[]> {
  // Read directly through the repository leaf: this needs ONE field (the access
  // level that scopes the enumeration), and every caller has already been gated —
  // `listByProject` asserts browse, `grantTeamAccess` asserts edit — so routing it
  // through a second gating service would re-run a check that has already passed.
  const project = await projectRepository.findById(projectId);
  if (!project || project.workspaceId !== ctx.workspaceId) return [];
  const members = await assignableMembersService.list({
    projectId,
    accessLevel: project.accessLevel,
    ctx,
  });
  const userIds = members.map((m) => m.userId);

  const [identities, eligibility] = await Promise.all([
    withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId }, (tx) =>
      githubIdentityRepository.findLoginsByUserIds(userIds, tx),
    ),
    projectAccessService.resolveCanEditForUsers(projectId, userIds, ctx),
  ]);
  const loginByUser = new Map(identities.map((i) => [i.userId, i.githubLogin]));

  return members.map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    eligible: eligibility.get(m.userId) ?? false,
    login: loginByUser.get(m.userId) ?? null,
  }));
}

/** A row that CAN hold invitations: Motir made the repository, and the repository
 *  is still there. Both halves — a `created` row whose mirror row has since been
 *  deleted has no coordinates to invite against. */
function isInvitable(row: ProjectRepoDto): boolean {
  return needsCollaboratorInvite(row.state) && row.realizedRepo !== null;
}
