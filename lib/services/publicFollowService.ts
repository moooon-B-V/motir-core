import { projectRepository } from '@/lib/repositories/projectRepository';
import { publicFollowRepository } from '@/lib/repositories/publicFollowRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { PublicFollowStateDto } from '@/lib/dto/publicProjects';
import {
  CONFIRM_TOKEN_TTL_MS,
  hashFollowToken,
  looksLikeEmail,
  mintFollowToken,
  normalizeFollowEmail,
  verifyUnsubscribeToken,
} from '@/lib/publicProjects/followTokens';
import {
  FollowDigestUnavailableError,
  FollowTokenInvalidError,
  InvalidFollowEmailError,
} from '@/lib/publicProjects/followErrors';

// The public FOLLOW loop (Story 8.9 · Subtask 8.9.5 ·
// `docs/decisions/public-follow-and-changelog.md` §1, §4, §7). The DIGEST SEND
// is 8.9.7; this service owns the relationship, the confirmation, and the exit.
//
// ── TENANCY ─────────────────────────────────────────────────────────────────
// Every write runs inside `withWorkspaceServiceContext(project.workspaceId, …)`.
// `public_follow` is behind ONE ordinary workspace RLS policy with NO anonymous
// arm — see the ADR's AMENDMENT 1 — so an unbound connection reads no follow row
// at all, and the follower list cannot be enumerated through the database layer
// even if a query here is one day written carelessly. The workspace id comes
// from the `project` row the public identifier resolves to, which is the trusted
// lookup that helper's own security note requires.
//
// ── WHY TWO METHODS READ AS THE SYSTEM ──────────────────────────────────────
// `confirmEmailFollow` and `unsubscribeByToken` arrive holding a TOKEN and
// nothing else — no session, no project, no workspace — so there is no tenant to
// bind before the row is found. They read through `withSystemContext`, the one
// context whose policy arm spans workspaces, and that is acceptable rather than
// a hole because the lookup key is 256 bits of CSPRNG output: the read can only
// return the row whose token the caller already holds. Every WRITE that follows
// is re-bound to that row's own workspace.
//
// ── THE ENUMERATION RULE ────────────────────────────────────────────────────
// `subscribeByEmail` answers IDENTICALLY whether the address was already
// following, was following and unconfirmed, or had never been seen. It is an
// internet-facing endpoint that takes an email address; if its answer varied it
// would report which addresses care about a project. That is why the return
// type carries no state and why `followErrors.ts` has no "already subscribed".

/**
 * Resolve a PUBLIC project by identifier and run the anonymous browse gate —
 * the same two steps every public read makes. A non-public or unknown project
 * throws `ProjectNotFoundError`, which the routes map to 404 (no existence
 * leak), so nothing below can act on a project that is not public.
 */
async function resolvePublicProject(identifier: string, actorUserId: string | null) {
  const project = await projectRepository.findPublicByIdentifier(identifier);
  if (!project) throw new ProjectNotFoundError(identifier);
  await projectAccessService.resolvePublicBrowse(project.id, actorUserId);
  return project;
}

/** Whether this deployment can send at all (ADR §4 — the self-host path). */
export function digestAvailable(): boolean {
  // Read straight from the env rather than through `@/lib/email`: only the
  // `email.send` job may import that module (the no-synchronous-send rule), and
  // this is a capability QUESTION rather than a send.
  const provider = process.env['EMAIL_PROVIDER'] ?? 'console';
  // `console` is the unconfigured default and `file` is a dev/test sink. Neither
  // reaches a person, so neither may be advertised as an email subscription.
  return provider !== 'console' && provider !== 'file';
}

export const publicFollowService = {
  /**
   * What the public chrome needs to draw the Follow control.
   *
   * `following` is about the ACCOUNT tier only and is always false for a
   * signed-out viewer — the anonymous tier has no row to report, and reporting
   * the email tier here would answer "does this address follow?" to anyone who
   * asked (the enumeration rule above).
   */
  async getFollowState(
    identifier: string,
    actorUserId: string | null,
  ): Promise<PublicFollowStateDto> {
    const project = await resolvePublicProject(identifier, actorUserId);
    return withWorkspaceServiceContext(project.workspaceId, async (tx) => {
      const followerCount = await publicFollowRepository.countByProject(project.id, tx);
      const mine = actorUserId
        ? await publicFollowRepository.findByProjectAndUser(project.id, actorUserId, tx)
        : null;
      return {
        following: mine !== null,
        digestOptIn: mine?.digestOptIn ?? false,
        followerCount,
        digestAvailable: digestAvailable(),
      };
    });
  },

  /**
   * Follow as a signed-in account. IDEMPOTENT: following twice is following, so
   * a repeated call returns the existing state rather than erroring or writing
   * a second row (the `@@unique([projectId, userId])` would refuse it anyway,
   * and turning a constraint violation into a user-visible error would make a
   * double-click look like a failure).
   *
   * An account follow is CONFIRMED at creation — `User.emailVerified` already
   * proved the address, and re-verifying it is friction with no security
   * content (ADR §4).
   */
  async followAsAccount(
    identifier: string,
    actorUserId: string,
    options: { digestOptIn?: boolean } = {},
  ): Promise<PublicFollowStateDto> {
    const project = await resolvePublicProject(identifier, actorUserId);
    return withWorkspaceServiceContext(project.workspaceId, async (tx) => {
      const existing = await publicFollowRepository.findByProjectAndUser(
        project.id,
        actorUserId,
        tx,
      );
      if (existing) {
        // Already following. Only an EXPLICIT digest choice changes anything —
        // a bare re-follow must not silently flip a preference the person set.
        const row =
          options.digestOptIn !== undefined && options.digestOptIn !== existing.digestOptIn
            ? await publicFollowRepository.update(
                existing.id,
                { digestOptIn: options.digestOptIn },
                tx,
              )
            : existing;
        return {
          following: true,
          digestOptIn: row.digestOptIn,
          followerCount: await publicFollowRepository.countByProject(project.id, tx),
          digestAvailable: digestAvailable(),
        };
      }
      const row = await publicFollowRepository.create(
        {
          workspaceId: project.workspaceId,
          projectId: project.id,
          userId: actorUserId,
          digestOptIn: (options.digestOptIn ?? false) && digestAvailable(),
          confirmedAt: new Date(),
        },
        tx,
      );
      return {
        following: true,
        digestOptIn: row.digestOptIn,
        followerCount: await publicFollowRepository.countByProject(project.id, tx),
        digestAvailable: digestAvailable(),
      };
    });
  },

  /**
   * Stop following, as an account. IDEMPOTENT for the mirror reason: unfollowing
   * something you do not follow leaves you not following it.
   */
  async unfollowAsAccount(identifier: string, actorUserId: string): Promise<PublicFollowStateDto> {
    const project = await resolvePublicProject(identifier, actorUserId);
    return withWorkspaceServiceContext(project.workspaceId, async (tx) => {
      const existing = await publicFollowRepository.findByProjectAndUser(
        project.id,
        actorUserId,
        tx,
      );
      if (existing) await publicFollowRepository.deleteById(existing.id, tx);
      return {
        following: false,
        digestOptIn: false,
        followerCount: await publicFollowRepository.countByProject(project.id, tx),
        digestAvailable: digestAvailable(),
      };
    });
  },

  /**
   * The EMAIL-ONLY tier: a visitor with no account subscribes with an address.
   *
   * Writes an UNCONFIRMED row and mails a confirmation link. Nothing is sent to
   * that address again until the link is followed, and an unconfirmed row is
   * swept after a week (8.9.7's sweep) — so an address typed by somebody else,
   * or mistyped, costs one email and then disappears.
   *
   * ⚠️ RETURNS NOTHING, ALWAYS, WHATEVER HAPPENED. Re-subscribing an address
   * that is already confirmed re-sends nothing and answers the same; an unknown
   * address answers the same. The caller cannot learn anything about the
   * follower list from the response, which is the whole point (§7).
   */
  async subscribeByEmail(
    identifier: string,
    rawEmail: string,
    actorUserId: string | null,
  ): Promise<void> {
    if (!digestAvailable()) throw new FollowDigestUnavailableError();
    const email = normalizeFollowEmail(rawEmail);
    if (!looksLikeEmail(email)) throw new InvalidFollowEmailError();

    const project = await resolvePublicProject(identifier, actorUserId);

    // The token is minted OUTSIDE the transaction because the clear value never
    // enters the database — only its hash does, and only the email carries the
    // token itself.
    const token = mintFollowToken();
    const sendTo = await withWorkspaceServiceContext(project.workspaceId, async (tx) => {
      const existing = await publicFollowRepository.findByProjectAndEmail(project.id, email, tx);
      if (existing?.confirmedAt) {
        // Already a confirmed follower. Send nothing: a re-subscribe must not
        // become a way to make us mail an arbitrary address repeatedly.
        return null;
      }
      const data = {
        digestOptIn: true,
        confirmTokenHash: hashFollowToken(token),
        confirmTokenExpiresAt: new Date(Date.now() + CONFIRM_TOKEN_TTL_MS),
      };
      if (existing) {
        // Unconfirmed already: REPLACE the token rather than adding a row, so
        // the newest link is the only live one and the old one dies immediately.
        await publicFollowRepository.update(existing.id, data, tx);
      } else {
        await publicFollowRepository.create(
          {
            workspaceId: project.workspaceId,
            projectId: project.id,
            email,
            ...data,
          },
          tx,
        );
      }
      return email;
    });

    if (!sendTo) return;
    // ENQUEUED, and OUTSIDE the transaction. Two rules meet here and point the
    // same way: this codebase never sends mail synchronously (only the
    // `email.send` job imports `@/lib/email`, and eslint enforces it), and a
    // side effect never runs inside a database transaction. The token rides the
    // payload because it is the one thing the row does not hold — the row has
    // only its hash.
    //
    // `idempotencyKey` is the token: a retried request dedups to ONE delivery
    // inside the job runtime's window, so a double-submit cannot mail somebody
    // twice.
    await sendEvent('email.send', {
      workspaceId: project.workspaceId,
      idempotencyKey: token,
      to: sendTo,
      template: 'follow-confirm',
      data: {
        projectName: project.name,
        confirmUrl: `${resolveBaseUrlTrimmed()}/follow/confirm?token=${encodeURIComponent(token)}`,
      },
    });
  },

  /**
   * Confirm an email-only follow. Single-use: the token hash is CLEARED as the
   * row is stamped, so a link cannot be replayed out of an inbox.
   */
  async confirmEmailFollow(token: string): Promise<{ projectIdentifier: string }> {
    const tokenHash = hashFollowToken(token);
    // The token names the row, and the row names the workspace — so unlike every
    // other method here, the tenant is discovered rather than supplied. The
    // lookup therefore runs as the system, which is the one context that can
    // read across tenants, and it reads by a 256-bit hash: an id nobody can
    // guess is what makes that safe.
    const found = await withSystemContext((tx) =>
      publicFollowRepository.findByConfirmTokenHash(tokenHash, tx),
    );
    if (!found) throw new FollowTokenInvalidError();
    if (found.confirmTokenExpiresAt && found.confirmTokenExpiresAt.getTime() < Date.now()) {
      throw new FollowTokenInvalidError();
    }
    const project = await projectRepository.findById(found.projectId);
    if (!project) throw new FollowTokenInvalidError();

    await withWorkspaceServiceContext(found.workspaceId, (tx) =>
      publicFollowRepository.update(
        found.id,
        { confirmedAt: new Date(), confirmTokenHash: null, confirmTokenExpiresAt: null },
        tx,
      ),
    );
    return { projectIdentifier: project.identifier };
  },

  /**
   * The exit. One click, no sign-in, and it works in a mail found years later —
   * which is why the unsubscribe token, unlike the confirmation one, never
   * expires.
   *
   * IDEMPOTENT: a token whose row is already gone answers success. A person who
   * clicks twice, or whose mail client prefetches the link, must not be told
   * that unsubscribing failed.
   */
  async unsubscribeByToken(token: string): Promise<void> {
    // The token IS the follow id plus an HMAC over it, so verifying it both
    // authenticates the bearer and tells us which row to delete — no lookup by
    // a stored secret, and nothing stored that could be replayed.
    const followId = verifyUnsubscribeToken(token);
    if (!followId) return;
    const found = await withSystemContext((tx) => publicFollowRepository.findById(followId, tx));
    if (!found) return;
    await withWorkspaceServiceContext(found.workspaceId, (tx) =>
      publicFollowRepository.deleteById(found.id, tx),
    );
  },
};
