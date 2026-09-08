// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

// The workspace-tier settings SUB-ROUTES, at both sides of the reveal threshold
// (MOTIR-3502 · `docs/decisions/organization-tier.md` §6d).
//
// ⚠️ THIS FILE WAS ABOUT THE **NO-PROJECT** SETTINGS DOOR, AND THAT DOOR IS GONE
// (MOTIR-4873). Its premise was: "with no active project this row is the rail's
// only settings entry, so deleting it would leave that user with no door at
// all" — so the row was RE-POINTED at `/settings/organization` (below the
// threshold) or `/settings/workspace` (at it) rather than removed.
//
// Every member is inside a project now (MOTIR-4870), so the row always
// deep-links to project settings and there is no reader for the re-pointed
// arm. The three cases that asserted its href are removed below, each in place.
//
// WHAT SURVIVES IS THE CLAIM §6d IS ACTUALLY ABOUT: the Job runs and Git rows
// are PRESENT at both counts, because they are workspace-SCOPED but not
// workspace-NAMED and §6 reveals a tier rather than relocating every page
// beneath it (the card's AC 5). That is asserted here still, and it is why this
// file is trimmed rather than deleted.

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

describe('the workspace-tier sub-routes BELOW the reveal threshold', () => {
  it('names no /settings/workspace area anywhere in its markup', () => {
    const { container } = renderRail(false);
    expect(namesTheWorkspaceArea(container.innerHTML)).toBe(false);
  });

  // ⚠️ REMOVED (MOTIR-4873): 'points at the org settings home, which HOSTS the
  // folded-in sections', and 'is the DEFAULT — omitting the prop points at the
  // home that exists at every count'. Both asserted the href of the
  // no-project settings door, which no longer has a reader.

  it('keeps the sub-routes beside it — §6 relocates neither', () => {
    // ⚠️ GIT NOW NAMES THE ORGANISATION (Story MOTIR-4669 · MOTIR-4680), and
    // that is a TIER move, not the §6 fold this file is about. Job runs is still
    // workspace-scoped and still points at the workspace route; Git is
    // organisation-scoped now and points at its own. Both rows are present at
    // both counts, which is the claim — the gate is on Security, not on its
    // neighbours.
    const { container } = renderRail(false);
    expect(container.innerHTML).toContain('/settings/workspace/jobs');
    expect(container.innerHTML).toContain('/settings/organization/git');
  });
});

describe('the workspace-tier sub-routes AT the reveal threshold', () => {
  // ⚠️ REMOVED (MOTIR-4873): 'points at the workspace area, exactly as it does
  // on main' — the third and last assertion about the no-project door's href.

  it('keeps the sub-routes here too', () => {
    const { container } = renderRail(true);
    expect(container.innerHTML).toContain('/settings/workspace/jobs');
    expect(container.innerHTML).toContain('/settings/organization/git');
  });
});
