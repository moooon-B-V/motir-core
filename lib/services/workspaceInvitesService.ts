import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { sendEvent } from '@/lib/jobs/sendEvent';
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
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InvitePayload {
  workspaceId: string;
  email: string;
  role: string;
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

function resolveBaseUrl(): string {
  // Mirrors lib/auth/index.ts's baseURL resolution so the invite link
  // points at the same canonical origin Better-Auth uses for its own
  // emails. Keeping the resolution identical means a deploy that works
  // for sign-in works for invites too.
  return (
    process.env['BETTER_AUTH_URL'] ??
    (process.env['VERCEL_BRANCH_URL']
      ? `https://${process.env['VERCEL_BRANCH_URL']}`
      : process.env['VERCEL_URL']
        ? `https://${process.env['VERCEL_URL']}`
        : 'http://localhost:3000')
  );
}

function buildInviteAcceptUrl(token: string): string {
  const base = resolveBaseUrl().replace(/\/+$/, '');
  return `${base}/invite/accept?token=${encodeURIComponent(token)}`;
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
    if (!EMAIL_SHAPE.test(email)) throw new InvalidEmailError();

    // Inviter must be a workspace member.
    const inviterMembership = await workspaceMembershipRepository.findByUserAndWorkspace(
      args.inviterUserId,
      args.workspaceId,
    );
    if (!inviterMembership) {
      throw new NotAMemberError(args.inviterUserId, args.workspaceId);
    }

    // Block invites to addresses already in the workspace. Only
    // resolves a membership when the email maps to an existing user
    // — an invite to a brand-new email is fine.
    const existingUser = await userRepository.findByEmail(email);
    if (existingUser) {
      const targetMembership = await workspaceMembershipRepository.findByUserAndWorkspace(
        existingUser.id,
        args.workspaceId,
      );
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

    const workspace = await workspaceRepository.findById(args.workspaceId);
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

    const [workspace, inviter] = await Promise.all([
      workspaceRepository.findById(payload.workspaceId),
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

    const [workspace, inviter] = await Promise.all([
      workspaceRepository.findById(payload.workspaceId),
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

    await db.$transaction(async (tx) => {
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
      await verificationRepository.deleteByIdentifier(INVITE_IDENTIFIER_PREFIX + token, tx);
    });

    return { workspaceId: payload.workspaceId };
  },
};

// Re-export the error type so route handlers can `catch` without
// importing AlreadyMemberError from two places.
export { AlreadyMemberError };
