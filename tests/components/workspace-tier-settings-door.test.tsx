// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

// The NO-PROJECT settings door, at both sides of the reveal threshold
// (MOTIR-3502 · `docs/decisions/organization-tier.md` §6d).
//
// ⚠️ THE DOOR IS RE-POINTED, NOT REMOVED, and that is the deliberate reading of
// "hidden at ≤ 1". §6d does not abolish settings below the threshold — it says
// the workspace-config sections FOLD IN to a single Settings home. With no
// active project this row is the rail's only settings entry, so deleting it
// would leave that user with no door at all, which is a regression the rule does
// not ask for. What the rule forbids is NAMING the hidden tier, and the
// re-pointed row does not: it targets `/settings/organization`, the page that
// hosts the folded-in sections.
//
// ⚠️ MOTIR-3502's AC 5 IS RETIRED (Story MOTIR-4843 · MOTIR-4847). This comment
// used to read: "The Job runs and Git rows are asserted PRESENT at both counts,
// because they are workspace-SCOPED but not workspace-NAMED and §6 reveals a
// tier rather than relocating every page beneath it." Both of those rows have
// LEFT this section — `Security` and `Job runs` with this card, `Git` a tier
// earlier (MOTIR-4680) — so the claim is now about what the section does NOT
// carry. §6d is satisfied by RELOCATION rather than by exemption: below the
// reveal both capabilities are reached by scrolling `/settings/organization`,
// where `WorkspaceFoldInSection` and `JobRunsFoldInSection` host them.
//
// The door itself is unchanged and still re-pointed rather than removed, which
// is what the two describes below are for.

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => false,
}));
vi.mock('@/lib/hooks/useSidebarCollapsed', () => ({
  useSidebarCollapsed: () => [false, vi.fn()],
}));

afterEach(cleanup);

const user = { name: 'Ada', email: 'ada@example.com' };

function renderRail(workspaceTierRevealed: boolean) {
  return renderWithIntl(
    <SidebarNav
      activeProject={null}
      variant="rail"
      user={user}
      workspaceTierRevealed={workspaceTierRevealed}
    />,
  );
}

/** The area's OWN href — a sub-route href does not match. */
function namesTheWorkspaceArea(html: string): boolean {
  return html.includes('href="/settings/workspace"');
}

describe('the no-project settings door BELOW the reveal threshold', () => {
  it('names no /settings/workspace area anywhere in its markup', () => {
    const { container } = renderRail(false);
    expect(namesTheWorkspaceArea(container.innerHTML)).toBe(false);
  });

  it('points at the org settings home, which HOSTS the folded-in sections', () => {
    const { container } = renderRail(false);
    expect(container.innerHTML).toContain('href="/settings/organization"');
  });

  it('is the DEFAULT — omitting the prop points at the home that exists at every count', () => {
    const { container } = renderWithIntl(
      <SidebarNav activeProject={null} variant="rail" user={user} />,
    );
    expect(namesTheWorkspaceArea(container.innerHTML)).toBe(false);
    expect(container.innerHTML).toContain('href="/settings/organization"');
  });

  it('⚠️ names NO workspace sub-route either — the exemption is gone (MOTIR-4847)', () => {
    // AMENDED, and its assertion INVERTED. This case used to assert
    // `/settings/workspace/jobs` PRESENT here, on the §6 "reveals a tier rather
    // than relocating every page" reading. That reading was the defect: a
    // workspace-tier surface answering 200 below the reveal, advertised from the
    // PROJECT's rail, is what MOTIR-4861's fold-in and this card together
    // repair. Below the threshold nothing in this rail names the workspace tier
    // at all — not the area, not one of its rooms.
    const { container } = renderRail(false);
    expect(container.innerHTML).not.toContain('/settings/workspace');
  });

  it("keeps the Git row, which is organisation-scoped and not this rule's business", () => {
    // ⚠️ GIT NOW NAMES THE ORGANISATION (Story MOTIR-4669 · MOTIR-4680), and
    // that is a TIER move, not the §6 fold this file is about. It is present at
    // both counts because an organisation always exists — which is exactly why
    // it is NOT evidence for the exemption the case above retired.
    const { container } = renderRail(false);
    // ⚠️ NEITHER SUB-ROUTE IS HERE (MOTIR-4847 took `Job runs`, MOTIR-4643 took
    // `Git`). Both are asserted ABSENT rather than the case being dropped: what
    // it holds is that this section names the AREA and nothing beneath it.
    expect(container.innerHTML).not.toContain('/settings/workspace/jobs');
    expect(container.innerHTML).not.toContain('/settings/organization/git');
  });
});

describe('the no-project settings door AT the reveal threshold', () => {
  it('points at the workspace area, exactly as it does on main', () => {
    const { container } = renderRail(true);
    expect(namesTheWorkspaceArea(container.innerHTML)).toBe(true);
  });

  it("names the area and NOTHING BENEATH IT — the sub-routes are the area rail's now", () => {
    // The other half of the inversion above (MOTIR-4847). Above the reveal the
    // door is here and its two rooms are rows in the workspace area's OWN rail
    // (`lib/settings/workspaceSettingsNav.ts`), reached through it — so this
    // section names the area's href and neither sub-route, at this count too.
    const { container } = renderRail(true);
    // ⚠️ NEITHER SUB-ROUTE IS HERE (MOTIR-4847 took `Job runs`, MOTIR-4643 took
    // `Git`). Both are asserted ABSENT rather than the case being dropped: what
    // it holds is that this section names the AREA and nothing beneath it.
    expect(container.innerHTML).not.toContain('/settings/workspace/jobs');
    expect(container.innerHTML).not.toContain('/settings/organization/git');
  });
});
