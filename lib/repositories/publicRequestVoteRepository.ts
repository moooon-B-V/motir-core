import { Prisma, type PublicRequestVote } from '@prisma/client';
import { db } from '@/lib/db';

// publicRequestVoteRepository (Story 6.12) — single-op access to the
// `public_request_vote` join. One vote per (request, account) is the
// server-enforced rule (the schema `@@unique([workItemId, userId])` from
// 6.12.3); the SERVICE owns the toggle transaction + the work_item row lock
// (6.12.6).
//
// RLS (6.12.3): `public_request_vote` is FORCE-RLS, keyed on the `app.user_id`
// GUC for the owner's own rows and `app.system_admin` for the cross-account
// COUNT. So the toggle write methods run inside a `withUserContext` tx (the
// voter casts only their OWN vote) and the per-request `countByWorkItem`
// aggregate runs inside a `withSystemContext` tx (it spans every voter) — the
// service binds the right context and threads its `tx` here. The anonymous
// public READ (6.12.4 Overview "Upvotes" stat) rides the app connection's
// RLS-secondary posture + the app-layer `projectId` gate, the same way 6.12.6's
// triage vote-tally read does (finding #26).

export const publicRequestVoteRepository = {
  /**
   * The caller's vote on one request, or null. Used inside the toggle tx to
   * decide insert-vs-delete, so it takes the tx (the read guards the write).
   */
  async findByWorkItemAndUser(
    workItemId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicRequestVote | null> {
    return tx.publicRequestVote.findUnique({
      where: { workItemId_userId: { workItemId, userId } },
    });
  },

  /** Record one upvote. Required `tx` — runs in the toggle transaction. */
  async create(
    data: { workItemId: string; userId: string },
    tx: Prisma.TransactionClient,
  ): Promise<PublicRequestVote> {
    return tx.publicRequestVote.create({ data });
  },

  /**
   * Remove the caller's upvote (the toggle-off path). Required `tx`. Returns the
   * number of rows deleted (0 when nothing was there — idempotent).
   */
  async deleteByWorkItemAndUser(
    workItemId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.publicRequestVote.deleteMany({ where: { workItemId, userId } });
    return r.count;
  },

  /**
   * How many accounts have upvoted one request — the demand signal. Spans every
   * voter, so the service runs this under `withSystemContext` (the
   * cross-account COUNT the RLS `system_admin` branch admits); it takes the tx.
   */
  async countByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.publicRequestVote.count({ where: { workItemId } });
  },

  /**
   * Total upvotes across a project's public requests (Story 6.12 · Subtask
   * 6.12.4) — the public Overview "Upvotes" stat. Counts every vote row whose
   * work item belongs to the project, in ONE aggregate (no per-item N+1). The
   * anonymous public read uses the `db` singleton + the app-layer `projectId`
   * gate (RLS-secondary posture, like 6.12.6's triage vote-tally). Returns 0
   * when the project has no public requests / votes.
   */
  async countByProject(projectId: string): Promise<number> {
    return db.publicRequestVote.count({ where: { workItem: { projectId } } });
  },

  /**
   * Total upvotes for a SET of projects in ONE aggregate — the upvote stat for a
   * page of PROJECT SQUARE cards (Story 6.13 · Subtask 6.13.2), avoiding a
   * per-card N+1. Joins each vote to its work item and groups by the work
   * item's project; returns one `{ projectId, upvotes }` per project that has at
   * least one vote (a project with zero votes is simply absent — the service
   * defaults it to 0). Empty input short-circuits to `[]` (no pointless query).
   * Anonymous cross-org read → `db` singleton + the app-layer `projectId` filter
   * (the RLS-secondary posture `countByProject` uses). `Prisma.join` keeps the
   * `IN` list parameterized (no string-built SQL).
   */
  async sumUpvotesByProjects(
    projectIds: string[],
  ): Promise<Array<{ projectId: string; upvotes: number }>> {
    if (projectIds.length === 0) return [];
    const rows = await db.$queryRaw<Array<{ projectId: string; upvotes: number }>>`
      SELECT wi."projectId" AS "projectId", COUNT(*)::int AS "upvotes"
        FROM "public_request_vote" v
        JOIN "work_item" wi ON wi."id" = v."work_item_id"
       WHERE wi."projectId" IN (${Prisma.join(projectIds)})
       GROUP BY wi."projectId"`;
    return rows.map((r) => ({ projectId: r.projectId, upvotes: Number(r.upvotes) }));
  },
};
