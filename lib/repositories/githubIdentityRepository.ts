import { Prisma, type GithubIdentity } from '@prisma/client';

// GitHub-identity repository — single Prisma operations on the `github_identity`
// table (Story 7.10 · MOTIR-1498). The service (githubIdentityService) owns the
// OAuth orchestration, token encryption, the transaction, and DTO mapping; this
// leaf holds none of that.
//
// Layer rules (CLAUDE.md): the write (`upsertForUser`) REQUIRES `tx` — it runs
// inside the callback's `withUserContext` transaction, so RLS binds the identity
// to the acting user. The plain read (`findByUserId`) is used by the settings
// read path; it runs under `withUserContext` too (so RLS narrows to the owner),
// hence it takes `tx`.

export interface UpsertGithubIdentityInput {
  userId: string;
  githubUserId: string;
  githubLogin: string;
  avatarUrl: string | null;
  accessTokenEncrypted: string;
}

export const githubIdentityRepository = {
  /** The acting user's GitHub identity, or null if unbound (the valid
   *  "identity with no installation / no identity yet" state the UI shows).
   *  Runs under `withUserContext`, so RLS already narrows to the owner. */
  async findByUserId(userId: string, tx: Prisma.TransactionClient): Promise<GithubIdentity | null> {
    return tx.githubIdentity.findUnique({ where: { userId } });
  },

  /** Create-or-refresh the acting user's identity binding (re-auth updates the
   *  login / avatar / token in place, keyed on the unique `user_id`). */
  async upsertForUser(
    input: UpsertGithubIdentityInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubIdentity> {
    const { userId, ...rest } = input;
    return tx.githubIdentity.upsert({
      where: { userId },
      create: { userId, ...rest },
      update: rest,
    });
  },

  /** Remove the acting user's identity binding (Disconnect — MOTIR-895).
   *  Runs inside the disconnect `withUserContext` transaction, so RLS narrows to
   *  the owner. Returns the delete count (0 when already unbound — idempotent). */
  async deleteByUserId(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.githubIdentity.deleteMany({ where: { userId } });
    return r.count;
  },
};
