import 'server-only';

import type { EnterpriseRequestStatus } from '@/generated/prisma/client';
import {
  ENTERPRISE_REQUEST_FILTERS,
  ENTERPRISE_REQUEST_PAGE_SIZE,
  type EnterpriseRequestFilter,
  type EnterpriseRequestStatusValue,
  type PlatformEnterpriseRequestDetailDTO,
  type PlatformEnterpriseRequestMoveDTO,
  type PlatformEnterpriseRequestPageDTO,
} from '@/lib/dto/platformEnterpriseRequest';
import {
  toPlatformEnterpriseRequestDTO,
  toPlatformEnterpriseRequestMoveDTO,
} from '@/lib/mappers/platformMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import {
  EnterpriseRequestIllegalTransitionError,
  EnterpriseRequestStaleError,
  NotPlatformStaffError,
  PlatformEnterpriseRequestNotFoundError,
  PlatformEnterpriseRequestQueryInvalidError,
} from '@/lib/platform/errors';
import {
  enterpriseRequestRepository,
  OPEN_ENTERPRISE_REQUEST_STATUSES,
} from '@/lib/repositories/enterpriseRequestRepository';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';

/**
 * The operator console's side of ENTERPRISE REQUESTS — Story MOTIR-7602 ·
 * MOTIR-7608 (design `platform-admin/design-notes.md` § Enterprise requests).
 *
 * Orgs send a request from Billing & plans (`enterpriseRequestService`,
 * MOTIR-7605); staff list it, read it and move it through its states here. Any
 * staff role reads; `operator` and up move. Every read is one `estate.read`
 * audit row, and every move one `enterprise_request.transition` row written in
 * the same transaction as the move (ADR `platform-staff-auth.md` §7).
 *
 * ---------------------------------------------------------------------------
 * THE LIFECYCLE IS A CLOSED EDGE SET, AND THE STATE GUARD IS THE UPDATE ITSELF
 * ---------------------------------------------------------------------------
 * `new → contacted → offer_sent → won`, and any open state → `lost`; `won` and
 * `lost` are terminal. A move names the state it starts FROM, and the update is
 * conditional on it (`enterpriseRequestRepository.transitionIf`): when another
 * staff member moved the request first, the update matches no row, the
 * transaction rolls back — taking its audit row with it — and the caller gets
 * `EnterpriseRequestStaleError` carrying the state the request is actually in.
 * A read-then-write here would let both moves land and the History show two
 * moves out of one state.
 */

const NEXT: Record<EnterpriseRequestStatusValue, readonly EnterpriseRequestStatusValue[]> = {
  new: ['contacted', 'lost'],
  contacted: ['offer_sent', 'lost'],
  offer_sent: ['won', 'lost'],
  won: [],
  lost: [],
};

const CLOSED = new Set<EnterpriseRequestStatusValue>(['won', 'lost']);

const TRANSITION_ACTION = 'enterprise_request.transition';

/** The statuses one filter segment covers, or null for every state. */
function statusesOf(filter: EnterpriseRequestFilter): readonly EnterpriseRequestStatus[] | null {
  if (filter === 'all') return null;
  if (filter === 'open') return OPEN_ENTERPRISE_REQUEST_STATUSES;
  return [filter];
}

function countsOf(
  byStatus: { status: EnterpriseRequestStatus; count: number }[],
): Record<EnterpriseRequestFilter, number> {
  const counts = Object.fromEntries(ENTERPRISE_REQUEST_FILTERS.map((f) => [f, 0])) as Record<
    EnterpriseRequestFilter,
    number
  >;
  const open = new Set<string>(OPEN_ENTERPRISE_REQUEST_STATUSES);
  for (const { status, count } of byStatus) {
    counts[status] += count;
    counts.all += count;
    if (open.has(status)) counts.open += count;
  }
  return counts;
}

function parseFilter(raw: string | null | undefined): EnterpriseRequestFilter {
  if (raw === null || raw === undefined || raw === '') return 'open';
  if ((ENTERPRISE_REQUEST_FILTERS as readonly string[]).includes(raw)) {
    return raw as EnterpriseRequestFilter;
  }
  throw new PlatformEnterpriseRequestQueryInvalidError('filter');
}

/** True for an edge of the lifecycle. */
export function isLegalEnterpriseRequestMove(
  from: EnterpriseRequestStatusValue,
  to: EnterpriseRequestStatusValue,
): boolean {
  return NEXT[from]?.includes(to) ?? false;
}

export const platformEnterpriseRequestService = {
  /**
   * One page of requests, newest first, 50 a page, narrowed by the state
   * filter (default **Open**), with the filter's total and every segment's
   * count. Keyset-paged: `cursor` is the previous page's `nextCursor`.
   *
   * @throws NotPlatformStaffError for a non-staff caller.
   * @throws PlatformEnterpriseRequestQueryInvalidError for an unknown filter, or
   *   a cursor that names no request.
   */
  async list(
    principal: PlatformPrincipal,
    query: { status?: string | null; cursor?: string | null } = {},
  ): Promise<PlatformEnterpriseRequestPageDTO> {
    await requirePlatformStaff('support');
    const filter = parseFilter(query.status);
    const cursor = query.cursor?.trim() || null;

    const { rows, byStatus } = await withPlatformRead(
      principal,
      {
        action: 'estate.read',
        targetKind: 'platform',
        targetLabel: 'enterprise requests',
        metadata: { filter, cursor },
      },
      async (tx) => {
        if (cursor && !(await enterpriseRequestRepository.findById(cursor, tx))) {
          throw new PlatformEnterpriseRequestQueryInvalidError('cursor');
        }
        const [rows, byStatus] = await Promise.all([
          enterpriseRequestRepository.listPage(
            statusesOf(filter),
            cursor,
            ENTERPRISE_REQUEST_PAGE_SIZE + 1,
            tx,
          ),
          enterpriseRequestRepository.countByStatus(tx),
        ]);
        return { rows, byStatus };
      },
    );

    const page = rows.slice(0, ENTERPRISE_REQUEST_PAGE_SIZE);
    const counts = countsOf(byStatus);
    return {
      filter,
      requests: page.map(toPlatformEnterpriseRequestDTO),
      total: counts[filter],
      counts,
      nextCursor: rows.length > ENTERPRISE_REQUEST_PAGE_SIZE ? page[page.length - 1]!.id : null,
      pageSize: ENTERPRISE_REQUEST_PAGE_SIZE,
    };
  },

  /**
   * One request with its History — every applied move, oldest first, read from
   * its `enterprise_request.transition` audit rows — and the moves THIS viewer
   * may make next (none for `support`, none on a closed request).
   *
   * @throws NotPlatformStaffError for a non-staff caller.
   * @throws PlatformEnterpriseRequestNotFoundError for an unknown id.
   */
  async get(principal: PlatformPrincipal, id: string): Promise<PlatformEnterpriseRequestDetailDTO> {
    await requirePlatformStaff('support');

    const { row, moves } = await withPlatformRead(
      principal,
      {
        action: 'estate.read',
        targetKind: 'platform',
        targetLabel: 'enterprise request',
        metadata: { requestId: id },
      },
      async (tx) => {
        const row = await enterpriseRequestRepository.findByIdWithParties(id, tx);
        if (!row) throw new PlatformEnterpriseRequestNotFoundError(id);
        const moves = await platformAuditLogRepository.listByActionAndMetadata(
          TRANSITION_ACTION,
          'requestId',
          id,
          tx,
        );
        return { row, moves };
      },
    );

    const canMove = platformRoleAtLeast(principal.role, 'operator');
    return {
      request: toPlatformEnterpriseRequestDTO(row),
      history: moves
        .map(toPlatformEnterpriseRequestMoveDTO)
        .filter((m): m is PlatformEnterpriseRequestMoveDTO => m !== null),
      moves: canMove ? [...NEXT[row.status]] : [],
    };
  },

  /**
   * Move a request from `from` to `to`. `organizationId` is the org the page
   * read the request under — it names the audit row's target up front, and the
   * move is refused (as not found, rolled back) when the request is not that
   * org's. Sets `closedAt` on `won` / `lost`. Returns nothing: the page
   * re-reads the request (the page-state-after-mutation contract), and that
   * read is its own audited `get`.
   *
   * @throws NotPlatformStaffError below `operator`.
   * @throws EnterpriseRequestIllegalTransitionError for a move that is not an
   *   edge — nothing is read or written.
   * @throws PlatformEnterpriseRequestNotFoundError for an unknown id, or one
   *   that is not `organizationId`'s.
   * @throws EnterpriseRequestStaleError when the request is no longer in
   *   `from` — nothing changed, nothing recorded.
   */
  async transition(
    principal: PlatformPrincipal,
    id: string,
    move: {
      organizationId: string;
      from: EnterpriseRequestStatusValue;
      to: EnterpriseRequestStatusValue;
    },
  ): Promise<void> {
    await requirePlatformStaff('operator');
    // The gate reads the session; the principal is what the audit row names,
    // so a `support` principal handed in alongside an operator's session is
    // refused too.
    if (!platformRoleAtLeast(principal.role, 'operator')) throw new NotPlatformStaffError();
    const { organizationId, from, to } = move;
    if (!isLegalEnterpriseRequestMove(from, to)) {
      throw new EnterpriseRequestIllegalTransitionError(from, to);
    }

    await withPlatformRead(
      principal,
      {
        action: TRANSITION_ACTION,
        targetKind: 'organization',
        targetId: organizationId,
        organizationId,
        reason: `Moved Enterprise request ${id} from ${from} to ${to}.`,
        metadata: { requestId: id, from, to },
      },
      async (tx) => {
        const moved = await enterpriseRequestRepository.transitionIf(
          id,
          from,
          to,
          CLOSED.has(to) ? new Date() : null,
          tx,
        );
        const current = await enterpriseRequestRepository.findById(id, tx);
        if (!current || current.organizationId !== organizationId) {
          throw new PlatformEnterpriseRequestNotFoundError(id);
        }
        if (moved === 1) return;
        const history = await platformAuditLogRepository.listByActionAndMetadata(
          TRANSITION_ACTION,
          'requestId',
          id,
          tx,
        );
        // This transaction's own row is in `history` too (it was appended first
        // and is rolled back by the throw), so the mover is the latest row that
        // put the request in the state it is actually in.
        const last = history
          .filter((r) => (r.metadata as { to?: unknown } | null)?.to === current.status)
          .at(-1);
        throw new EnterpriseRequestStaleError(
          current.status,
          last ? { userId: last.actorUserId, email: last.actor.email } : null,
        );
      },
    );
  },
};
