import { Prisma, type Project, type SavedFilterSubscriptionSchedule } from '@prisma/client';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { savedFilterSubscriptionRepository } from '@/lib/repositories/savedFilterSubscriptionRepository';
import { savedFilterRepository } from '@/lib/repositories/savedFilterRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { canSeeSavedFilter } from '@/lib/savedFilters/access';
import { isBuiltinFilterId } from '@/lib/savedFilters/builtins';
import {
  BuiltinSavedFilterImmutableError,
  InvalidSubscriptionScheduleError,
  SavedFilterNotFoundError,
} from '@/lib/savedFilters/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { toSavedFilterSubscriptionDto } from '@/lib/mappers/savedFilterMappers';
import type { SavedFilterSubscriptionDto } from '@/lib/dto/savedFilters';
import {
  isSubscriptionDue,
  isValidHour,
  isValidWeekday,
  subscriptionOccurrenceKey,
  SUBSCRIPTION_RESULT_CAP,
} from '@/lib/savedFilters/subscriptions';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/savedFilters/subscriptionToken';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { encodeFilterParam, FILTER_PARAM } from '@/lib/filters/ast';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Filter-subscription service (Story 6.2 · Subtask 6.2.5). Two faces:
//
//   * REQUEST side (ctx-bearing): subscribe / unsubscribe / read-mine — the
//     /items + directory row actions. Subscribing is a PERSONAL read-layer
//     action (the starring precedent): anyone who can SEE the filter may
//     subscribe, viewers and non-owners included. Visibility is the SEE gate
//     from the 6.2.1 matrix (lib/savedFilters/access); a filter the actor may
//     not see reads as 404 (finding #44). Built-ins reject (no row to FK — the
//     immutability rule, like star).
//
//   * DELIVERY side (no ctx): the cron tick + per-subscription deliver, on the
//     Story 1.6 jobs substrate. `enqueueDueDeliveries` scans the table
//     CROSS-WORKSPACE under withSystemContext (the attachmentGc precedent — the
//     subscription RLS policy's system-admin branch admits the scan; the
//     denormalized workspace_id lets it enqueue without reading the
//     RLS-protected parent saved_filter). `deliver` then resolves each filter
//     AS THE SUBSCRIBER in that workspace (the 6.2.1 resolve enforces the
//     permission matrix at SEND time — a subscriber who lost browse access, or
//     a filter gone private, simply gets no mail), runs the bounded list read
//     as them, and enqueues one durable `email.send`. The watcherNotifications
//     fan-out is the shape mirrored here (a job-invoked, ctx-less service that
//     reads via the db singleton with an explicit workspaceId and enqueues
//     email.send per recipient).

/** Page size for the cron's cross-workspace due scan — bounded (finding #57).
 * Injectable for tests; production omits it. */
export const DUE_SCAN_PAGE_SIZE = 200;

export interface SubscribeInput {
  schedule: SavedFilterSubscriptionSchedule;
  /** Required when `schedule === 'weekly'` (0=Sun … 6=Sat); ignored otherwise. */
  weekday?: number | null;
  /** 0–23, UTC. */
  hour: number;
}

/** The per-subscription delivery event payload the cron enqueues. */
export interface FilterSubscriptionDeliverInput {
  workspaceId: string;
  subscriptionId: string;
  /** The per-occurrence email idempotency key (one mail per scheduled tick). */
  occurrenceKey: string;
}

export type DeliveryOutcome =
  | { status: 'delivered'; recipient: string; count: number; total: number }
  | {
      status: 'skipped';
      reason: 'subscription_gone' | 'filter_gone' | 'no_access' | 'filter_invalid';
    };

export interface EnqueueSummary {
  hour: number;
  scanned: number;
  due: number;
  enqueued: number;
}

/** Validate + normalize the schedule fields (a 422 on a bad hour/weekday or a
 * `weekly` missing its day). Returns the storable `{ weekday }` (null unless
 * weekly). */
function normalizeSchedule(input: SubscribeInput): { weekday: number | null } {
  if (!isValidHour(input.hour)) {
    throw new InvalidSubscriptionScheduleError('Subscription hour must be an integer 0–23 (UTC).');
  }
  if (input.schedule === 'weekly') {
    if (input.weekday == null || !isValidWeekday(input.weekday)) {
      throw new InvalidSubscriptionScheduleError(
        'A weekly subscription needs a weekday (0=Sunday … 6=Saturday).',
      );
    }
    return { weekday: input.weekday };
  }
  // daily / weekdays carry no day.
  return { weekday: null };
}

/** Resolve the project + the visible filter row under the SEE gate (the
 * subscribe/unsubscribe/read entry gate). Mirrors savedFiltersService's
 * internal resolveProjectAndCaps + getVisibleFilter. Built-ins reject. */
async function resolveVisibleFilter(
  projectKey: string,
  filterId: string,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<{ project: Project; savedFilterId: string }> {
  if (isBuiltinFilterId(filterId)) throw new BuiltinSavedFilterImmutableError();
  const key = projectKey.trim().toUpperCase();
  const project = await projectRepository.findByIdentifier(ctx.workspaceId, key, tx);
  if (!project) throw new ProjectNotFoundError(projectKey);
  const caps = await projectAccessService.getSavedFilterCapabilities(project.id, ctx, tx);
  if (!caps.canBrowse) throw new ProjectNotFoundError(projectKey);
  const row = await savedFilterRepository.findByIdWithStars(filterId, ctx.userId, tx);
  if (!row || row.projectId !== project.id) throw new SavedFilterNotFoundError(filterId);
  if (
    !canSeeSavedFilter(caps, { isOwner: row.ownerId === ctx.userId, visibility: row.visibility })
  ) {
    throw new SavedFilterNotFoundError(filterId);
  }
  return { project, savedFilterId: row.id };
}

export const savedFilterSubscriptionsService = {
  /** The actor's subscription to a visible filter, or `null` — the
   * subscribed-state read behind the row action. */
  async getMine(
    projectKey: string,
    filterId: string,
    ctx: ServiceContext,
  ): Promise<SavedFilterSubscriptionDto | null> {
    const { savedFilterId } = await resolveVisibleFilter(projectKey, filterId, ctx);
    const row = await savedFilterSubscriptionRepository.findByFilterAndUser(
      savedFilterId,
      ctx.userId,
    );
    return row ? toSavedFilterSubscriptionDto(row) : null;
  },

  /**
   * Subscribe (or re-schedule) the actor to a visible filter. Upsert by
   * (filter, user): a second subscribe edits the schedule rather than
   * duplicating. The visible-filter gate + the row lock guard the read-derived
   * upsert (lock-before-read-derived-update).
   */
  async subscribe(
    projectKey: string,
    filterId: string,
    input: SubscribeInput,
    ctx: ServiceContext,
  ): Promise<SavedFilterSubscriptionDto> {
    const { weekday } = normalizeSchedule(input);
    return db.$transaction(async (tx) => {
      const { project, savedFilterId } = await resolveVisibleFilter(projectKey, filterId, ctx, tx);
      const existing = await savedFilterSubscriptionRepository.findByFilterAndUser(
        savedFilterId,
        ctx.userId,
        tx,
      );
      const row = existing
        ? await savedFilterSubscriptionRepository.update(
            existing.id,
            { schedule: input.schedule, weekday, hour: input.hour },
            tx,
          )
        : await savedFilterSubscriptionRepository.create(
            {
              workspaceId: project.workspaceId,
              savedFilterId,
              userId: ctx.userId,
              schedule: input.schedule,
              weekday,
              hour: input.hour,
            },
            tx,
          );
      return toSavedFilterSubscriptionDto(row);
    });
  },

  /** Unsubscribe the actor from a visible filter (in-app). Idempotent — a
   * never-subscribed filter is a no-op. */
  async unsubscribe(projectKey: string, filterId: string, ctx: ServiceContext): Promise<void> {
    await db.$transaction(async (tx) => {
      const { savedFilterId } = await resolveVisibleFilter(projectKey, filterId, ctx, tx);
      await savedFilterSubscriptionRepository.deleteByFilterAndUser(savedFilterId, ctx.userId, tx);
    });
  },

  /**
   * Token-authenticated unsubscribe (the email link — no session). Verifies
   * the HMAC token, then deletes that one subscription under system context
   * (cross-workspace, no active workspace). Idempotent: an already-removed
   * subscription still reports success (the link stays safe to click twice);
   * only a malformed/forged token reports `invalid`.
   */
  async unsubscribeByToken(token: string): Promise<{ status: 'unsubscribed' | 'invalid' }> {
    const subscriptionId = verifyUnsubscribeToken(token);
    if (!subscriptionId) return { status: 'invalid' };
    await withSystemContext((tx) =>
      savedFilterSubscriptionRepository.deleteById(subscriptionId, tx),
    );
    return { status: 'unsubscribed' };
  },

  /**
   * The hourly cron's work: scan every workspace's subscriptions configured
   * for the current UTC hour, keep the ones actually DUE now (schedule +
   * weekday), and enqueue one delivery event each. Bounded + cursor-paged
   * across the cross-workspace set (finding #57). `now` is injected (the job
   * passes `new Date()`; tests freeze it).
   */
  async enqueueDueDeliveries(now: Date, opts: { pageSize?: number } = {}): Promise<EnqueueSummary> {
    const pageSize = opts.pageSize ?? DUE_SCAN_PAGE_SIZE;
    const hour = now.getUTCHours();
    let cursor: string | undefined;
    let scanned = 0;
    let due = 0;
    let enqueued = 0;
    for (;;) {
      // Read each page in its OWN system-context transaction (the GUC is
      // transaction-scoped); enqueue OUTSIDE it (sendEvent is a network call).
      const rows = await withSystemContext((tx) =>
        savedFilterSubscriptionRepository.listDueByHour({ hour, take: pageSize + 1, cursor }, tx),
      );
      const pageRows = rows.slice(0, pageSize);
      scanned += pageRows.length;
      for (const sub of pageRows) {
        if (!isSubscriptionDue(sub, now)) continue;
        due += 1;
        await sendEvent('filter-subscription/deliver', {
          workspaceId: sub.workspaceId,
          subscriptionId: sub.id,
          occurrenceKey: subscriptionOccurrenceKey(sub.id, now),
        });
        enqueued += 1;
      }
      if (rows.length <= pageSize) break;
      cursor = pageRows[pageRows.length - 1]!.id;
    }
    return { hour, scanned, due, enqueued };
  },

  /**
   * Deliver one subscription: resolve the filter AS THE SUBSCRIBER (the 6.2.1
   * permission matrix at send time), run the bounded list read as them, and
   * enqueue the durable `email.send`. Resolves (never throws) to a typed
   * `skipped` outcome for every "no mail" path — a vanished subscription /
   * filter, a subscriber who lost access or whom the filter went private on,
   * or a stored envelope that no longer decodes — so the job DLQ stays clean
   * for these EXPECTED races. A stale OPEN referent (deleted label/option)
   * leaves a VALID ast that simply matches nothing — that delivers normally
   * (zero results; a report, not an alert).
   */
  async deliver(input: FilterSubscriptionDeliverInput): Promise<DeliveryOutcome> {
    const sub = await savedFilterSubscriptionRepository.findById(input.subscriptionId);
    if (!sub) return { status: 'skipped', reason: 'subscription_gone' };

    const filterRow = await savedFilterRepository.findByIdWithStars(sub.savedFilterId, sub.userId);
    if (!filterRow) return { status: 'skipped', reason: 'filter_gone' };
    const project = await projectRepository.findById(filterRow.projectId);
    if (!project) return { status: 'skipped', reason: 'filter_gone' };

    const subscriberCtx: ServiceContext = { userId: sub.userId, workspaceId: input.workspaceId };

    let resolved;
    try {
      resolved = await savedFiltersService.resolve(
        project.identifier,
        sub.savedFilterId,
        subscriberCtx,
      );
    } catch (err) {
      // Lost browse access OR the filter went private/deleted under the
      // subscriber — both are "no mail", not a job failure (finding #44).
      if (err instanceof ProjectNotFoundError || err instanceof SavedFilterNotFoundError) {
        return { status: 'skipped', reason: 'no_access' };
      }
      throw err;
    }
    // A malformed / future-versioned stored envelope can't be queried; skip
    // (the AC's "survives a stale-referent AST" path is the VALID-ast / zero-
    // result case below, which delivers normally).
    if (!resolved.ast || resolved.filter.builtin)
      return { status: 'skipped', reason: 'filter_invalid' };

    const [user] = await userRepository.findByIds([sub.userId]);
    if (!user) return { status: 'skipped', reason: 'no_access' };

    // Run the bounded read AS the subscriber (re-checks browse; caps at 50).
    const pageResult = await workItemsService.getProjectIssuesList(
      project.id,
      {
        sort: DEFAULT_SORT,
        filter: { ast: resolved.ast },
        page: 1,
        pageSize: SUBSCRIPTION_RESULT_CAP,
      },
      subscriberCtx,
    );

    // Status KEY → display label (the List ships the key; the email shows the
    // workflow's stored label, falling back to the key for a since-deleted one).
    const statuses = await workflowsRepository.findStatuses(project.id, input.workspaceId);
    const labelByKey = new Map(statuses.map((s) => [s.key, s.label]));
    const items = pageResult.items.map((i) => ({
      identifier: i.identifier,
      title: i.title,
      status: labelByKey.get(i.status) ?? i.status,
    }));

    const base = resolveBaseUrlTrimmed();
    const filterUrl = `${base}/items?${FILTER_PARAM}=${encodeURIComponent(encodeFilterParam(resolved.ast))}`;
    const unsubscribeUrl = `${base}/unsubscribe/filter-subscription?token=${encodeURIComponent(
      signUnsubscribeToken(sub.id),
    )}`;

    await sendEvent('email.send', {
      workspaceId: input.workspaceId,
      // One mail per scheduled occurrence — Inngest dedups same-key email.send.
      idempotencyKey: input.occurrenceKey,
      to: user.email,
      template: 'filter-subscription',
      data: {
        recipientName: user.name,
        filterName: resolved.filter.name,
        projectKey: project.identifier,
        items,
        totalCount: pageResult.total,
        resultCap: SUBSCRIPTION_RESULT_CAP,
        filterUrl,
        unsubscribeUrl,
      },
    });

    return {
      status: 'delivered',
      recipient: user.email,
      count: items.length,
      total: pageResult.total,
    };
  },
};
