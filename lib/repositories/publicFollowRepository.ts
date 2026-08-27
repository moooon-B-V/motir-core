import { Prisma, type PublicFollow } from '@/generated/prisma/client';

// publicFollowRepository (Story 8.9 · Subtask 8.9.3) — single-op access to
// `public_follow`, the row behind two of the three follower tiers in
// `docs/decisions/public-follow-and-changelog.md` §1. The third tier is
// ANONYMOUS: a person who subscribes to the Atom feed in their own reader has no
// row here at all, which is why nothing in this file has an "anonymous" path.
//
// TENANCY. `public_follow` is FORCE-RLS behind ONE ordinary workspace policy
// (`public_follow_workspace_or_system`), so EVERY method here — reads included —
// takes a `tx` bound to the project's workspace. The service opens it with
// `withWorkspaceServiceContext(project.workspaceId, …)`: the workspace-tier
// context that binds `app.workspace_id` and nothing else, which is the right
// tool because an email-only follower has no acting user to bind and
// `app.system_admin` would be a cross-tenant flag for a web request.
//
// ⚠️ Do NOT add an unbound `db` read here. The obvious sibling,
// `publicRequestVoteRepository`, has one — its anonymous COUNT rides an
// unbound-only RLS arm — and copying that shape onto this table would make the
// follower list, addresses included, readable by any anonymous connection. The
// ADR's AMENDMENT 1 records why the two tables differ: every vote row has a
// `user_id` and some follow rows have none, so no owner-keyed policy can cover
// this table and the arm that would have has to be public to every row. The
// `db` singleton is deliberately NOT imported in this file at all: there is no
// method that may run unbound, so there is nothing for it to serve.
//
// The SERVICE owns every transaction, the follow-once decision, token
// generation and hashing, and DTO mapping. Nothing in this file hashes, mints
// or compares a token: a repository that knew how a token was derived would be
// the second place that knowledge lives.

/** The fields a follow row is created with, per tier. */
export interface CreatePublicFollowInput {
  workspaceId: string;
  projectId: string;
  /** Set on the ACCOUNT tier; null on the email-only tier. Never both. */
  userId?: string | null;
  /** Set on the EMAIL-ONLY tier, already LOWERCASED by the service. */
  email?: string | null;
  digestOptIn: boolean;
  /** Non-null at creation on the account tier (the address is already verified). */
  confirmedAt?: Date | null;
  confirmTokenHash?: string | null;
  confirmTokenExpiresAt?: Date | null;
}

export const publicFollowRepository = {
  /**
   * This account's follow of this project, or null — the Follow button's state
   * read, and the guard the toggle's insert-vs-delete branch reads inside its
   * own transaction.
   */
  async findByProjectAndUser(
    projectId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicFollow | null> {
    return tx.publicFollow.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
  },

  /**
   * The email-only follow of this project for this address, or null. `email` is
   * matched on the STORED form, so the service lowercases before calling —
   * the unique index is on the stored value and a case variant would otherwise
   * create a second row for the same person.
   */
  async findByProjectAndEmail(
    projectId: string,
    email: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicFollow | null> {
    return tx.publicFollow.findUnique({
      where: { projectId_email: { projectId, email } },
    });
  },

  /**
   * The follow a confirmation token addresses. The caller passes the HASH — the
   * clear token never reaches this layer — and the row is found by it rather
   * than by (project, address), because the token is the only thing the
   * confirmation link carries that proves the address was reachable.
   *
   * Not unique in the schema (a hash is high-entropy, not a key), so this is a
   * `findFirst`. Expiry is the SERVICE's check: a repository that dropped
   * expired rows here would make "expired" and "never existed" the same answer,
   * and they need different copy.
   */
  async findByConfirmTokenHash(
    confirmTokenHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicFollow | null> {
    return tx.publicFollow.findFirst({ where: { confirmTokenHash } });
  },

  /**
   * One follow by id — the digest's per-follower read, and the unsubscribe
   * path's, since the unsubscribe token IS the id plus a signature over it
   * (`followTokens.signUnsubscribeToken`). There is no lookup by unsubscribe
   * token because there is no unsubscribe token stored to look up.
   */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<PublicFollow | null> {
    return tx.publicFollow.findUnique({ where: { id } });
  },

  /** Record one follow. Required `tx` — runs in the service's workspace-bound transaction. */
  async create(data: CreatePublicFollowInput, tx: Prisma.TransactionClient): Promise<PublicFollow> {
    return tx.publicFollow.create({
      data: {
        workspaceId: data.workspaceId,
        projectId: data.projectId,
        userId: data.userId ?? null,
        email: data.email ?? null,
        digestOptIn: data.digestOptIn,
        confirmedAt: data.confirmedAt ?? null,
        confirmTokenHash: data.confirmTokenHash ?? null,
        confirmTokenExpiresAt: data.confirmTokenExpiresAt ?? null,
      },
    });
  },

  /**
   * Patch one follow by id — the digest opt-in toggle, the confirmation stamp
   * (which also clears the spent token), and the digest job's `lastDigestAt`.
   * Required `tx`.
   */
  async update(
    id: string,
    data: Prisma.PublicFollowUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PublicFollow> {
    return tx.publicFollow.update({ where: { id }, data });
  },

  /**
   * Remove one follow (unfollow, and the unsubscribe path). Returns the number
   * of rows deleted — 0 when it was already gone, which makes the caller
   * idempotent without a prior read. Required `tx`.
   */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.publicFollow.deleteMany({ where: { id } });
    return result.count;
  },

  /**
   * How many people follow this project — the count the public chrome renders
   * beside the Follow button. Bounded aggregate, no row leaves the layer, so it
   * is safe to serve to a viewer who may read none of the underlying rows.
   * Required `tx` (the workspace-bound one), like every read here.
   */
  async countByProject(projectId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.publicFollow.count({ where: { projectId } });
  },

  /**
   * The digest audience for one project: confirmed followers who opted in.
   * Served by `@@index([projectId, digestOptIn])`. `confirmedAt` is non-null on
   * every account-tier row at creation, so this one predicate covers both tiers
   * — an email-only follower who never followed the confirmation link is not an
   * audience, and this is where that is enforced rather than in the mailer.
   *
   * Ordered by `id` so a paged sweep is total; `take`/`cursor` are the caller's,
   * because 8.9.7 pages a project's audience rather than loading it whole.
   */
  async findDigestAudience(
    projectId: string,
    options: { take: number; cursor?: string },
    tx: Prisma.TransactionClient,
  ): Promise<PublicFollow[]> {
    return tx.publicFollow.findMany({
      where: { projectId, digestOptIn: true, confirmedAt: { not: null } },
      orderBy: { id: 'asc' },
      take: options.take,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
  },

  /**
   * The unconfirmed-follow sweep (ADR §4): an email-only row whose confirmation
   * was never followed within the window is deleted, so an address that was
   * typed by somebody else — or mistyped — does not sit here indefinitely.
   *
   * This is the ONE method that spans workspaces, because the sweep is a
   * platform job rather than a tenant action, so it takes the `system_admin`-
   * bound `tx` its policy arm admits. `confirmedAt: null` alone would also match
   * a row created seconds ago, hence the cutoff. Returns the number deleted.
   */
  async deleteUnconfirmedBefore(cutoff: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.publicFollow.deleteMany({
      where: { confirmedAt: null, createdAt: { lt: cutoff } },
    });
    return result.count;
  },
};
