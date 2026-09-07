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
// The Job runs and Git rows are asserted PRESENT at both counts, because they
// are workspace-SCOPED but not workspace-NAMED and §6 reveals a tier rather than
// relocating every page beneath it (the card's AC 5).

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

describe('the no-project settings door AT the reveal threshold', () => {
  it('points at the workspace area, exactly as it does on main', () => {
    const { container } = renderRail(true);
    expect(namesTheWorkspaceArea(container.innerHTML)).toBe(true);
  });

  it('keeps the sub-routes here too', () => {
    const { container } = renderRail(true);
    expect(container.innerHTML).toContain('/settings/workspace/jobs');
    expect(container.innerHTML).toContain('/settings/organization/git');
  });
});
