import { describe, expect, it } from 'vitest';

import {
  LIVE_ORGANIZATIONS_MAX_IDS,
  parseLiveOrganizationsQuery,
  LiveOrganizationsQueryError,
} from '@/lib/codeGraph/liveOrganizations';
import { LIVE_PROJECTS_MAX_PAIRS, parseLiveProjectsQuery } from '@/lib/codeGraph/liveProjects';

// THE STORY'S motir-core GATE — the CONTRACT-PARITY half (MOTIR-4664 · MOTIR-4647
// · Story MOTIR-4642).
//
// ⚠️ THIS FILE ASSERTS ONE THING, AND THE REST OF THE GATE IS A MANIFEST. That is
// deliberate: MOTIR-4664 was RE-SCOPED on 2026-09-05, and its own body says why —
// "two gates asserting one seam is two suites that can disagree about it." Three of
// its original seams moved to MOTIR-4669, and the rest are already asserted by the
// cards that built them. Re-deriving those here would produce exactly the
// duplication the re-scope was written to prevent.
//
// Where each seam this card KEEPS is actually asserted:
//
//   the fan-out is gone, ONE container, FIXED count (MOTIR-4652)
//     → tests/jobs/code-graph-index-fan-out-retired.test.ts
//       "an organisation with THREE projects boots exactly ONE container"
//       — a fixed number, never a ratio: "fewer containers than projects" would
//       pass on a fan-out merely narrowed, and keep passing if it widened to two.
//
//   resolveCodeContext returns the PROJECT's set (MOTIR-4653)
//     → tests/ai/codeContext.test.ts
//       "resolves the PROJECT's configured set — not every repo the workspace granted"
//       "gives two projects of ONE workspace their own sets, and only their own"
//
//   a project with an EMPTY set produces an envelope with NO `context.code` key
//     → tests/ai/codeContext.test.ts
//       "OMITS context.code entirely when the project's SET is empty, though the
//        workspace granted four" — asserted on the SERIALIZED ENVELOPE, because a
//       `code` key carrying an empty `repos[]` would satisfy every null check and
//       still break the promise: motir-ai would read it as "asked and answered:
//       none" rather than as "not asked".
//
//   POST /api/internal/ai/live-organizations (MOTIR-4647)
//     → tests/api/live-organizations-route.test.ts — 15 cases, including the auth
//       arms, the fail-closed-on-unset-secret arm, order preservation, and the
//       ⚠️ ZERO-workspaces-ZERO-projects organisation reported LIVE.
//
// What is NOT here, and must not be added: the two-projects-one-repository seam,
// the four attribution call sites, and the org read arm under `motir_app`. All
// three belong to MOTIR-4669's gate.

describe('⚠️ the two liveness reads are ONE contract in two coordinates', () => {
  // The reconciler switches on the SAME three-valued verdict for both reads, and
  // the danger is not that they differ — it is that they drift APART later, one
  // gaining a bound or a status the other does not. `liveOrganizations` imports
  // its vocabulary from `liveProjects` by name rather than restating it; these
  // assertions are what make that import load-bearing instead of stylistic.

  it('shares ONE batch bound — the organisation read does not restate it', () => {
    // Imported, not copied. A second literal would let one side be raised in
    // isolation, and the bound exists because a caller-controlled list becomes a
    // database read: raising it on one coordinate only would widen exactly half
    // of the exposure while looking symmetrical in review.
    expect(LIVE_ORGANIZATIONS_MAX_IDS).toBe(LIVE_PROJECTS_MAX_PAIRS);
  });

  it('both refuse a malformed body rather than skipping the bad entry', () => {
    // The property that makes a SHORT answer impossible. Both reads promise one
    // verdict per thing asked about; silently dropping an unparseable entry would
    // return fewer verdicts than coordinates, and the consumer treats a missing
    // verdict as "not established" only because it can COUNT them. A parser that
    // skipped would make that count lie.
    expect(() => parseLiveOrganizationsQuery({ organizations: [{}] })).toThrow(
      LiveOrganizationsQueryError,
    );
    expect(() =>
      parseLiveOrganizationsQuery({ organizations: [{ coreOrganizationId: '' }] }),
    ).toThrow(LiveOrganizationsQueryError);
    expect(() => parseLiveProjectsQuery({ projects: [{}] })).toThrow();
  });

  it('both accept an EMPTY list as an empty answer, not an error', () => {
    // A sweep with nothing to ask about is the steady state on a quiet tenant,
    // and it must not be a 400 on either coordinate.
    expect(parseLiveOrganizationsQuery({ organizations: [] })).toEqual([]);
    expect(parseLiveProjectsQuery({ projects: [] })).toEqual([]);
  });

  it('⚠️ the ORGANISATION read takes ONE id where the project read takes a PAIR', () => {
    // The one place the two SHOULD differ, asserted so the parity above is not
    // mistaken for sameness. A project is only meaningful inside a workspace; an
    // organisation is the root tier and has nothing above it to be paired with.
    // A future "tidy-up" that gave the organisation read a workspace id for
    // symmetry would be adding a coordinate that cannot constrain anything.
    const orgs = parseLiveOrganizationsQuery({
      organizations: [{ coreOrganizationId: 'org_1' }],
    });
    expect(orgs).toEqual([{ coreOrganizationId: 'org_1' }]);
    expect(Object.keys(orgs[0]!)).toEqual(['coreOrganizationId']);

    const projects = parseLiveProjectsQuery({
      projects: [{ coreWorkspaceId: 'w_1', coreProjectId: 'p_1' }],
    });
    expect(Object.keys(projects[0]!).sort()).toEqual(['coreProjectId', 'coreWorkspaceId']);
  });
});
