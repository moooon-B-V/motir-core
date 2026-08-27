import type { PublicFollow } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { publicFollowRepository } from '@/lib/repositories/publicFollowRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { publicProjectUrl } from '@/lib/publicProjects/urls';
import { signUnsubscribeToken, UNCONFIRMED_FOLLOW_TTL_MS } from '@/lib/publicProjects/followTokens';

// The weekly follower DIGEST (Story 8.9 · Subtask 8.9.7 ·
// `docs/decisions/public-follow-and-changelog.md` §4).
//
// TICK → DELIVER, the shape `filterSubscriptionTick` sets: the cron scans and
// fans out ONE event per due follower, so a single follower's failure retries
// and dead-letters on its own instead of failing the whole sweep.
//
// ⚠️ THE EXCLUSION IS RE-RUN AT SEND TIME, and that is the one thing in this
// file that must not be "optimised" into a cached set. An epic made private on
// Wednesday must not appear in Monday's mail because it was public when the
// item shipped — so the deliver step composes `publicProjectsService`'s own
// changelog read, live, at the moment it builds the message. One read, one
// definition of shipped, one privacy predicate, shared with the page and the
// feed.
//
// ⚠️ AND AN EMPTY DIGEST IS NOT SENT. A week in which a project shipped nothing
// produces no mail at all. Silence is information; "0 items shipped" is what
// trains people to filter you.

/** How far back a first-time digest looks when the follower has never had one. */
const FIRST_DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How many followers one deliver-fan-out page reads at a time. */
const AUDIENCE_PAGE = 200;

export const publicFollowDigestService = {
  /**
   * The weekly sweep. Walks every PUBLIC project, pages its confirmed opt-in
   * audience, and enqueues one `public-follow/digest` per follower who is due.
   *
   * Cross-tenant by construction (it spans every public project), so the scan
   * runs under `withSystemContext` — the same posture the filter-subscription
   * tick takes, and the reason `system.*` jobs exist.
   */
  async enqueueDueDigests(now: Date): Promise<{ projects: number; enqueued: number }> {
    const projects = await publicProjectsService.listPublicForSitemap();
    let enqueued = 0;

    for (const { identifier } of projects) {
      const project = await projectRepository.findPublicByIdentifier(identifier);
      if (!project) continue;

      let cursor: string | undefined;
      for (;;) {
        const page: PublicFollow[] = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
          publicFollowRepository.findDigestAudience(
            project.id,
            { take: AUDIENCE_PAGE, ...(cursor ? { cursor } : {}) },
            tx,
          ),
        );
        if (page.length === 0) break;

        for (const follower of page) {
          if (!isDue(follower, now)) continue;
          await sendEvent('public-follow/digest', {
            workspaceId: project.workspaceId,
            followId: follower.id,
            // The per-occurrence key: one mail per follower per WEEK, whatever
            // the sweep does. A re-run of the tick inside the same window
            // collapses to one delivery at the job runtime AND at the provider.
            occurrenceKey: `${follower.id}:${weekKey(now)}`,
          });
          enqueued += 1;
        }
        cursor = page[page.length - 1]?.id;
        if (page.length < AUDIENCE_PAGE) break;
      }
    }
    return { projects: projects.length, enqueued };
  },

  /**
   * Deliver ONE follower's digest. Reads the window's shipped set live (see the
   * header), skips silently when it is empty, and stamps `lastDigestAt` so the
   * next window starts where this one ended rather than re-sending it.
   */
  async deliverDigest(args: {
    workspaceId: string;
    followId: string;
    occurrenceKey: string;
    now: Date;
  }): Promise<{ sent: boolean; itemCount: number }> {
    const follow = await withWorkspaceServiceContext(args.workspaceId, (tx) =>
      publicFollowRepository.findById(args.followId, tx),
    );
    // A follow deleted between the tick and the deliver is not an error — the
    // person unsubscribed, which is exactly what should stop this mail.
    if (!follow || !follow.digestOptIn || !follow.confirmedAt) return { sent: false, itemCount: 0 };

    const project = await projectRepository.findById(follow.projectId);
    if (!project) return { sent: false, itemCount: 0 };

    const since = follow.lastDigestAt ?? new Date(args.now.getTime() - FIRST_DIGEST_WINDOW_MS);

    // LIVE, at send time. The same read the page and the feed use, so a private
    // epic that became private after the item shipped is excluded here too.
    const { entries } = await publicProjectsService.getChangelogFeed(project.identifier, null);
    const fresh = entries.filter((entry) => new Date(entry.shippedAt) > since);

    const to = await resolveRecipient(follow);
    if (fresh.length === 0 || !to) {
      // Nothing shipped: send NOTHING, and still move the window forward so the
      // next digest does not re-scan a period already considered.
      await stampDelivered(args.workspaceId, follow.id, args.now);
      return { sent: false, itemCount: 0 };
    }

    const base = publicProjectUrl(project.identifier);
    await sendEvent('email.send', {
      workspaceId: args.workspaceId,
      idempotencyKey: args.occurrenceKey,
      to,
      template: 'follow-digest',
      data: {
        projectName: project.name,
        changelogUrl: `${base}/changelog`,
        // DERIVED, not stored and not rotated — so this exact link still works
        // if somebody finds this mail in two years (`followTokens.ts`).
        unsubscribeUrl: `${resolveBaseUrlTrimmed()}/follow/unsubscribe?token=${encodeURIComponent(
          signUnsubscribeToken(follow.id),
        )}`,
        entries: fresh.map((entry) => ({
          identifier: entry.identifier,
          title: entry.title,
          url: `${base}/items/${entry.identifier}`,
        })),
      },
    });

    await stampDelivered(args.workspaceId, follow.id, args.now);
    return { sent: true, itemCount: fresh.length };
  },

  /**
   * Delete email-only follows whose confirmation was never used (ADR §4). An
   * address typed by somebody else, or mistyped, costs its owner one email and
   * then disappears rather than sitting here indefinitely.
   */
  async sweepUnconfirmed(now: Date): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - UNCONFIRMED_FOLLOW_TTL_MS);
    const deleted = await withSystemContext((tx) =>
      publicFollowRepository.deleteUnconfirmedBefore(cutoff, tx),
    );
    return { deleted };
  },
};

/** Weekly cadence: due when the last digest was in a previous ISO week. */
function isDue(follow: PublicFollow, now: Date): boolean {
  if (!follow.lastDigestAt) return true;
  return weekKey(follow.lastDigestAt) !== weekKey(now);
}

/** `YYYY-Www` in UTC — the idempotency window AND the due-ness comparison. */
function weekKey(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // ISO week: Thursday decides the year.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The address to mail: the account's, or the email-only row's own. */
async function resolveRecipient(follow: PublicFollow): Promise<string | null> {
  if (follow.email) return follow.email;
  if (!follow.userId) return null;
  const user = await userRepository.findById(follow.userId);
  return user?.email ?? null;
}

async function stampDelivered(workspaceId: string, followId: string, at: Date): Promise<void> {
  await withWorkspaceServiceContext(workspaceId, (tx) =>
    publicFollowRepository.update(followId, { lastDigestAt: at }, tx),
  );
}
