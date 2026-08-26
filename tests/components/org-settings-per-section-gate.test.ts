import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// §6d's PER-SECTION gate, pinned structurally (MOTIR-3519 / MOTIR-3502 ·
// `docs/decisions/organization-tier.md` §6d).
//
// The org Settings home used to refuse the WHOLE PAGE to anyone who was not an
// org owner/admin, and that was correct while it carried org-scoped cards only —
// per-page and per-section were the same rule. §6d's fold-in is what makes them
// differ: below the workspace-tier reveal threshold this page HOSTS the
// workspace's Name / Members / Danger-zone sections, which are gated on
// WORKSPACE MEMBERSHIP. A workspace invitee is a plain org `member`, so the
// whole-page refusal closed the only remaining route to those sections —
// including the only route in the product to **Leave workspace**.
//
// ⚠️ WHY A SOURCE-STRUCTURE GUARD RATHER THAN A RENDER. The page is an async
// Server Component reading cookies and a session, so the cheap deterministic
// assertion available here is about its SHAPE. The BEHAVIOUR is asserted
// end-to-end, where it belongs: `tests/e2e/org-admin.spec.ts` drives a plain org
// member onto this page and reads their workspace's name off the fold-in, and
// `tests/e2e/workspace-flows.spec.ts` has an invitee LEAVE from it. This guard
// exists so that a future edit restoring the early return fails HERE, in
// seconds, rather than in an E2E lane — and so the reason is written next to the
// thing it protects.
//
// It reads the source with comments stripped, the same technique
// `tests/billing/entitlement-read-guard.test.ts` uses on this very file, so the
// prose above cannot satisfy or trip its own rule.

const PAGE = 'app/(authed)/settings/organization/page.tsx';

function code(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the org Settings home gates per SECTION, not per page', () => {
  const src = code(PAGE);

  it('has NO whole-page early return for a non-admin', () => {
    // The exact shape that shipped the defect: `if (!isAdmin) { return ( … ) }`
    // at the top level of the component, before anything else renders.
    expect(
      /if\s*\(\s*!isAdmin\s*\)\s*\{\s*return/.test(src),
      `${PAGE} refuses the whole page to a non-admin again. §6d requires the ` +
        'refusal to apply to the ORG-SCOPED sections only — this page hosts the ' +
        "workspace's sections below the reveal threshold, and they are gated on " +
        'workspace membership, not on the org role. Restoring this early return ' +
        'takes Leave workspace away from every plain org member.',
    ).toBe(false);
  });

  it('still refuses the ORG-SCOPED cards to a non-admin', () => {
    // The other half: per-section must not become no-section. Each org-scoped
    // card is named inside an `isAdmin` branch.
    for (const card of ['OrgGeneralCard', 'BillingCard', 'AcceptanceVideoCard']) {
      expect(src.includes(card), `${card} is no longer rendered by ${PAGE}`).toBe(true);
    }
    expect(
      /\{isAdmin \?\s*\(\s*<>/.test(src),
      'the org-scoped cards are no longer wrapped in an isAdmin branch',
    ).toBe(true);
    expect(
      /\{isAdmin \? <DangerZoneCard \/> : null\}/.test(src),
      'the ORG danger zone is no longer admin-gated',
    ).toBe(true);
  });

  it('renders the workspace fold-in OUTSIDE the admin branch', () => {
    // The load-bearing assertion. If this section ever moves inside the
    // `isAdmin` branch the page compiles, every test that signs in as an owner
    // still passes, and a plain member silently loses their workspace sections
    // again — which is exactly how the first version of this shipped.
    const foldIn = src.indexOf('<WorkspaceFoldInSection');
    expect(foldIn, 'the fold-in is gone from the org settings page').toBeGreaterThan(-1);

    const adminBranch = src.indexOf('{isAdmin ? (');
    const adminBranchEnd = src.indexOf(') : (', adminBranch);
    expect(
      foldIn > adminBranchEnd,
      'WorkspaceFoldInSection moved inside the isAdmin branch — a plain org ' +
        'member would lose the workspace Name / Members / Danger-zone sections, ' +
        'and with them the only route to Leave workspace (§6d).',
    ).toBe(true);
  });
});
