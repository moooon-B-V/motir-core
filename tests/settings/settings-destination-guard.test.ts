import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_SETTINGS_NAV,
  PROJECT_SETTINGS_ROOT,
  visibleSettingsNav,
  toSettingsNavPermissions,
} from '@/lib/settings/projectSettingsNav';
import { PERMISSIONS } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { resolveSettingsRefusal } from '@/app/(authed)/settings/project/_guard';

// Subtask MOTIR-2469 — HIDING IS PRESENTATION AND NEVER PROTECTION.
//
// Once MOTIR-2468's rail stops offering a settings entry, the page behind it is
// still one typed URL, one bookmark and one old link away. The failure mode this
// story has to avoid is an interface that quietly stops offering a page behind
// which the page still works: that would LOOK governed without being it, and the
// first person to find out would find out by accident.
//
// So this guard ENUMERATES THE FILESYSTEM rather than counting pages — the
// technique the shipped route↔registry test already uses (mistake #29). A
// settings page added next year is covered the moment it lands, and the
// assertion needs no number kept up to date to stay true.

const SETTINGS_DIR = join(process.cwd(), 'app/(authed)/settings/project');

/** Every on-disk `settings/project/**​/page.tsx`, as [urlPath, absolute file]. */
function collectPages(dir: string, base: string): [string, string][] {
  const found: [string, string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_')) continue; // Next ignores `_`-prefixed folders
      found.push(...collectPages(join(dir, entry.name), `${base}/${entry.name}`));
    } else if (entry.name === 'page.tsx') {
      found.push([base, join(dir, entry.name)]);
    }
  }
  return found;
}

const PAGES = collectPages(SETTINGS_DIR, PROJECT_SETTINGS_ROOT);

describe('every settings destination is guarded (MOTIR-2469)', () => {
  it('found the settings pages at all — the enumeration is not vacuously empty', () => {
    // A guard that silently walks an empty tree passes forever. This is the
    // tripwire for a moved directory or a renamed route group.
    expect(PAGES.length).toBeGreaterThanOrEqual(PROJECT_SETTINGS_NAV.length);
  });

  it.each(PAGES)('%s calls the shared destination guard', (_urlPath, file) => {
    const source = readFileSync(file, 'utf8');
    expect(source, `${file} does not import guardSettingsPage`).toMatch(
      /import \{ guardSettingsPage \} from '\.{1,2}(\/\.\.)*\/_guard';/,
    );
    // Called AND its refusal returned — importing it and ignoring the answer is
    // the shape that would pass a weaker assertion while shipping unguarded.
    expect(source, `${file} does not call guardSettingsPage`).toContain('await guardSettingsPage(');
    expect(source, `${file} does not RETURN the refusal`).toContain('if (refused) return refused;');
  });

  it.each(PAGES)('%s names a real registry entry, and declares no key of its own', (_p, file) => {
    const source = readFileSync(file, 'utf8');
    const called = source.match(/await guardSettingsPage\('([^']+)'/);
    expect(called, `${file}: could not read the guarded entry id`).toBeTruthy();
    const id = called![1]!;
    expect(
      PROJECT_SETTINGS_NAV.some((e) => e.id === id),
      `${file} guards on "${id}", which is not a registry entry`,
    ).toBe(true);
    // The key belongs to the registry. A second copy here is how a row hides on
    // one permission while its page refuses on another — invisible in review,
    // because everything renders and everything refuses.
    for (const key of PERMISSIONS) {
      expect(source, `${file} hardcodes the permission key '${key}'`).not.toContain(`'${key}'`);
    }
  });

  it('the drill-down inherits its parent entry’s key', () => {
    const detail = PAGES.find(([p]) => p.includes('[roleKey]'));
    expect(detail, 'the roles drill-down is missing').toBeTruthy();
    const source = readFileSync(detail![1], 'utf8');
    expect(source).toContain("await guardSettingsPage('roles'");
    // …and the registry agrees that is where it hangs.
    const roles = PROJECT_SETTINGS_NAV.find((e) => e.id === 'roles')!;
    expect(roles.nestedRoutes).toContain('/settings/project/roles/[roleKey]');
  });

  it('every REGISTRY entry has a guarded page, and vice versa', () => {
    // Both directions: a page nothing routes to, and a rail row with no page,
    // are each a way for the guard to look total while missing a destination.
    const guarded = new Set(
      PAGES.map(
        ([, f]) => readFileSync(f, 'utf8').match(/await guardSettingsPage\('([^']+)'/)?.[1],
      ),
    );
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(guarded.has(entry.id), `no guarded page for registry entry "${entry.id}"`).toBe(true);
    }
  });
});

describe('the refusal copy, per destination (design panel 3)', () => {
  const en = JSON.parse(readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(join(process.cwd(), 'messages/zh.json'), 'utf8'));

  it('every entry has its OWN description — not one apology reused twelve times', () => {
    const copy = en.settings.noAccess.section as Record<string, string>;
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(copy[entry.id], `no refusal copy for "${entry.id}"`).toBeTruthy();
    }
    const bodies = PROJECT_SETTINGS_NAV.map((e) => copy[e.id]);
    expect(new Set(bodies).size, 'two destinations share a description').toBe(bodies.length);
  });

  it('every en key has its zh twin', () => {
    expect(zh.settings.noAccess.title).toBeTruthy();
    const zhCopy = zh.settings.noAccess.section as Record<string, string>;
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(zhCopy[entry.id], `no zh twin for "${entry.id}"`).toBeTruthy();
    }
  });

  it('the superseded automation-only copy is gone from BOTH catalogs', () => {
    // It moved into the uniform namespace with the exemplar it came from; two
    // live copies is how the strings drift apart.
    expect(en.settings.automation?.noAccess).toBeUndefined();
    expect(zh.settings.automation?.noAccess).toBeUndefined();
  });
});

describe('the back action never lands on a second refusal', () => {
  // The guard sends the reader to the FIRST entry their own rail offers, not to
  // Details — Details is gated on `project:administer` now, so a hard-wired back
  // link would bounce a board-only actor straight into another refusal.
  it('an actor holding one non-Details domain is sent to a page they CAN open', () => {
    const held = toSettingsNavPermissions(['project:browse', 'board:configure']);
    const [first] = visibleSettingsNav(held);
    expect(first?.id).toBe('board');
    expect(first?.href).not.toBe(PROJECT_SETTINGS_ROOT);
  });

  it('an actor holding NOTHING in the area has no in-area destination to be sent to', () => {
    // …which is why the guard falls back out of the area entirely for them.
    expect(visibleSettingsNav(BUILTIN_ROLE_PERMISSIONS.member)).toEqual([]);
  });

  it('an admin is sent to Details, the shipped behaviour', () => {
    const [first] = visibleSettingsNav(BUILTIN_ROLE_PERMISSIONS.admin);
    expect(first?.href).toBe(PROJECT_SETTINGS_ROOT);
  });
});

describe('the refusal DECISION, over every destination × role (MOTIR-2469)', () => {
  // `resolveSettingsRefusal` is the guard with the IO and the JSX taken out, so
  // the whole matrix is assertable without a database. The resolution half — that
  // a seeded role really produces this set — is proven against real Postgres in
  // `tests/settings/settings-area-access-matrix.test.ts`.
  const ROLES = {
    admin: BUILTIN_ROLE_PERMISSIONS.admin,
    member: BUILTIN_ROLE_PERMISSIONS.member,
    viewer: BUILTIN_ROLE_PERMISSIONS.viewer,
  } as const;

  for (const [role, held] of Object.entries(ROLES)) {
    it.each(PROJECT_SETTINGS_NAV.map((e) => [e.id, e] as const))(
      `${role} on %s — the decision follows the entry's own key`,
      (_id, entry) => {
        const refusal = resolveSettingsRefusal(entry.id, held);
        // The invariant, stated once: refused EXACTLY when the key is absent.
        // Not "usually", and never on a different key than the rail hid it on.
        expect(refusal === null).toBe(held.has(entry.permission));
      },
    );
  }

  it('an ADMIN is refused nothing', () => {
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(resolveSettingsRefusal(entry.id, BUILTIN_ROLE_PERMISSIONS.admin)).toBeNull();
    }
  });

  it('a MEMBER is refused everything, each with its OWN copy key', () => {
    const keys = PROJECT_SETTINGS_NAV.map(
      (entry) => resolveSettingsRefusal(entry.id, BUILTIN_ROLE_PERMISSIONS.member)!.descriptionKey,
    );
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size, 'two destinations share a copy key').toBe(keys.length);
  });

  it('the back action of a PARTIAL role points at a page that role can open', () => {
    // The trap this exists to prevent: a back button that lands on a second
    // refusal. `Details` is gated now, so it cannot be the hard-wired answer.
    const held = toSettingsNavPermissions(['project:browse', 'board:configure']);
    const refusal = resolveSettingsRefusal('members', held)!;
    expect(refusal.backHref).toBe('/settings/project/board');
    expect(resolveSettingsRefusal('board', held)).toBeNull();
  });

  it('the back action leaves the AREA when the actor holds nothing in it', () => {
    const refusal = resolveSettingsRefusal('members', BUILTIN_ROLE_PERMISSIONS.member)!;
    expect(refusal.backHref).toBe('/dashboard');
    expect(refusal.backLabelKey).toBeNull();
  });

  it('throws loudly on an id the registry does not carry', () => {
    // Unreachable through the typed id, but a future registry edit must fail
    // here rather than silently opening a page to everyone.
    expect(() =>
      resolveSettingsRefusal('not-an-entry' as never, toSettingsNavPermissions([])),
    ).toThrow(/No settings registry entry/);
  });
});

describe('the 404-vs-403 posture is NOT flattened (MOTIR-2469)', () => {
  it('a NON-BROWSER is still answered by the area layout, before any page runs', () => {
    // The two refusals are different on purpose and must not collapse: someone
    // who cannot browse the project must not learn that a section exists, while
    // someone who CAN browse and lacks this domain's key gets the named refusal.
    // The layout owns the first and this story does not touch it.
    const layout = readFileSync(
      join(process.cwd(), 'app/(authed)/settings/project/layout.tsx'),
      'utf8',
    );
    expect(layout).toContain('canBrowse');
    expect(layout).toContain('NoAccessState');
    // And it still short-circuits BEFORE rendering children.
    expect(layout.indexOf('if (!canBrowse)')).toBeLessThan(layout.indexOf('return children;'));
  });

  it('the guard itself makes no browse decision — it would be the wrong altitude', () => {
    const guard = readFileSync(
      join(process.cwd(), 'app/(authed)/settings/project/_guard.tsx'),
      'utf8',
    );
    expect(guard).not.toContain('canBrowse');
    expect(guard).not.toContain('ProjectNotFoundError');
  });
});
