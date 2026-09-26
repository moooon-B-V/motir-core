import {
  Prisma,
  type OrganizationDeletionNoticeKind,
  type OrganizationRole,
} from '@/generated/prisma/client';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { EmailSendData } from '@/lib/jobs/types';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { retentionEndsAt } from '@/lib/organizations/deletion';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationDeletionNoticeRepository } from '@/lib/repositories/organizationDeletionNoticeRepository';
import { organizationDeletionRequestRepository } from '@/lib/repositories/organizationDeletionRequestRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { DATA_PRIVACY_PANE_PATH } from '@/lib/users/dataSubjectRequests';
import { formatDate } from '@/lib/utils/datetime';
import { withSystemContext } from '@/lib/workspaces/context';

// THE ORGANIZATION-DELETION NOTIFIER (Story MOTIR-6306 · MOTIR-6395). Contract:
// `docs/decisions/organization-deletion.md` §8 — who is told what:
//
//   scheduled        every member (Owner, Admins, Members)
//   7 / 1 day left   the Owner and the Admins
//   cancelled        every member
//   erased           the Owner and the Admins, captured BEFORE the tombstone
//
// ── CALLED AFTER THE CALLER COMMITS, AND IT NEVER FAILS THE CALLER ─────────────
// The schedule / cancel service (MOTIR-6399) and the erasure sweep (MOTIR-6400)
// call these after their own transaction has committed. Every method swallows and
// logs its own failure: the deletion stands whether or not the mail went out, and a
// mail outage must never un-schedule, un-cancel or un-erase anything.
//
// ── EXACTLY ONCE PER (request, kind, daysLeft) ──────────────────────────────────
// Each notice is recorded in `organization_deletion_notice` AFTER its emails are
// enqueued. A notice already recorded sends nothing — so a retried caller, and the
// reminder job running every day for a month, never mail twice. Each email also
// carries a per-recipient idempotency key, so a crash between the enqueue and the
// record re-sends at worst inside the engine's own dedupe window.
//
// ── RECIPIENTS ARE RESOLVED AT SEND TIME ────────────────────────────────────────
// From the org's memberships, read under the org's own context (the
// `organization_membership` read policy admits `app.organization_id`) — except the
// erased notice, whose recipients the sweep captures before it removes the
// memberships, and passes in.

/** Reminder thresholds, in days before the due date, largest first. */
export const REMINDER_DAYS = [7, 1] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many due requests one reminder run considers. */
const REMINDER_BATCH = 200;

export interface NoticeRecipient {
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
}

type Audience = 'owner' | 'admin' | 'member';

function audienceOf(role: OrganizationRole): Audience {
  return role === 'owner' ? 'owner' : role === 'admin' ? 'admin' : 'member';
}

/** The org and its members, read in one org-context transaction (both the
 *  `organization` and the `organization_membership` read policies admit
 *  `app.organization_id`). `null` when the org no longer exists. */
async function orgSnapshot(organizationId: string) {
  return withOrgServiceWriteContext(organizationId, async (tx) => {
    const organization = await organizationRepository.findByIdInTx(organizationId, tx);
    if (!organization) return null;
    const rows = await organizationMembershipRepository.findMembersByOrg(organizationId, tx);
    const members: NoticeRecipient[] = rows
      .filter((row) => Boolean(row.user.email))
      .map((row) => ({
        userId: row.user.id,
        name: row.user.name,
        email: row.user.email,
        role: row.role,
      }));
    return { organization, members };
  });
}

/** An actor's display name — from the roster (the Owner scheduled it; an Owner or
 *  Admin cancelled it), falling back to the org's own name. */
function nameOf(userId: string | null, members: NoticeRecipient[], fallback: string): string {
  return members.find((m) => m.userId === userId)?.name ?? fallback;
}

/** Has this notice already gone out? */
async function alreadySent(key: {
  requestId: string;
  kind: OrganizationDeletionNoticeKind;
  daysLeft: number;
}) {
  return (
    (await withSystemContext((tx) => organizationDeletionNoticeRepository.find(key, tx))) !== null
  );
}

/** Record the notice; a concurrent recorder's `P2002` means it is recorded. */
async function record(key: {
  requestId: string;
  kind: OrganizationDeletionNoticeKind;
  daysLeft: number;
}) {
  try {
    await withSystemContext((tx) => organizationDeletionNoticeRepository.create(key, tx));
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
}

/** `sendEvent` is best-effort by default: a transport failure is logged there and
 *  never reaches us. */
async function enqueue(email: EmailSendData): Promise<void> {
  await sendEvent('email.send', email);
}

function logFailure(what: string, requestId: string, err: unknown): void {
  console.error(`[organizationDeletionNotifier] the ${what} notice failed; the deletion stands`, {
    requestId,
    err,
  });
}

/** The request, its org and the org's roster — everything a notice needs. */
async function loadContext(requestId: string) {
  const request = await withSystemContext((tx) =>
    organizationDeletionRequestRepository.findById(requestId, tx),
  );
  if (!request) return null;
  const snapshot = await orgSnapshot(request.organizationId);
  if (!snapshot) return null;
  return { request, ...snapshot };
}

/**
 * Tell every member that the organization is scheduled for deletion. Idempotent per
 * request; never throws.
 */
async function notifyScheduled(requestId: string): Promise<void> {
  try {
    const key = { requestId, kind: 'scheduled' as const, daysLeft: 0 };
    if (await alreadySent(key)) return;
    const ctx = await loadContext(requestId);
    if (!ctx) return;
    const base = resolveBaseUrlTrimmed();
    const dueDate = formatDate(ctx.request.erasureDueAt.toISOString());
    for (const member of ctx.members) {
      await enqueue({
        workspaceId: null,
        idempotencyKey: `org-deletion:${requestId}:scheduled:${member.userId}`,
        to: member.email,
        template: 'organization-deletion-scheduled',
        data: {
          audience: member.role === 'owner' ? 'owner' : 'member',
          recipientName: member.name,
          organizationName: ctx.organization.name,
          scheduledByName: nameOf(
            ctx.request.requestedByUserId,
            ctx.members,
            ctx.organization.name,
          ),
          dueDate,
          settingsUrl: `${base}/settings/organization`,
          exportUrl: `${base}${DATA_PRIVACY_PANE_PATH}`,
        },
      });
    }
    await record(key);
  } catch (err) {
    logFailure('scheduled', requestId, err);
  }
}

/** Tell every member the deletion was cancelled. Idempotent per request; never throws. */
async function notifyCancelled(requestId: string): Promise<void> {
  try {
    const key = { requestId, kind: 'cancelled' as const, daysLeft: 0 };
    if (await alreadySent(key)) return;
    const ctx = await loadContext(requestId);
    if (!ctx) return;
    const appUrl = resolveBaseUrlTrimmed();
    for (const member of ctx.members) {
      await enqueue({
        workspaceId: null,
        idempotencyKey: `org-deletion:${requestId}:cancelled:${member.userId}`,
        to: member.email,
        template: 'organization-deletion-cancelled',
        data: {
          recipientName: member.name,
          organizationName: ctx.organization.name,
          cancelledByName: nameOf(
            ctx.request.cancelledByUserId,
            ctx.members,
            ctx.organization.name,
          ),
          appUrl,
        },
      });
    }
    await record(key);
  } catch (err) {
    logFailure('cancelled', requestId, err);
  }
}

/**
 * Tell the Owner and Admins the organization has been erased. The sweep passes the
 * org's pre-scrub NAME and the RECIPIENTS it captured before removing the
 * memberships — neither can be read afterwards. Idempotent per request; never throws.
 */
async function notifyErased(input: {
  requestId: string;
  organizationName: string;
  erasedAt: Date;
  recipients: NoticeRecipient[];
}): Promise<void> {
  try {
    const key = { requestId: input.requestId, kind: 'erased' as const, daysLeft: 0 };
    if (await alreadySent(key)) return;
    const retentionUntilYear = retentionEndsAt(input.erasedAt).getUTCFullYear();
    for (const recipient of input.recipients) {
      if (audienceOf(recipient.role) === 'member') continue;
      await enqueue({
        workspaceId: null,
        idempotencyKey: `org-deletion:${input.requestId}:erased:${recipient.userId}`,
        to: recipient.email,
        template: 'organization-erased',
        data: {
          recipientName: recipient.name,
          organizationName: input.organizationName,
          retentionUntilYear,
        },
      });
    }
    await record(key);
  } catch (err) {
    logFailure('erased', input.requestId, err);
  }
}

/**
 * The daily reminder pass: for every `scheduled` request whose due date is within
 * a reminder threshold, send that threshold's reminder to the Owner and Admins if
 * it has not gone out yet. Only the SMALLEST threshold reached is sent — a request
 * found with one day left gets the 1-day reminder, not a stale 7-day one as well.
 * Returns how many reminders were sent. Never throws for one request's failure.
 */
async function sendDueReminders(now: Date = new Date()): Promise<{ remindersSent: number }> {
  const horizon = new Date(now.getTime() + REMINDER_DAYS[0] * DAY_MS);
  const due = await withSystemContext((tx) =>
    organizationDeletionRequestRepository.listScheduledDueBy(horizon, REMINDER_BATCH, tx),
  );
  let remindersSent = 0;
  for (const request of due) {
    try {
      const msLeft = request.erasureDueAt.getTime() - now.getTime();
      if (msLeft <= 0) continue; // due: the sweep's, not a reminder's
      const threshold = [...REMINDER_DAYS].reverse().find((days) => msLeft <= days * DAY_MS);
      if (threshold === undefined) continue;
      const key = { requestId: request.id, kind: 'reminder' as const, daysLeft: threshold };
      if (await alreadySent(key)) continue;
      const snapshot = await orgSnapshot(request.organizationId);
      if (!snapshot) continue;
      const { organization, members } = snapshot;
      const owner = members.find((m) => m.role === 'owner');
      const base = resolveBaseUrlTrimmed();
      const dueDate = formatDate(request.erasureDueAt.toISOString());
      const daysLeft = Math.max(1, Math.ceil(msLeft / DAY_MS));
      for (const member of members) {
        const audience = audienceOf(member.role);
        if (audience === 'member') continue;
        await enqueue({
          workspaceId: null,
          idempotencyKey: `org-deletion:${request.id}:reminder-${threshold}:${member.userId}`,
          to: member.email,
          template: 'organization-deletion-reminder',
          data: {
            audience,
            recipientName: member.name,
            organizationName: organization.name,
            ownerName: owner?.name ?? organization.name,
            dueDate,
            daysLeft,
            settingsUrl: `${base}/settings/organization`,
          },
        });
      }
      await record(key);
      remindersSent += 1;
    } catch (err) {
      logFailure('reminder', request.id, err);
    }
  }
  return { remindersSent };
}

export const organizationDeletionNotifier = {
  notifyScheduled,
  notifyCancelled,
  notifyErased,
  sendDueReminders,
};
