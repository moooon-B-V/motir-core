import { randomBytes } from 'node:crypto';
import type { MemberRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { currentLocale } from '@/lib/i18n/serverLocale';
import type {
  AcceptInviteResultDTO,
  InspectInviteResultDTO,
  SendInviteResultDTO,
  ValidateInviteResultDTO,
} from '@/lib/dto/invites';
import { toValidateInviteResultDTO } from '@/lib/mappers/inviteMappers';
import { userRepository } from '@/lib/repositories/userRepository';
import { verificationRepository } from '@/lib/repositories/verificationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { readMembership } from '@/lib/workspaces/membershipGate';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { organizationsService } from '@/lib/services/organizationsService';
import { enqueueScaledTrackerSeatSync } from '@/lib/billing/seatSync';
import { isEmailShape } from '@/lib/utils/email';
import {
  AlreadyMemberError,
  InvalidEmailError,
  InviteEmailMismatchError,
  InviteExpiredOrMissingError,
  InviteRateLimitedError,
  InviteTargetAlreadyMemberError,
  NotAMemberError,
} from '@/lib/workspaces/errors';

// Workspace invites service — owns the entire send / validate / accept
// flow. Per CLAUDE.md, this is the layer where:
//   - Multi-row writes happen inside $transaction
//   - Typed domain errors are thrown
//   - Prisma rows are mapped to DTOs before returning
//
// Tokens live in the Verification table (Subtask 1.1.3) with the
// `workspace-invite:` identifier prefix. The `value` column carries
// JSON `{ workspaceId, email, role, inviterUserId }`. The existing
// `@@index([identifier])` makes prefix-scoped lookups (validate,
// rate-limit) cheap.

export const INVITE_IDENTIFIER_PREFIX = 'workspace-invite:';
export const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_RATE_LIMIT = {
  windowMs: 60 * 60 * 1000,
  max: 3,
} as const;

const TOKEN_BYTES = 24;

interface InvitePayload {
  workspaceId: string;
  email: string;
  role: MemberRole;
  inviterUserId: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function parsePayload(value: string): InvitePayload | null {
  try {
    const parsed = JSON.parse(value) as InvitePayload;
    if (
      typeof parsed.workspaceId !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.role !== 'string' ||
      typeof parsed.inviterUserId !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function buildInviteAcceptUrl(token: string): string {
  return `${resolveBaseUrlTrimmed()}/invite/accept?token=${encodeURIComponent(token)}`;
}

async function enqueueInviteEmail(args: {
  workspaceId: string;
  inviterName: string;
  workspaceName: string;
  recipientEmail: string;
  token: string;
}): Promise<void> {
  // Enqueue the send (Story 1.6.3) instead of dispatching inline: the
  // provider call moves to the durable `email.send` job (with retries), and
  // sendInvite returns as soon as the event is published. The template still
  // renders in lib/emailTemplates/ — here in the job via emailService — so
  // this service never builds subject/body strings itself. We pass the
  // fully-built accept URL as a template prop; the job stays env-agnostic.
  //
  //   - workspaceId: the inviting workspace (a real, tenanted email).
  //   - idempotencyKey: the invite token (unique per invite) — a retried
  //     send Action dedups to one delivery within Inngest's window.
  await sendEvent('email.send', {
    workspaceId: args.workspaceId,
    idempotencyKey: args.token,
    to: args.recipientEmail,
    template: 'workspace-invite',
    data: {
      inviterName: args.inviterName,
      workspaceName: args.workspaceName,
      acceptUrl: buildInviteAcceptUrl(args.token),
      // The inviter's current UI locale — the best available signal, since the
      // recipient may not exist yet (no persisted per-user locale). Rendered
      // off-request in the email.send job, so the locale must ride the payload.
      locale: await currentLocale(),
    },
  });
}

export const workspaceInvitesService = {
  /**
   * Send an invite. Gates on:
   *   - inviter is a member of the workspace (else NotAMemberError)
   *   - email shape is valid (else InvalidEmailError)
   *   - target email isn't already a workspace member (else
   *     InviteTargetAlreadyMemberError)
   *   - we haven't sent ≥3 invites to (workspaceId, email) in the last
   *     hour (else InviteRateLimitedError)
   *
   * Then creates a Verification row with the token + payload and ENQUEUES
   * the invite email as an `email.send` job (Story 1.6.3). The create +
   * enqueue are NOT atomic — if enqueue fails after the token is created,
   * the user can retry; the wasted token cleans up via expiry. That's the
   * standard trade-off for any "write-then-side-effect" flow. Delivery
   * itself is now durable: once enqueued, the job retries the provider call
   * and lands terminal failures in the jobs dashboard rather than dropping
   * them on the request path.
   */
  async sendInvite(args: {
    inviterUserId: string;
    inviterName: string;
    workspaceId: string;
    targetEmail: string;
  }): Promise<SendInviteResultDTO> {
    const email = normalizeEmail(args.targetEmail);
    if (!isEmailShape(email)) throw new InvalidEmailError();

    // Inviter must be a workspace member.
    const inviterMembership = await readMembership(args.inviterUserId, args.workspaceId);
    if (!inviterMembership) {
      throw new NotAMemberError(args.inviterUserId, args.workspaceId);
    }

    // Block invites to addresses already in the workspace. Only
    // resolves a membership when the email maps to an existing user
    // — an invite to a brand-new email is fine.
    const existingUser = await userRepository.findByEmail(email);
    if (existingUser) {
      // MOTIR-2527: an unbound read here fails OPEN, not closed — a `null` reads as
      // "not a member yet", so the already-a-member guard stops firing and the invite
      // is sent to someone who is already in the workspace.
      const targetMembership = await readMembership(existingUser.id, args.workspaceId);
      if (targetMembership) {
        throw new InviteTargetAlreadyMemberError(email, args.workspaceId);
      }
    }

    // Rate limit BEFORE writing so a 4th attempt never persists a row
    // and never spams the inbox.
    const recent = await verificationRepository.countByIdentifierPrefixAndValueAndSince({
      identifierPrefix: INVITE_IDENTIFIER_PREFIX,
      valueContainsAll: [args.workspaceId, email],
      since: new Date(Date.now() - INVITE_RATE_LIMIT.windowMs),
    });
    if (recent >= INVITE_RATE_LIMIT.max) {
      throw new InviteRateLimitedError(INVITE_RATE_LIMIT.max);
    }

    // MOTIR-2527: bound, like the gate above it. This read RE-RAISES `NotAMemberError`
    // on a null, so leaving it on the `db` singleton would have handed back exactly the
    // error the gate was fixed to stop producing — a member admitted by the gate and
    // then refused, four statements later, by an invisible `workspace` row
    // (`workspace_active` reads the same per-transaction GUCs).
    const workspace = await withWorkspaceContext(
      { userId: args.inviterUserId, workspaceId: args.workspaceId },
      (tx) => workspaceRepository.findByIdInTx(args.workspaceId, tx),
    );
    if (!workspace) {
      // Race: workspace deleted between the membership check and now.
      // Treat as NotAMember — the inviter no longer has membership.
      throw new NotAMemberError(args.inviterUserId, args.workspaceId);
    }

    const token = generateToken();
    const payload: InvitePayload = {
      workspaceId: args.workspaceId,
      email,
      role: 'member',
      inviterUserId: args.inviterUserId,
    };
    await db.$transaction(async (tx) => {
      await verificationRepository.create(
        {
          identifier: INVITE_IDENTIFIER_PREFIX + token,
          value: JSON.stringify(payload),
          expiresAt: new Date(Date.now() + INVITE_EXPIRY_MS),
        },
        tx,
      );
    });

    await enqueueInviteEmail({
      workspaceId: args.workspaceId,
      inviterName: args.inviterName,
      workspaceName: workspace.name,
      recipientEmail: email,
      token,
    });

    return { ok: true };
  },

  /**
   * Validate a token for the acceptance UI. Returns null on missing OR
   * expired (collapsed so the UI can't accidentally distinguish "I
   * know this token but it expired" from "I don't recognize this
   * token" — both are 404 to the world).
   *
   * Returns the DTO, not the raw payload, so the route can JSON-spread
   * the result directly.
   */
  async validateInvite(token: string): Promise<ValidateInviteResultDTO | null> {
    const row = await verificationRepository.findByIdentifier(INVITE_IDENTIFIER_PREFIX + token);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    const payload = parsePayload(row.value);
    if (!payload) return null;

    // BOUND, and actorless (MOTIR-2777). Both PRE-AUTH inspections below run with no
    // session at all — the person holding the link may not have an account yet — so
    // there is no user context to derive, and `withWorkspaceServiceContext` (the
    // userless helper MOTIR-2685 established) binds the workspace tier alone. Left on
    // the singleton, `workspace_active` sees no GUC, the row is invisible, and every
    // VALID invite renders as an invalid one. This is the same fix the inviter-side
    // read above already carries from MOTIR-2527.
    //
    // The helper's constraint — `workspaceId` must come from the layer above, never
    // from caller input — holds: it is read out of the server-stored verification row
    // this method just validated, not off the request.
    // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
    // Missing, expired and unparseable are all returned above, so this only
    // runs for a token already known good, and `findById` resolves to `null`
    // for a deleted inviter rather than rejecting.
    const [workspace, inviter] = await Promise.all([
      withWorkspaceServiceContext(payload.workspaceId, (tx) =>
        workspaceRepository.findByIdInTx(payload.workspaceId, tx),
      ),
      userRepository.findById(payload.inviterUserId),
    ]);
    if (!workspace) return null;

    return toValidateInviteResultDTO({ workspace, inviter, email: payload.email });
  },

  /**
   * Inspect a token for the acceptance PAGE (not the public GET
   * endpoint). Unlike validateInvite — which collapses missing/expired
   * to null so the world can't distinguish them — this returns a
   * discriminated status so the acceptance page can render the three
   * distinct mockup states:
   *   - 'valid'   → row present, unexpired, payload + workspace resolve
   *   - 'expired' → row present but past expiresAt
   *   - 'used'    → row absent (consumed on a prior accept, or never
   *                 existed — both render as "already used", which is the
   *                 honest framing for a user who reached the page via a
   *                 real link that no longer resolves)
   *
   * This is safe to expose to the signed-in invitee on the gated
   * /invite/accept route; it is NOT mounted as a public endpoint.
   */
  async inspectInvite(token: string): Promise<InspectInviteResultDTO> {
    const row = await verificationRepository.findByIdentifier(INVITE_IDENTIFIER_PREFIX + token);
    if (!row) return { status: 'used' };
    if (row.expiresAt.getTime() <= Date.now()) return { status: 'expired' };

    const payload = parsePayload(row.value);
    if (!payload) return { status: 'used' };

    // Bound + actorless for the reason given on `validateInvite` above; unbound this
    // reported every live invite as 'used'.
    // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
    // Missing, expired and unparseable are all returned above, so this only
    // runs for a token already known good, and `findById` resolves to `null`
    // for a deleted inviter rather than rejecting.
    const [workspace, inviter] = await Promise.all([
      withWorkspaceServiceContext(payload.workspaceId, (tx) =>
        workspaceRepository.findByIdInTx(payload.workspaceId, tx),
      ),
      userRepository.findById(payload.inviterUserId),
    ]);
    if (!workspace) return { status: 'used' };

    const dto = toValidateInviteResultDTO({ workspace, inviter, email: payload.email });
    return { status: 'valid', ...dto };
  },

  /**
   * Accept an invite. Validates the session user's email matches the
   * invite's. In one transaction:
   *   - Create the WorkspaceMembership row
   *   - Delete the Verification row
   *
   * Idempotent: if the user is already a member (AlreadyMemberError
   * from the membership create), we still consume the token so a
   * second-tab accept is a clean no-op.
   */
  async acceptInvite(
    token: string,
    sessionUser: { id: string; email: string },
  ): Promise<AcceptInviteResultDTO> {
    const row = await verificationRepository.findByIdentifier(INVITE_IDENTIFIER_PREFIX + token);
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      throw new InviteExpiredOrMissingError();
    }
    const payload = parsePayload(row.value);
    if (!payload) throw new InviteExpiredOrMissingError();

    const sessionEmail = sessionUser.email.trim().toLowerCase();
    if (sessionEmail !== payload.email) {
      throw new InviteEmailMismatchError(payload.email);
    }

    let organizationId: string | null = null;
    await db.$transaction(async (tx) => {
      // BIND THE TENANT GUCs (MOTIR-2777). The tenant-root INSERT policies from
      // `20260810001000_tenant_root_insert_policies` admit a membership row on two
      // arms, and arm 1 — "acting inside the active tenant" — was written for THIS
      // caller; its migration comment names the invite path explicitly. Unbound,
      // `current_setting(…, true)` is NULL, the predicate is NULL, and every write
      // below is refused with `new row violates row-level security policy`. Set
      // per-transaction (`set_config(…, true)`), so they die with the transaction —
      // the same shape `insertWorkspaceWithOwner` uses for the bootstrap path.
      //
      // WHY BINDING THE ACTIVE-WORKSPACE GUC IS LEGITIMATE HERE, since a reader will
      // ask: the authority is the INVITATION, and it has already been validated above
      // this transaction — the verification row exists, has not expired, and its email
      // matches the session user's. The bind admits only rows targeting that one
      // workspace, and this transaction does nothing beyond the membership, the
      // upward org-join and consuming the token. It grants no reach the invite does
      // not already carry, and it is NOT the self-join arm the migration deliberately
      // refused (that would key on `app.user_id` and admit any workspace a user can
      // name; this keys on the workspace the invite names).
      await tx.$executeRaw`SELECT set_config('app.user_id', ${sessionUser.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${payload.workspaceId}, true)`;
      try {
        await workspaceMembershipRepository.create(
          {
            userId: sessionUser.id,
            workspaceId: payload.workspaceId,
            role: payload.role,
          },
          tx,
        );
      } catch (err) {
        // Idempotency: P2002 on (userId, workspaceId) means the user
        // is already a member. Still consume the token below.
        const isUnique =
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: string }).code === 'P2002';
        if (!isUnique) throw err;
      }
      // Story 6.10.4 — the UPWARD membership invariant (6.10.2 §5i): you cannot
      // be in a workspace without being in its org, and the org access gate
      // (organizationsService.resolveWorkspaceAccess) DENIES a workspace member
      // who isn't an org member. Accepting a cross-org invite must therefore
      // also enrol the invitee in the workspace's org, in the SAME transaction —
      // otherwise the post-accept active-workspace resolution can't reach the
      // joined workspace. (Mirrors workspacesService.addMember's auto-join; the
      // invite-accept path creates the membership directly, so it carries the
      // same invariant.) Idempotent on an already-member.
      const workspace = await workspaceRepository.findByIdInTx(payload.workspaceId, tx);
      if (workspace) {
        organizationId = workspace.organizationId;
        // The org tier needs its OWN GUC, and only now can it be bound: the org id
        // is not known until the workspace read above, which itself needed
        // `app.workspace_id` to return anything at all. Unbound, the org-membership
        // INSERT is refused by `org_membership_insert_active_or_bootstrap`.
        //
        // ⚠️ This read failing silently is what made the bug two bugs. With no
        // workspace GUC bound, `findByIdInTx` returned null, `if (workspace)` was
        // false, and the upward org-join was SKIPPED WITHOUT AN ERROR — leaving a
        // workspace member who is not an org member, which is exactly what the
        // 6.10.2 §5i invariant forbids and what `resolveWorkspaceAccess` then reads
        // as no access. A test that only asserts the workspace membership cannot see
        // it, which is why the regression test asserts BOTH rows.
        await tx.$executeRaw`SELECT set_config('app.organization_id', ${workspace.organizationId}, true)`;
        await organizationsService.ensureOrgMembership(
          sessionUser.id,
          workspace.organizationId,
          tx,
        );
      }
      await verificationRepository.deleteByIdentifier(INVITE_IDENTIFIER_PREFIX + token, tx);
    });

    // Committed → resync the org's scaled-tracker seat quantity (8.1.12): a new
    // invitee enrolling in the org grows its member count. Best-effort + OUTSIDE
    // the tx (a billing failure must never fail the accept); idempotent absolute
    // set, so it no-ops for an already-member or a non-scaled org.
    if (organizationId) await enqueueScaledTrackerSeatSync(organizationId);

    return { workspaceId: payload.workspaceId };
  },
};

// Re-export the error type so route handlers can `catch` without
// importing AlreadyMemberError from two places.
export { AlreadyMemberError };
