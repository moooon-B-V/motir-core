import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_PLANNING_REQUIREMENT,
  PROJECT_NAV_ACCESS,
  canOfferNavDestination,
  satisfiesRequirement,
} from '@/lib/settings/projectNavAccess';
import { isPermissionKey } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { toSettingsNavPermissions } from '@/lib/settings/projectSettingsNav';

// Subtask MOTIR-2471 — ONE MAP, CONSUMED TWICE.
//
// If the settings door disappears for a member and the rest of the shell keeps
// offering rooms that turn them away, the product has not become honest — it has
// become inconsistent, which is harder to read than either extreme.
//
// The map is the design, not a convenience. Two independent conditions (one
// beside each sidebar row, one beside each palette entry) would work on the day
// they shipped and would drift, because the two surfaces are edited by different
// people for different reasons and nothing makes them compare notes. So the
// TOTALITY assertions below are the load-bearing ones: they read both surfaces'
// sources and fail if either offers an href the map does not carry.

const SIDEBAR = readFileSync(
  join(process.cwd(), 'app/(authed)/_components/SidebarNav.tsx'),
  'utf8',
);
const PALETTE = readFileSync(
  join(process.cwd(), 'app/(authed)/_components/AppCommandPalette.tsx'),
  'utf8',
);

const ADMIN = BUILTIN_ROLE_PERMISSIONS.admin;
const MEMBER = BUILTIN_ROLE_PERMISSIONS.member;
const VIEWER = BUILTIN_ROLE_PERMISSIONS.viewer;

describe('the nav-permission map', () => {
  it('names only real catalog keys, or the explicit browse-only marker', () => {
    for (const entry of PROJECT_NAV_ACCESS) {
      const ok = entry.requires === 'browse-only' || isPermissionKey(entry.requires);
      expect(ok, `${entry.href}: ${entry.requires}`).toBe(true);
    }
    expect(satisfiesRequirement(AI_PLANNING_REQUIREMENT, ADMIN)).toBe(true);
  });

  it('carries EVIDENCE for every entry — browse-only is a finding too', () => {
    // `browse-only` is a real answer, not a gap; what makes it an answer rather
    // than an omission is that someone opened the destination and wrote down
    // what they found. An entry with no evidence is an entry nobody checked.
    for (const entry of PROJECT_NAV_ACCESS) {
      expect(entry.evidence.length, `${entry.href} has no evidence`).toBeGreaterThan(30);
    }
  });

  it('has no duplicate hrefs', () => {
    const hrefs = PROJECT_NAV_ACCESS.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('answers FALSE for an href it does not carry — the safe failure direction', () => {
    expect(canOfferNavDestination('/not-a-route', ADMIN)).toBe(false);
  });
});

describe('the map is TOTAL over both surfaces', () => {
  // A row added later must not ship ungated by omission. These read the sources
  // rather than the rendered output so the assertion covers rows behind a
  // condition (`aiPlanningConfigured`, `canResume`) that a render might not hit.
  const hrefsIn = (source: string): string[] => {
    const region = source.slice(source.indexOf('primaryItems'), source.indexOf('rail-foot') + 1);
    return [...(region || source).matchAll(/href: '(\/[a-z0-9-]+)'/g)].map((m) => m[1]!);
  };

  it('every project-nav row the sidebar renders resolves to a map entry', () => {
    const known = new Set(PROJECT_NAV_ACCESS.map((e) => e.href));
    // The onboarding resume row is deliberately outside the map — it is gated on
    // there BEING a session of the actor's own, which is a state, not a permission.
    //
    // Docs and Legal documents no longer render from this file at all
    // (MOTIR-4239 moved both into the Help menu), so `hrefsIn(SIDEBAR)` never
    // sees either — there is nothing left here to exempt.
    const exempt = new Set(['/onboarding', '/settings/project', '/settings/workspace']);
    for (const href of hrefsIn(SIDEBAR)) {
      if (exempt.has(href) || href.startsWith('/settings/')) continue;
      expect(known.has(href), `SidebarNav offers ${href}, which the map does not carry`).toBe(true);
    }
  });

  it('the exempt PUBLIC rows sit in the UNGATED footer group, not the gated primary one', () => {
    // The exemption above is only sound while the row is outside the gate. Move
    // it into `primaryItems` and `canOfferNavDestination` answers false for an
    // href the map does not carry — the row would vanish for EVERY actor. That
    // is the right failure direction for a project surface and exactly the wrong
    // one for public documentation, so pin the section rather than trusting the
    // exemption to stay true.
    //
    // ⚠️ DOCS AND LEGAL NO LONGER RENDER FROM THIS FILE AT ALL (MOTIR-4239) —
    // both left the footer group for the Help menu, and their own coverage
    // (the configured/absent arms, the off-shell no-`active` shape) lives in
    // `tests/components/HelpMenu.test.tsx` now. What is still pinned here is
    // that neither came BACK as a literal in `SidebarNav.tsx`'s rail rows.
    const bottom = SIDEBAR.indexOf("id: 'bottom'");
    expect(bottom, 'the footer section marker moved — re-check the public rows').toBeGreaterThan(
      -1,
    );
    expect(SIDEBAR, 'a literal app-relative docs path is back in the rail').not.toContain(
      "href: '/docs'",
    );
    expect(SIDEBAR, 'a docs row is back in the rail — it belongs in the Help menu').not.toContain(
      'href: docsIndexUrl',
    );
    expect(SIDEBAR, 'a legal row is back in the rail — it belongs in the Help menu').not.toContain(
      'href: legalIndexUrl',
    );
  });

  it('every palette navigation goes through offerNav or an explicit requirement', () => {
    // The structural half: a `go('/x')` that is not wrapped is a leak, and it is
    // the shape a reviewer skims past.
    const gos = [...PALETTE.matchAll(/onSelect: \(\) => go\('(\/[a-z0-9-]+)'\)/g)].map(
      (m) => m[1]!,
    );
    const known = new Set(PROJECT_NAV_ACCESS.map((e) => e.href));
    for (const href of gos) {
      if (href.startsWith('/settings/') || href === '/onboarding') continue;
      expect(known.has(href), `the palette offers ${href}, which the map does not carry`).toBe(
        true,
      );
      expect(PALETTE, `${href} is pushed without offerNav`).toContain(`offerNav('${href}'`);
    }
  });

  it('neither surface holds a SECOND gating list', () => {
    // Both resolve through the shared map; nothing else decides a nav row.
    expect(SIDEBAR).toContain('canOfferNavDestination(item.href, held)');
    expect(PALETTE).toContain('canOfferNavDestination(href, held)');
  });
});

describe('what each built-in role is offered', () => {
  const offered = (
    held: ReadonlySet<(typeof PROJECT_NAV_ACCESS)[number]['requires']> | Set<never>,
  ) =>
    PROJECT_NAV_ACCESS.filter((e) => canOfferNavDestination(e.href, held as never)).map(
      (e) => e.href,
    );

  it('an ADMIN is offered every destination — nothing was taken away', () => {
    expect(offered(ADMIN as never)).toEqual(PROJECT_NAV_ACCESS.map((e) => e.href));
  });

  it('a MEMBER loses exactly ONE row — Code health, which asserts `ai:configure`', () => {
    // Worth stating plainly, because it is the only place this story narrows the
    // nav for a member and it was NOT obvious from the row's name. `/code-health`
    // reads through `aiConventionService`, whose own comments record that mapping
    // those operations to `ai:plan` (which a member holds) would have WIDENED an
    // admin-only operation — so `ai:configure` it is, and a member never held it.
    // The page already refused them; the row just stops offering the trip.
    const gone = PROJECT_NAV_ACCESS.map((e) => e.href).filter(
      (href) => !offered(MEMBER as never).includes(href),
    );
    expect(gone).toEqual(['/code-health']);
  });

  it('a VIEWER loses exactly the three destinations that refuse them outright', () => {
    const gone = PROJECT_NAV_ACCESS.map((e) => e.href).filter(
      (href) => !offered(VIEWER as never).includes(href),
    );
    expect(gone.sort()).toEqual(['/code-health', '/plans', '/triage']);
  });

  it('a viewer keeps every READ surface', () => {
    for (const href of [
      '/dashboard',
      '/items',
      '/ready',
      '/boards',
      '/roadmap',
      '/backlog',
      '/reports',
      '/filters',
    ]) {
      expect(canOfferNavDestination(href, VIEWER), href).toBe(true);
    }
  });

  it('the AI entrances need `ai:plan` — a viewer is not offered them', () => {
    expect(satisfiesRequirement(AI_PLANNING_REQUIREMENT, MEMBER)).toBe(true);
    expect(satisfiesRequirement(AI_PLANNING_REQUIREMENT, VIEWER)).toBe(false);
  });

  it('an actor holding NOTHING still keeps the browse-only rows', () => {
    // The primary nav can never render empty for someone who reached this shell:
    // every actor here holds `project:browse`, and the browse-only rows follow it.
    const none = toSettingsNavPermissions([]);
    expect(offered(none as never).length).toBeGreaterThan(0);
  });
});

describe('the DISABLE family is untouched (treatment-table rows 6–8)', () => {
  it('the palette Create action is still offered — it is disabled in place, never hidden', () => {
    // The 2026-08-08 amendment widened the HIDDEN set for entry points and
    // explicitly left the in-place disabled set alone. Create is row 8.
    expect(PALETTE).toContain("id: 'create-issue'");
    expect(PALETTE, 'Create was routed through the nav gate — it should not be').not.toContain(
      "offerNav('/create'",
    );
  });
});
