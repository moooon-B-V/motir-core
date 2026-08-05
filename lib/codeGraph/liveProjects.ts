// THE LIVE-PROJECT QUESTION (MOTIR-2197 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5) — the shape motir-ai's
// offboarding backstop (MOTIR-2169) asks, and the shape it gets back.
//
// The vocabulary is in its own module because BOTH sides depend on it and the
// distinction it encodes is the safety property: `live` is a THREE-valued answer,
// not a boolean.

/** One tenant coordinate pair — the identity motir-ai stores a code graph under. */
export interface LiveProjectQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
}

/**
 * The verdict for one pair.
 *
 * ⚠️ **`unknown` is not a nicety, it is the whole point.** The consumer's own
 * acceptance criterion is that a project whose liveness could not be determined is
 * NEVER touched, and that it aborts rather than falling back to "assume gone".
 * That contract is unkeepable if this side collapses "we know it is gone" and "we
 * did not find out" into one boolean — the caller would be deciding with the
 * information already discarded, and the failure mode is deleting a paying
 * tenant's code index through a path working exactly as designed.
 *
 * - `live`    — the project row exists and its workspace exists.
 * - `absent`  — CONFIRMED gone: no project row, or its workspace is gone.
 * - `unknown` — not evaluated. Never treat as `absent`.
 */
export type LiveProjectStatus = 'live' | 'absent' | 'unknown';

export interface LiveProjectVerdict extends LiveProjectQuery {
  status: LiveProjectStatus;
}

export interface LiveProjectsResponse {
  /** One verdict per pair asked about, in the order asked. Never any other project. */
  projects: LiveProjectVerdict[];
}

/**
 * How many pairs one call may ask about.
 *
 * Bounded because the request is attacker-shaped in the abstract — a list the
 * caller controls, turned into a database read — even though the only caller is a
 * trusted service. The backstop pages its own enumeration anyway.
 */
export const LIVE_PROJECTS_MAX_PAIRS = 500;

/** Malformed request body. */
export class LiveProjectsQueryError extends Error {
  readonly code = 'LIVE_PROJECTS_QUERY_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'LiveProjectsQueryError';
  }
}

/**
 * Parse the wire body into pairs, or throw {@link LiveProjectsQueryError}.
 *
 * Strict on shape: a pair missing either id is rejected rather than skipped. A
 * silently dropped pair would come back with no verdict at all, and a caller
 * iterating its own list against a shorter response is exactly how a mismatch
 * becomes a wrong deletion.
 */
export function parseLiveProjectsQuery(body: unknown): LiveProjectQuery[] {
  if (typeof body !== 'object' || body === null) {
    throw new LiveProjectsQueryError('request body must be an object');
  }
  const raw = (body as { projects?: unknown }).projects;
  if (!Array.isArray(raw)) {
    throw new LiveProjectsQueryError("'projects' must be an array");
  }
  if (raw.length > LIVE_PROJECTS_MAX_PAIRS) {
    throw new LiveProjectsQueryError(
      `'projects' may name at most ${LIVE_PROJECTS_MAX_PAIRS} pairs per call`,
    );
  }
  return raw.map((entry, index) => {
    const pair = entry as { coreWorkspaceId?: unknown; coreProjectId?: unknown } | null;
    const workspaceId = pair?.coreWorkspaceId;
    const projectId = pair?.coreProjectId;
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      throw new LiveProjectsQueryError(
        `projects[${index}].coreWorkspaceId must be a non-empty string`,
      );
    }
    if (typeof projectId !== 'string' || projectId === '') {
      throw new LiveProjectsQueryError(
        `projects[${index}].coreProjectId must be a non-empty string`,
      );
    }
    return { coreWorkspaceId: workspaceId, coreProjectId: projectId };
  });
}
