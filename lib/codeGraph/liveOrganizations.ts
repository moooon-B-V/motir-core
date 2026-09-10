// THE LIVE-ORGANISATION QUESTION (MOTIR-4647 · MOTIR-4642) — the shape
// motir-ai's code-graph reconciler asks once the graph is keyed to the
// ORGANISATION rather than to a `(workspace, project)` pair, and the shape it
// gets back.
//
// ⚠️ THE VOCABULARY IS `liveProjects`', IMPORTED RATHER THAN RESTATED. The
// consumer switches on the same three-valued verdict for both reads, and two
// copies of a three-member union drift the moment one of them gains a member.
// So the status type and the batch bound come from that module by name; only
// the COORDINATE differs, which is the whole point of this file existing.

import { LIVE_PROJECTS_MAX_PAIRS, type LiveProjectStatus } from '@/lib/codeGraph/liveProjects';

/**
 * One tenant coordinate — the identity motir-ai stores an org-keyed code graph
 * under.
 *
 * ⚠️ ONE id, not a pair, and that is the substantive difference from
 * {@link LiveProjectQuery}. The project read carries a workspace id because a
 * project is only meaningful inside one; an organisation is the root tier and
 * has nothing above it to be paired with.
 */
export interface LiveOrganizationQuery {
  coreOrganizationId: string;
}

/**
 * The verdict for one organisation — {@link LiveProjectStatus}, unchanged.
 *
 * - `live`    — the organisation row exists.
 * - `absent`  — CONFIRMED gone: no organisation row.
 * - `unknown` — not evaluated. Never treat as `absent`.
 */
export interface LiveOrganizationVerdict extends LiveOrganizationQuery {
  status: LiveProjectStatus;
}

export interface LiveOrganizationsResponse {
  /** One verdict per organisation asked about, in the order asked. Never any other. */
  organizations: LiveOrganizationVerdict[];
}

/**
 * How many organisations one call may ask about — the same bound the project
 * read takes, for the same reason (a caller-controlled list turned into a
 * database read), and imported so the two cannot diverge.
 */
export const LIVE_ORGANIZATIONS_MAX_IDS = LIVE_PROJECTS_MAX_PAIRS;

/** Malformed request body. */
export class LiveOrganizationsQueryError extends Error {
  readonly code = 'LIVE_ORGANIZATIONS_QUERY_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'LiveOrganizationsQueryError';
  }
}

/**
 * Parse the wire body into organisation coordinates, or throw
 * {@link LiveOrganizationsQueryError}.
 *
 * Strict on shape: an entry missing its id is rejected rather than skipped. A
 * silently dropped entry would come back with no verdict at all, and a caller
 * zipping its own list against a shorter response is exactly how a mismatch
 * becomes a wrong deletion.
 */
export function parseLiveOrganizationsQuery(body: unknown): LiveOrganizationQuery[] {
  if (typeof body !== 'object' || body === null) {
    throw new LiveOrganizationsQueryError('request body must be an object');
  }
  const raw = (body as { organizations?: unknown }).organizations;
  if (!Array.isArray(raw)) {
    throw new LiveOrganizationsQueryError("'organizations' must be an array");
  }
  if (raw.length > LIVE_ORGANIZATIONS_MAX_IDS) {
    throw new LiveOrganizationsQueryError(
      `'organizations' may name at most ${LIVE_ORGANIZATIONS_MAX_IDS} organisations per call`,
    );
  }
  return raw.map((entry, index) => {
    const organizationId = (entry as { coreOrganizationId?: unknown } | null)?.coreOrganizationId;
    if (typeof organizationId !== 'string' || organizationId === '') {
      throw new LiveOrganizationsQueryError(
        `organizations[${index}].coreOrganizationId must be a non-empty string`,
      );
    }
    return { coreOrganizationId: organizationId };
  });
}
