// THE CONNECTED-REPOSITORY QUESTION (MOTIR-9137) — the shape motir-ai's
// code-graph reconciler asks to find a graph whose REPOSITORY is gone while its
// organisation is still here, and the shape it gets back.
//
// A graph is keyed by `(organisation, owner/name)`. `live-organizations` answers
// for the first half only, so a graph whose repository was renamed, transferred
// or re-owned by an org rename — and never "disconnected" — stayed live for ever:
// its organisation is live, and nothing ever asked about its `owner/name`. This
// read is that question.
//
// ⚠️ THE REQUEST IS `live-organizations`' BODY, UNCHANGED, and so is its parser.
// The consumer asks about the same organisations it already holds, and two
// parsers for one body drift the moment one of them tightens.

import type { LiveProjectStatus } from '@/lib/codeGraph/liveProjects';
import type { LiveOrganizationQuery } from '@/lib/codeGraph/liveOrganizations';

export {
  LIVE_ORGANIZATIONS_MAX_IDS as LIVE_ORGANIZATION_REPOS_MAX_IDS,
  LiveOrganizationsQueryError as LiveOrganizationReposQueryError,
  parseLiveOrganizationsQuery as parseLiveOrganizationReposQuery,
} from '@/lib/codeGraph/liveOrganizations';

/**
 * One organisation's verdict, with its connected repositories.
 *
 * - `live`    — the organisation row exists, and `repoRefs` is EVERY repository
 *               connected to it (`owner/name`, any provider). An empty list is a
 *               real answer: a live organisation with nothing connected.
 * - `absent`  — CONFIRMED gone. `repoRefs` is empty and means nothing; the
 *               organisation-tier eye owns this case.
 * - `unknown` — not evaluated. Never treat as `absent`, and never read its
 *               `repoRefs`.
 */
export interface LiveOrganizationReposVerdict extends LiveOrganizationQuery {
  status: LiveProjectStatus;
  repoRefs: string[];
}

export interface LiveOrganizationReposResponse {
  /** One verdict per organisation asked about, in the order asked. Never any other. */
  organizations: LiveOrganizationReposVerdict[];
}
