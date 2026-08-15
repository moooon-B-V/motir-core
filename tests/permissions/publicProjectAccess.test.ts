import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { projectSquareService } from '@/lib/services/projectSquareService';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The PUBLIC-project read path under the non-bypass role (MOTIR-2684 ·
// `docs/rls-runtime-role-inventory.md` Finding 4's one un-bindable branch).
//
// `projectAccessService.resolvePublicInputs` is the SINGLE place the
// workspace-equality 404 guard is skipped, and the entry point for every public
// surface (`getPublicCapabilities`, `assertCanBrowsePublic`, the 6.12.5 / 6.12.6
// write grants, `publicRequestsService`, `publicProjectsService`). It cannot use
// MOTIR-2569's `tenantRead` binding, and the reason is structural: the actor is
// nullable and may be CROSS-ORG, so there is no `userId` to bind, and the
// workspace is the PROJECT'S own — the very thing the read is resolving.
//
// Before this card the `project` table carried exactly ONE policy,
// `project_workspace_or_system_read`, whose USING is `workspaceId = GUC OR
// system_admin`. A public read binds neither, so under `TEST_DB_APP_ROLE=1` —
// and in production after the MOTIR-2515 cutover — every public surface 404'd
// for everyone, including a team's own logged-out view of their own project.
//
// ⚠️ THE ADMIT ASSERTIONS ARE THE POINT, and they come first in every describe.
// A path that refuses EVERYONE passes every denial test ever written — that is
// the MOTIR-2569 lesson, and it is exactly the defect this file exists to catch
// wearing the costume of a security property. Each direction is proved.
//
// TWO LAYERS, deliberately:
//   * `describe('the policies')` drops to raw SQL under `SET LOCAL ROLE
//     motir_app` (the `tests/project-rls.test.ts` shape). RLS is inert under the
//     `prodect` superuser (BYPASSRLS), so the role switch is what makes these
//     assertions mean anything — and it makes them mean the SAME thing whether
//     or not `TEST_DB_APP_ROLE` is set.
//   * `describe('the service path')` goes through `@/lib/db`, which IS the app
//     role under the flag and the owner without it. Every assertion below holds
//     identically in both modes — a mode-split expectation here would re-open
//     the hole this card closes.
//
// The fixture writes through `adminDb` (the owner): it seeds two tenants, which
// is precisely what the policies forbid.

interface Tenant {
  ownerId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
  projectIdentifier: string;
  workItemId: string;
  workflowStatusId: string;
}

/** The public project's tenant. */
let host: Tenant;
/** A second, unrelated tenant whose project stays non-public. */
let neighbour: Tenant;
/** An account in NEITHER tenant — the cross-org authenticated public viewer. */
let outsiderId: string;

beforeEach(async () => {
  await truncateAuthTables();
  host = await seedTenant('host', 'HOST', 'public');
  neighbour = await seedTenant('nbr', 'NBR', 'limited');
  const outsider = await adminDb.user.create({
    data: { email: 'outsider@example.com', name: 'Outsider' },
  });
  outsiderId = outsider.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the policies', () => {
  it('ADMITS a public project on SELECT with no workspace bound', async () => {
    // The defect, stated as the thing that must now be true. Nothing is bound —
    // no `app.workspace_id`, no `app.user_id`, no `app.system_admin` — which is
    // exactly the context an anonymous reader arrives in.
    const rows = await asAppRole({}, (tx) => selectProject(tx, host.projectId));
    expect(rows).toHaveLength(1);
  });

  it('admits NOTHING ELSE unbound — open, limited and private stay invisible', async () => {
    // The other direction, and the one that proves the arm is a public arm
    // rather than a hole. Each of the three non-public levels in turn, on the
    // SAME row, so the only variable is `accessLevel`.
    for (const level of ['open', 'limited', 'private'] as const) {
      await adminDb.project.update({ where: { id: host.projectId }, data: { accessLevel: level } });
      const rows = await asAppRole({}, (tx) => selectProject(tx, host.projectId));
      expect(rows, `accessLevel=${level} must stay invisible unbound`).toHaveLength(0);
    }
  });

  it('still hides a NON-public project from a foreign workspace’s bound context', async () => {
    // The pre-existing tenancy guarantee, unchanged: binding workspace A does
    // not reveal workspace B's `limited` project.
    const rows = await asAppRole({ workspaceId: host.workspaceId }, (tx) =>
      selectProject(tx, neighbour.projectId),
    );
    expect(rows).toHaveLength(0);
  });

  it('leaves WITH CHECK untouched — INSERT into a foreign workspace is refused', async () => {
    // `WITH CHECK` is the cross-tenant WRITE guard, and the new arm is SELECT-only
    // precisely so this stays exactly as strong as it was. 42501 is the
    // row-security violation (the same code `tests/project-rls.test.ts` pins).
    await expect(
      asAppRole(
        { workspaceId: host.workspaceId },
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "project" ("id", "workspaceId", "name", "slug", "identifier", "accessLevel", "createdAt", "updatedAt")
          VALUES (${'ins-' + neighbour.projectId}, ${neighbour.workspaceId}, 'Smuggled', 'smuggled', 'SMG', 'public', now(), now())
        `,
      ),
    ).rejects.toMatchObject({ meta: { driverAdapterError: { cause: { code: '42501' } } } });
  });

  it('leaves WITH CHECK untouched — a PUBLIC row cannot be UPDATEd into a foreign workspace', async () => {
    // The mirror case, and the one the SELECT arm could plausibly have opened:
    // the row is now VISIBLE unbound, so if the arm had been `FOR ALL` the
    // UPDATE's USING would pass too. It is `FOR SELECT`, so the FOR-ALL policy
    // still governs the write and the post-image still fails WITH CHECK.
    await expect(
      asAppRole(
        { workspaceId: host.workspaceId },
        (tx) =>
          tx.$executeRaw`
          UPDATE "project" SET "workspaceId" = ${neighbour.workspaceId} WHERE "id" = ${host.projectId}
        `,
      ),
    ).rejects.toMatchObject({ meta: { driverAdapterError: { cause: { code: '42501' } } } });
  });

  it('does NOT let an unbound reader DELETE the public project it can now read', async () => {
    // READ-ONLY is the whole claim. An unbound DELETE matches zero rows through
    // the FOR-ALL policy's USING, so the row survives — asserted on the row
    // rather than on the statement, because "0 rows affected" is not an error.
    await asAppRole(
      {},
      (tx) => tx.$executeRaw`DELETE FROM "project" WHERE "id" = ${host.projectId}`,
    );
    const survivor = await adminDb.project.findUnique({ where: { id: host.projectId } });
    expect(survivor).not.toBeNull();
  });

  it('ADMITS a public project’s work items unbound, and refuses a non-public one’s', async () => {
    // The public surfaces (board / roadmap / work-items / a public request) all
    // read `work_item` on the same context-less path, so the project arm alone
    // resolves the project and then hands back an empty board.
    const admitted = await asAppRole({}, (tx) => selectWorkItem(tx, host.workItemId));
    expect(admitted).toHaveLength(1);
    const refused = await asAppRole({}, (tx) => selectWorkItem(tx, neighbour.workItemId));
    expect(refused).toHaveLength(0);
  });

  it('does not widen a BOUND tenant read — a foreign public project’s items stay hidden', async () => {
    // The work-item arm is deliberately narrower than the project arm: it fires
    // ONLY when no workspace is bound. A tenant session keeps exactly the rows
    // it had before, so neither the visible set nor the planner's index path on
    // the product's hottest table changes for a normal request.
    const rows = await asAppRole({ workspaceId: neighbour.workspaceId }, (tx) =>
      selectWorkItem(tx, host.workItemId),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the vote arm (MOTIR-2811)', () => {
  // The project square renders each public project's DEMAND — how many people
  // upvoted its requests — to a reader with no account. Before this arm the only
  // policy on `public_request_vote` admitted the vote's OWNER or the system flag,
  // and an anonymous square reader is neither, so every project showed zero.
  //
  // It is the one read in MOTIR-2796 a binding cannot fix: the square is
  // cross-project and cross-TENANT by construction, so there is no single
  // workspace to bind and inventing one would presume the answer.

  it('ADMITS a public project’s votes with no workspace bound', async () => {
    await seedVote(host);
    const rows = await asAppRole({}, (tx) => selectVotes(tx, host.workItemId));
    expect(rows).toHaveLength(1);
  });

  it('admits NOTHING ELSE unbound — a vote on a non-public project stays invisible', async () => {
    // The direction that makes this a public arm rather than a hole. A vote is a
    // row about a PERSON's interest, so a too-wide arm here leaks who wants what.
    await seedVote(neighbour);
    const rows = await asAppRole({}, (tx) => selectVotes(tx, neighbour.workItemId));
    expect(rows).toHaveLength(0);

    // And on the SAME row, so the only variable is the project's accessLevel:
    // flipping the host project off `public` must take its votes back out of view.
    await seedVote(host);
    for (const level of ['open', 'limited', 'private'] as const) {
      await adminDb.project.update({ where: { id: host.projectId }, data: { accessLevel: level } });
      const hidden = await asAppRole({}, (tx) => selectVotes(tx, host.workItemId));
      expect(hidden, `accessLevel=${level} must hide its votes unbound`).toHaveLength(0);
    }
  });

  it('leaves a WORKSPACE-BOUND read exactly as it was', async () => {
    // The arm is gated on there being NO bound workspace, so a tenant session
    // keeps precisely the visible set it had: its own votes are governed by the
    // owner-or-system policy, which the outsider's vote does not satisfy, and a
    // neighbour's votes stay invisible either way.
    await seedVote(host);
    await seedVote(neighbour);

    const own = await asAppRole({ workspaceId: host.workspaceId, userId: host.ownerId }, (tx) =>
      selectVotes(tx, host.workItemId),
    );
    expect(own, 'a bound session does not gain the public arm').toHaveLength(0);

    const foreign = await asAppRole({ workspaceId: host.workspaceId }, (tx) =>
      selectVotes(tx, neighbour.workItemId),
    );
    expect(foreign).toHaveLength(0);
  });

  it('leaves the WRITE path untouched — an unbound INSERT is still refused', async () => {
    // `FOR SELECT` only. The row is now readable unbound; casting one is not.
    await expect(
      asAppRole(
        {},
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "public_request_vote" ("id", "work_item_id", "user_id", "created_at")
          VALUES (${'vote-smuggled'}, ${host.workItemId}, ${outsiderId}, now())
        `,
      ),
    ).rejects.toMatchObject({ meta: { driverAdapterError: { cause: { code: '42501' } } } });
  });
});

describe('the JOINED-table arms (MOTIR-2856)', () => {
  // The second hop. `project`, `work_item` and `public_request_vote` were each
  // armed after someone traced a broken surface back to the row it names —
  // nobody traced the tables those reads JOIN. `workflow_status` (the roadmap's
  // `category <> 'done'` filter, in three reads) and `workspace` → `organization`
  // (the project square's org-name join) had no public arm at all, so four reads
  // returned zero rows unbound and RAISED NOTHING.
  //
  // Each table gets the same four-way pin: admitted unbound for a public
  // project, refused unbound for a non-public one, refused on the SAME row once
  // its project stops being public, and unchanged for a bound tenant session.
  // The write verbs are pinned per table below, because `FOR SELECT` is the
  // whole claim.

  describe('workflow_status', () => {
    it('ADMITS a public project’s statuses with no workspace bound', async () => {
      const rows = await asAppRole({}, (tx) => selectWorkflowStatuses(tx, host.projectId));
      expect(rows).toHaveLength(1);
    });

    it('admits NOTHING ELSE unbound — a non-public project’s statuses stay invisible', async () => {
      const rows = await asAppRole({}, (tx) => selectWorkflowStatuses(tx, neighbour.projectId));
      expect(rows).toHaveLength(0);

      // And on the SAME row, so `accessLevel` is the only variable.
      for (const level of ['open', 'limited', 'private'] as const) {
        await adminDb.project.update({
          where: { id: host.projectId },
          data: { accessLevel: level },
        });
        const hidden = await asAppRole({}, (tx) => selectWorkflowStatuses(tx, host.projectId));
        expect(hidden, `accessLevel=${level} must hide its statuses unbound`).toHaveLength(0);
      }
    });

    it('leaves a WORKSPACE-BOUND read exactly as it was', async () => {
      // The arm is gated on there being NO bound workspace, so a tenant session
      // keeps precisely the set `workflow_status_active_workspace` gave it: its
      // own statuses, and none of a foreign workspace's — public or not.
      const own = await asAppRole({ workspaceId: host.workspaceId }, (tx) =>
        selectWorkflowStatuses(tx, host.projectId),
      );
      expect(own).toHaveLength(1);
      const foreign = await asAppRole({ workspaceId: neighbour.workspaceId }, (tx) =>
        selectWorkflowStatuses(tx, host.projectId),
      );
      expect(foreign, 'a bound session does not gain the public arm').toHaveLength(0);
    });

    it('does NOT let an unbound reader UPDATE or DELETE a status it can now read', async () => {
      // A workflow status is project CONFIGURATION, so a widened write verb here
      // would let an anonymous visitor edit a team's board. `FOR SELECT` is what
      // prevents it: the FOR-ALL policy's USING still matches zero rows unbound,
      // and zero-rows-affected is not an error — so this asserts on the ROW.
      await asAppRole(
        {},
        (tx) =>
          tx.$executeRaw`UPDATE "workflow_status" SET "label" = 'Hijacked' WHERE "id" = ${host.workflowStatusId}`,
      );
      await asAppRole(
        {},
        (tx) => tx.$executeRaw`DELETE FROM "workflow_status" WHERE "id" = ${host.workflowStatusId}`,
      );
      const survivor = await adminDb.workflowStatus.findUnique({
        where: { id: host.workflowStatusId },
      });
      expect(survivor?.label).toBe('To Do');
    });

    it('leaves WITH CHECK untouched — a status cannot be moved into a foreign workspace', async () => {
      await expect(
        asAppRole(
          { workspaceId: host.workspaceId },
          (tx) =>
            tx.$executeRaw`
            UPDATE "workflow_status" SET "workspace_id" = ${neighbour.workspaceId}
             WHERE "id" = ${host.workflowStatusId}
          `,
        ),
      ).rejects.toMatchObject({ meta: { driverAdapterError: { cause: { code: '42501' } } } });
    });
  });

  describe('workspace', () => {
    // A pure HOP in the square's join — not one of its columns reaches the DTO —
    // but an invisible row kills the join just as thoroughly as a missing one.
    // Note the predicate points the OTHER WAY from work_item's: `workspace` sits
    // ABOVE `project`, so the arm asks "does this workspace HAVE a public
    // project", which any one of its projects can satisfy.

    it('ADMITS a public project’s workspace with no workspace bound', async () => {
      const rows = await asAppRole({}, (tx) => selectWorkspace(tx, host.workspaceId));
      expect(rows).toHaveLength(1);
    });

    it('admits NOTHING ELSE unbound — a workspace with no public project stays invisible', async () => {
      const rows = await asAppRole({}, (tx) => selectWorkspace(tx, neighbour.workspaceId));
      expect(rows).toHaveLength(0);

      for (const level of ['open', 'limited', 'private'] as const) {
        await adminDb.project.update({
          where: { id: host.projectId },
          data: { accessLevel: level },
        });
        const hidden = await asAppRole({}, (tx) => selectWorkspace(tx, host.workspaceId));
        expect(hidden, `accessLevel=${level} must hide the workspace unbound`).toHaveLength(0);
      }
    });

    it('admits the workspace as soon as ANY of its projects is public', async () => {
      // The semi-join direction, stated as a behaviour rather than as SQL: the
      // host's own project goes private, a SECOND project in the same workspace
      // is public, and the workspace stays visible on the strength of that one.
      await adminDb.project.update({
        where: { id: host.projectId },
        data: { accessLevel: 'private' },
      });
      expect(await asAppRole({}, (tx) => selectWorkspace(tx, host.workspaceId))).toHaveLength(0);

      await adminDb.project.create({
        data: {
          workspaceId: host.workspaceId,
          name: 'Second',
          slug: 'host-second',
          identifier: 'HOST2',
          accessLevel: 'public',
        },
      });
      expect(await asAppRole({}, (tx) => selectWorkspace(tx, host.workspaceId))).toHaveLength(1);
    });

    it('leaves a WORKSPACE-BOUND read exactly as it was', async () => {
      const foreign = await asAppRole({ workspaceId: neighbour.workspaceId }, (tx) =>
        selectWorkspace(tx, host.workspaceId),
      );
      expect(foreign, 'a bound session does not gain the public arm').toHaveLength(0);
    });

    it('does NOT let an unbound reader UPDATE or DELETE the workspace it can now read', async () => {
      await asAppRole(
        {},
        (tx) =>
          tx.$executeRaw`UPDATE "workspace" SET "name" = 'Hijacked' WHERE "id" = ${host.workspaceId}`,
      );
      await asAppRole(
        {},
        (tx) => tx.$executeRaw`DELETE FROM "workspace" WHERE "id" = ${host.workspaceId}`,
      );
      const survivor = await adminDb.workspace.findUnique({ where: { id: host.workspaceId } });
      expect(survivor?.name).toBe('Workspace host');
    });
  });

  describe('organization', () => {
    // The only one of the three whose columns a reader actually SEES — `o.name`
    // and `o.slug` sit on every square card. Publicness is inherited twice, so
    // the arm's EXISTS walks organization → workspace → project, resolving its
    // middle hop through the workspace arm directly above.

    it('ADMITS a public project’s organization with no workspace bound', async () => {
      const rows = await asAppRole({}, (tx) => selectOrganization(tx, host.organizationId));
      expect(rows).toHaveLength(1);
    });

    it('admits NOTHING ELSE unbound — an org with no public project stays invisible', async () => {
      const rows = await asAppRole({}, (tx) => selectOrganization(tx, neighbour.organizationId));
      expect(rows).toHaveLength(0);

      for (const level of ['open', 'limited', 'private'] as const) {
        await adminDb.project.update({
          where: { id: host.projectId },
          data: { accessLevel: level },
        });
        const hidden = await asAppRole({}, (tx) => selectOrganization(tx, host.organizationId));
        expect(hidden, `accessLevel=${level} must hide the org unbound`).toHaveLength(0);
      }
    });

    it('leaves a WORKSPACE-BOUND read exactly as it was', async () => {
      // Gated on `app.workspace_id`, NOT on `app.organization_id` — the question
      // is "is this the context-less public connection", and the workspace GUC is
      // the one every bound path sets. So an ordinary workspace-bound request,
      // which binds no org id, must NOT pick up a foreign org through this arm.
      const foreign = await asAppRole({ workspaceId: neighbour.workspaceId }, (tx) =>
        selectOrganization(tx, host.organizationId),
      );
      expect(foreign, 'a workspace-bound session does not gain the public arm').toHaveLength(0);
    });

    it('does NOT let an unbound reader UPDATE or DELETE the org it can now read', async () => {
      // The org row carries billing state (`scaledTrackerSubscription`,
      // `aiIncludedSeat`, `isMeta`), so a widened write verb here would be a
      // billing-TAMPERING surface, not merely a leak.
      await asAppRole(
        {},
        (tx) =>
          tx.$executeRaw`UPDATE "organization" SET "aiIncludedSeat" = true WHERE "id" = ${host.organizationId}`,
      );
      await asAppRole(
        {},
        (tx) => tx.$executeRaw`DELETE FROM "organization" WHERE "id" = ${host.organizationId}`,
      );
      const survivor = await adminDb.organization.findUnique({
        where: { id: host.organizationId },
      });
      expect(survivor?.aiIncludedSeat).toBe(false);
    });
  });
});

describe('the four reads the join arms unblock (MOTIR-2856)', () => {
  // The admit assertions at the tier that was actually broken. A policy test
  // proves the ROW is visible; these prove the QUERY returns it — which is the
  // thing a customer sees, and the thing that was silently returning nothing.

  it('the roadmap’s Submitted column and its header count come back non-empty', async () => {
    // `findPublicRoadmapSubmitted` + `countPublicRoadmapSubmitted` both JOIN
    // `workflow_status`. `getRoadmap` also reads it directly via
    // `workflowsService.listStatusesByProject`, so this exercises three of the
    // four blocked reads at once. A triage item is `triagedAt` + `submittedBy`.
    await adminDb.workItem.update({
      where: { id: host.workItemId },
      data: { triagedAt: new Date(), submittedByUserId: outsiderId, status: 'todo' },
    });

    const roadmap = await publicProjectsService.getRoadmap(host.projectIdentifier, null);
    const submitted = roadmap.columns.find((c) => c.key === 'submitted');
    expect(submitted?.cards.map((c) => c.id)).toEqual([host.workItemId]);
    expect(submitted?.totalCount).toBe(1);
  });

  it('the duplicate pre-check finds a match', async () => {
    // `findPublicRequestMatches`, the fourth `workflow_status` joiner. Returning
    // nothing here does not look like a failure — it looks like "no duplicates",
    // so the user files the dupe the check exists to prevent.
    await adminDb.workItem.update({
      where: { id: host.workItemId },
      data: { title: 'Dark mode please', status: 'todo' },
    });

    const matches = await publicProjectsService.findDuplicateRequests(
      host.projectId,
      outsiderId,
      'dark mode',
    );
    expect(matches.candidates.map((c) => c.id)).toEqual([host.workItemId]);
  });

  it('the project square lists the public project WITH its org name', async () => {
    // `listPublicDirectoryRanked` — the `workspace` → `organization` join. The
    // org name is the assertion that matters: an armed `workspace` with an
    // unarmed `organization` would drop the card just as completely, so a test
    // that only counted cards could pass with one arm missing.
    const page = await projectSquareService.listDirectory({ rank: 'recent' });
    const card = page.items.find((i) => i.identifier === host.projectIdentifier);
    expect(card?.org.name).toBe('Org host');
    expect(page.items.map((i) => i.identifier)).not.toContain(neighbour.projectIdentifier);
  });
});

describe('the service path — resolvePublicInputs', () => {
  it('RESOLVES a public project for an ANONYMOUS actor', async () => {
    const caps = await projectAccessService.getPublicCapabilities(host.projectId, null);
    expect(caps.canBrowse).toBe(true);
  });

  it('RESOLVES a public project for a CROSS-ORG authenticated actor', async () => {
    const caps = await projectAccessService.getPublicCapabilities(host.projectId, outsiderId);
    expect(caps).toMatchObject({
      canBrowse: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    });
  });

  it('keeps a project MEMBER’s real capabilities on the public surface', async () => {
    // The public path resolves the actor's workspace + project membership so a
    // real member reading their own public project keeps the 6.16.3 in-place
    // Edit affordance. Both membership reads are bound (the workspace one on the
    // policy's own-row arm, the project one on the now-known public workspace),
    // so this holds under the flag as well as without it.
    const browse = await projectAccessService.resolvePublicBrowse(host.projectId, host.ownerId);
    expect(browse).toEqual({ isMember: true, canManage: true });
  });

  it('gives the SAME answer to a caller already inside a bound transaction', async () => {
    // The `tx` arm of the membership read. Every public entry point takes an
    // optional `tx` for a caller that is already inside a context-bound
    // transaction, and that caller must NOT get a second one opened underneath
    // it — so the binding this card adds is conditional, and this pins that both
    // arms agree. No shipped caller passes `tx` on this path today; the parameter
    // is part of the contract the whole service offers, and an arm nothing
    // exercises is an arm that quietly rots.
    const browse = await withWorkspaceContext(
      { userId: host.ownerId, workspaceId: host.workspaceId },
      (tx) => projectAccessService.resolvePublicBrowse(host.projectId, host.ownerId, tx),
    );
    expect(browse).toEqual({ isMember: true, canManage: true });
  });

  it('still throws ProjectNotFoundError on a NON-public project — anonymous', async () => {
    await expect(
      projectAccessService.getPublicCapabilities(neighbour.projectId, null),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('still throws ProjectNotFoundError on a NON-public project — cross-org', async () => {
    await expect(
      projectAccessService.getPublicCapabilities(neighbour.projectId, outsiderId),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('the public WRITE grants reach their gate', () => {
  it('ADMITS a cross-org submitter at the triage-submission grant', async () => {
    // The first statement of `publicProjectsService.submitPublicRequest` — gate
    // before quota. Reaching it at all is what the project arm buys; admitting
    // is what proves the arm resolved the project rather than swallowing it.
    await expect(
      projectAccessService.assertCanSubmitToTriage(host.projectId, outsiderId),
    ).resolves.toBeUndefined();
  });

  it('refuses the same submitter on a non-public project', async () => {
    await expect(
      projectAccessService.assertCanSubmitToTriage(neighbour.projectId, outsiderId),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('ADMITS a cross-org upvote — publicRequestsService reaches its grant', async () => {
    // `resolvePublicRequest` opens with an unbound `work_item` read, so without
    // the work-item arm this throws PublicRequestNotFoundError BEFORE the grant
    // is ever consulted — the refuses-everyone shape again, one table over.
    const result = await publicRequestsService.toggleUpvote(host.workItemId, {
      userId: outsiderId,
    });
    expect(result).toEqual({ voted: true, voteCount: 1 });
  });

  it('ADMITS a cross-org public comment — and it is written as PUBLIC', async () => {
    const comment = await publicRequestsService.addComment(
      host.workItemId,
      { bodyMd: 'From outside the org.' },
      { userId: outsiderId },
    );
    expect(comment.bodyMd).toBe('From outside the org.');
    const row = await adminDb.comment.findUnique({ where: { id: comment.id } });
    expect(row?.isPublic).toBe(true);
  });

  it('refuses an upvote on a NON-public project’s item, and records no vote', async () => {
    // Asserted on the EFFECT, not the error class, because the class legitimately
    // differs by role and this file's contract is that every assertion holds in
    // both modes: under the app role the item is invisible (the work-item arm
    // requires a public project) so `resolvePublicRequest` throws
    // PublicRequestNotFoundError; under the owner role the item comes back and the
    // grant throws ProjectNotFoundError. Both are a 404 the caller cannot tell
    // apart, which is the posture — and neither may leave a vote behind.
    await expect(
      publicRequestsService.toggleUpvote(neighbour.workItemId, { userId: outsiderId }),
    ).rejects.toThrow();
    const votes = await adminDb.publicRequestVote.count({
      where: { workItemId: neighbour.workItemId },
    });
    expect(votes).toBe(0);
  });
});

/**
 * Run `fn` as the non-bypass `motir_app` role, binding only the GUCs `ctx`
 * names — so `asAppRole({}, …)` is the genuinely context-less read an anonymous
 * public visitor makes. A local copy of the helper in `tests/project-rls.test.ts`
 * / `tests/multi-tenant-rls.test.ts`, for the reason those files give.
 *
 * The role switch is what makes these assertions independent of
 * `TEST_DB_APP_ROLE`: under the flag `db` is already `motir_app` and this is a
 * no-op; without it `db` is the BYPASSRLS owner and this is the only thing that
 * puts the policies in the path.
 */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

function selectProject(tx: Prisma.TransactionClient, id: string) {
  return tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "project" WHERE "id" = ${id}`;
}

function selectWorkItem(tx: Prisma.TransactionClient, id: string) {
  return tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "work_item" WHERE "id" = ${id}`;
}

function selectVotes(tx: Prisma.TransactionClient, workItemId: string) {
  return tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "public_request_vote" WHERE "work_item_id" = ${workItemId}`;
}

function selectWorkflowStatuses(tx: Prisma.TransactionClient, projectId: string) {
  return tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "workflow_status" WHERE "project_id" = ${projectId}`;
}

function selectWorkspace(tx: Prisma.TransactionClient, id: string) {
  return tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "workspace" WHERE "id" = ${id}`;
}

function selectOrganization(tx: Prisma.TransactionClient, id: string) {
  return tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "organization" WHERE "id" = ${id}`;
}

/** One upvote on a tenant's seeded request, cast by the outsider account. */
async function seedVote(tenant: Tenant): Promise<void> {
  await adminDb.publicRequestVote.create({
    data: { workItemId: tenant.workItemId, userId: outsiderId },
  });
}

/** The full tenant root chain the app builds at signup, plus one project and one item. */
async function seedTenant(
  tag: string,
  identifier: string,
  accessLevel: 'public' | 'open' | 'limited' | 'private',
): Promise<Tenant> {
  const owner = await adminDb.user.create({
    data: { email: `${tag}-owner@example.com`, name: `${tag} owner` },
  });
  const organization = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `org-${tag}` },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: organization.id, userId: owner.id, role: 'owner' },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `Workspace ${tag}`, slug: `ws-${tag}`, organizationId: organization.id },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: owner.id, workspaceId: workspace.id, role: 'owner' },
  });
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Project ${identifier}`,
      slug: identifier.toLowerCase(),
      identifier,
      accessLevel,
    },
  });
  const workItem = await adminDb.workItem.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      kind: 'task',
      identifier: `${identifier}-1`,
      key: 1,
      title: `${tag} request`,
      reporterId: owner.id,
      position: 'a0',
      backlogRank: 'a0',
    },
  });
  // The project's workflow (MOTIR-2856). Every roadmap read JOINs
  // `workflow_status` for its `category <> 'done'` predicate, so a tenant with
  // no status row cannot exercise the arm this file now pins — the join would
  // return nothing for a reason that has nothing to do with the policies.
  const workflowStatus = await adminDb.workflowStatus.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      position: 'a0',
      isInitial: true,
    },
  });
  return {
    ownerId: owner.id,
    workspaceId: workspace.id,
    organizationId: organization.id,
    projectId: project.id,
    projectIdentifier: identifier,
    workItemId: workItem.id,
    workflowStatusId: workflowStatus.id,
  };
}
