import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import {
  ENFORCED_PERMISSIONS,
  PERMISSION_IMPLICATIONS,
  PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSION_DOMAINS,
  PLANNED_PERMISSIONS,
  withImpliedPermissions,
  isEnforced,
  isPermissionKey,
  permissionDescriptor,
  permissionSlug,
  permissionsByDomain,
  sortByCatalogOrder,
} from '@/lib/permissions/catalog';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { IRREVERSIBLE_PERMISSIONS } from '@/lib/tokens/grant';

// The permission-CATALOG guards (Story MOTIR-2255 · Subtask MOTIR-2260). The
// catalog is typed `Record<PermissionKey, …>`, so a key added without a
// descriptor is already a COMPILE error; this suite re-asserts every invariant
// at runtime so the guarantees survive a type-erasure refactor, and adds the two
// the type system cannot see: the i18n catalogs are TOTAL over the keys (in both
// locales), and the module stays pure. No DB, no IO — a pure model check.

const ROOT = join(__dirname, '..', '..');

/** Walk a dotted i18n path into a loaded catalog; undefined when absent. */
function lookup(catalog: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined,
      catalog,
    );
}

describe('PERMISSIONS is a well-formed set', () => {
  it('has no duplicate keys', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('names every key in `resource:action` form', () => {
    for (const key of PERMISSIONS) {
      expect(key, `"${key}" is not resource:action`).toMatch(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
    }
  });

  it('is non-empty', () => {
    expect(PERMISSIONS.length).toBeGreaterThan(0);
  });
});

describe('PERMISSION_CATALOG totality over PERMISSIONS', () => {
  it('carries a descriptor for every key, and no stale ones', () => {
    for (const key of PERMISSIONS) {
      expect(PERMISSION_CATALOG[key], `"${key}" has no descriptor`).toBeDefined();
    }
    const known = new Set<string>(PERMISSIONS);
    for (const mapped of Object.keys(PERMISSION_CATALOG)) {
      expect(known.has(mapped), `catalog has stale key "${mapped}"`).toBe(true);
    }
    expect(Object.keys(PERMISSION_CATALOG).length).toBe(PERMISSIONS.length);
  });

  it('gives every permission a domain that appears in the render order', () => {
    const domains = new Set<string>(PERMISSION_DOMAINS);
    for (const key of PERMISSIONS) {
      const { domain } = PERMISSION_CATALOG[key];
      expect(domains.has(domain), `"${key}" has unknown domain "${domain}"`).toBe(true);
    }
  });

  it('derives both i18n keys from the permission slug', () => {
    for (const key of PERMISSIONS) {
      const descriptor = PERMISSION_CATALOG[key];
      expect(descriptor.key).toBe(key);
      expect(descriptor.labelKey).toBe(`permissions.${permissionSlug(key)}.label`);
      expect(descriptor.descriptionKey).toBe(`permissions.${permissionSlug(key)}.description`);
    }
  });

  it('permissionDescriptor() returns the same descriptor as the map', () => {
    for (const key of PERMISSIONS) {
      expect(permissionDescriptor(key)).toBe(PERMISSION_CATALOG[key]);
    }
  });

  it('permissionSlug() replaces the colon so next-intl can path it', () => {
    expect(permissionSlug('work_item:edit')).toBe('work_item_edit');
    expect(permissionSlug('attachment:delete_any')).toBe('attachment_delete_any');
    for (const key of PERMISSIONS) {
      expect(permissionSlug(key)).not.toContain(':');
      expect(permissionSlug(key)).not.toContain('.');
    }
  });
});

describe('every domain in the render order earns its heading', () => {
  it('has at least one permission per domain', () => {
    for (const { domain, permissions } of permissionsByDomain()) {
      expect(
        permissions.length,
        `domain "${domain}" would render an empty heading`,
      ).toBeGreaterThan(0);
    }
  });

  it('covers every permission exactly once across the groups', () => {
    const grouped = permissionsByDomain({ include: 'all' }).flatMap((group) =>
      group.permissions.map((p) => p.key),
    );
    expect(grouped.length).toBe(PERMISSIONS.length);
    expect(new Set(grouped).size).toBe(PERMISSIONS.length);
    expect([...grouped].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('emits the domains in PERMISSION_DOMAINS order', () => {
    expect(permissionsByDomain({ include: 'all' }).map((group) => group.domain)).toEqual([
      ...PERMISSION_DOMAINS,
    ]);
  });

  it('never emits an EMPTY group under any filter', () => {
    for (const opts of [
      {},
      { include: 'enforced' as const },
      { include: ROLE_GATED_PERMISSIONS },
      { include: ['comment:add'] as PermissionKey[] },
    ]) {
      for (const group of permissionsByDomain(opts)) {
        expect(group.permissions.length, `domain "${group.domain}" is empty`).toBeGreaterThan(0);
      }
    }
  });
});

// The third `include` arm (Subtask MOTIR-2439) — the Roles & permissions screens
// draw the ROLE-GATED rows, and the arm takes the SET rather than naming it, so
// `catalog.ts` stays the import-free leaf the purity guard below asserts.
describe('permissionsByDomain narrows to an explicit key set', () => {
  it('yields exactly ROLE_GATED_PERMISSIONS — asserted against the constant, never a count', () => {
    const flattened = permissionsByDomain({ include: ROLE_GATED_PERMISSIONS }).flatMap((group) =>
      group.permissions.map((p) => p.key),
    );
    expect([...flattened].sort()).toEqual([...ROLE_GATED_PERMISSIONS].sort());
  });

  it('drops exactly the level-gated public_request keys, which no role can hold', () => {
    const flattened = permissionsByDomain({ include: ROLE_GATED_PERMISSIONS }).flatMap((group) =>
      group.permissions.map((p) => p.key),
    );
    const dropped = PERMISSIONS.filter((key) => !flattened.includes(key));
    expect([...dropped].sort()).toEqual(
      PERMISSIONS.filter((key) => key.startsWith('public_request:')).sort(),
    );
    // …and the whole `public_request` DOMAIN goes with them: an empty heading is
    // never drawn.
    expect(
      permissionsByDomain({ include: ROLE_GATED_PERMISSIONS }).map((g) => g.domain),
    ).not.toContain('public_request');
  });

  it('preserves catalog order within a group and PERMISSION_DOMAINS order across them', () => {
    const groups = permissionsByDomain({ include: ROLE_GATED_PERMISSIONS });
    const domainPositions = groups.map((g) => PERMISSION_DOMAINS.indexOf(g.domain));
    expect(domainPositions).toEqual([...domainPositions].sort((a, b) => a - b));
    for (const group of groups) {
      const positions = group.permissions.map((p) => PERMISSIONS.indexOf(p.key));
      expect(positions, `domain "${group.domain}" out of catalog order`).toEqual(
        [...positions].sort((a, b) => a - b),
      );
    }
  });

  it('leaves the existing `enforced` and `all` arms untouched', () => {
    expect(
      permissionsByDomain({ include: 'all' }).flatMap((g) => g.permissions.map((p) => p.key))
        .length,
    ).toBe(PERMISSIONS.length);
    expect(permissionsByDomain({ include: 'all' })).toEqual(permissionsByDomain());
    for (const group of permissionsByDomain({ include: 'enforced' })) {
      for (const descriptor of group.permissions) {
        expect(descriptor.enforcement).toBe('enforced');
      }
    }
  });

  it('admits an empty set as empty, not as everything', () => {
    expect(permissionsByDomain({ include: [] })).toEqual([]);
  });
});

/**
 * The administrative keys MOTIR-2256 has WIRED so far — each one's gates ship in
 * its own card, and the card that wires a domain adds its keys here in the same
 * change. The list is the story's progress bar: it is empty before MOTIR-2295
 * and holds all twelve when the story closes.
 */
const ADMINISTRATIVE_ENFORCED: PermissionKey[] = [
  'member:manage',
  'project:manage_access',
  'ai:configure',
  'repository:manage',
  'repository:manage_access',
  'board:configure',
  'workflow:manage',
  'automation:manage',
  'field:manage',
  'component:manage',
  'label:manage',
  'estimation:manage',
];

/**
 * The MEMBER-FACING keys MOTIR-2291 wired — same progress-bar shape as the twelve
 * above, and the card that wires a key added it here in the same change. It was
 * empty before MOTIR-2350 and holds ALL EIGHT now that MOTIR-2356 has flipped the
 * last flag; the partition test below is what turns that into "the model is fully
 * enforced" rather than a list somebody maintains.
 *
 * ⚠️ Kept SEPARATE from `ADMINISTRATIVE_ENFORCED` rather than appended to it.
 * The twelve are provably equivalent to `project:administer` for every actor
 * (`accessParity.test.ts`); these eight are deliberately not, so a reader must
 * never take membership of one list as evidence about the other.
 */
const MEMBER_FACING_ENFORCED: PermissionKey[] = [
  'sprint:manage',
  'report:view',
  'saved_filter:manage',
  'import:run',
  'work_item:triage',
  'work_item:delete',
  'ai:view_plan',
  'ai:plan',
];

/**
 * The key MOTIR-3188 split out of `ai:view_plan`. A THIRD list rather than an
 * append to either of the two above, and for the reason `MEMBER_FACING_ENFORCED`
 * gives for not being folded into `ADMINISTRATIVE_ENFORCED`: membership of a list
 * here is evidence about the STORY that wired the key, and `ai:decide_plan` was
 * wired by neither MOTIR-2256 nor MOTIR-2291. It arrives `enforced` because the
 * gate and the key land in the same change — there was never a moment where the
 * catalog advertised it and `plansService` did not assert it.
 */
const PLAN_DECISION_ENFORCED: PermissionKey[] = ['ai:decide_plan'];

/**
 * The LESSON LIBRARY keys MOTIR-3336 wired — a FOURTH list, for the reason
 * `PLAN_DECISION_ENFORCED` gives for being a third: membership of a list here is
 * evidence about the STORY that wired the key, and these two were wired by none
 * of MOTIR-2256, MOTIR-2291 or MOTIR-3188. They arrive `enforced` because the
 * predicates (`canViewLessons` / `canManageLessons` / `canReinforceLessons` in
 * `lib/projects/access.ts`) land in the same change — there was never a moment
 * where the catalog advertised one and nothing resolved through it.
 */
const LESSON_LIBRARY_ENFORCED: PermissionKey[] = [
  'lesson:view',
  'lesson:manage',
  // MOTIR-3553 — the THIRD lesson key, and it belongs to this list on the same
  // terms as the other two: it was wired by none of the earlier stories, and it
  // arrives `enforced` because `canReinforceLessons` lands in the same change.
  'lesson:reinforce',
];

/**
 * The key MOTIR-3629 split out of `work_item:delete` — a FIFTH list, on exactly
 * the terms the third and fourth give for not being appended to an earlier one:
 * membership of a list here is evidence about the STORY that wired the key, and
 * this one was wired by none of MOTIR-2256, MOTIR-2291, MOTIR-3188 or
 * MOTIR-3336. It arrives `enforced` because both gates
 * (`workItemsService.archiveWorkItem` / `unarchiveWorkItem`) move in the same
 * change — there was never a moment where the catalog advertised it and nothing
 * asserted it.
 */
const REMOVAL_SPLIT_ENFORCED: PermissionKey[] = ['work_item:archive'];

describe('enforcement — the seam that lets naming and wiring land separately', () => {
  it('partitions the catalog exactly: enforced + planned = every key, no overlap', () => {
    expect([...ENFORCED_PERMISSIONS, ...PLANNED_PERMISSIONS].sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
    expect(ENFORCED_PERMISSIONS.filter((k) => PLANNED_PERMISSIONS.includes(k))).toEqual([]);
  });

  it('THE MODEL IS FULLY ENFORCED — `PLANNED_PERMISSIONS` is empty (MOTIR-2356)', () => {
    // The machine-readable definition `catalog.ts` gives itself, asserted as a
    // SET rather than a count: a length constant would pass just as happily if a
    // key were deleted from the catalog as if its gate were wired.
    expect([...PLANNED_PERMISSIONS]).toEqual([]);
    expect([...ENFORCED_PERMISSIONS].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('marks every key with a known enforcement value', () => {
    for (const key of PERMISSIONS) {
      expect(['enforced', 'planned'], `"${key}"`).toContain(PERMISSION_CATALOG[key].enforcement);
    }
  });

  it('keeps the ELEVEN shipped predicates enforced — growing the catalog demotes nothing', () => {
    // These are the keys `lib/projects/access.ts` resolves through today. If one
    // became `planned`, a shipped gate would be consulting a key the model says
    // nothing enforces.
    const shipped: PermissionKey[] = [
      'project:browse',
      'project:administer',
      'work_item:edit',
      'comment:add',
      'comment:moderate',
      'attachment:create',
      'attachment:delete_any',
      'watcher:manage',
      'public_request:submit',
      'public_request:upvote',
      'public_request:comment',
    ];
    for (const key of shipped) expect(isEnforced(key), `${key} must stay enforced`).toBe(true);
    // The eleven above are a FLOOR, not the total. MOTIR-2256 flips one domain
    // at a time from `planned` to `enforced`, so this number rises as the story
    // lands and the assertion above is what actually guards against a demotion.
    // Moving it DOWN is the regression to catch.
    expect(ENFORCED_PERMISSIONS.length).toBeGreaterThanOrEqual(shipped.length);
    // The twelve administrative keys, as they get wired. Listed explicitly so a
    // key that flips without a gate behind it — or a gate that lands without the
    // catalog being told — fails here rather than passing a bare count.
    expect(ENFORCED_PERMISSIONS.filter((k) => ADMINISTRATIVE_ENFORCED.includes(k)).sort()).toEqual(
      [...ADMINISTRATIVE_ENFORCED].sort(),
    );
    // …and the member-facing keys, on the same terms (MOTIR-2291).
    expect(ENFORCED_PERMISSIONS.filter((k) => MEMBER_FACING_ENFORCED.includes(k)).sort()).toEqual(
      [...MEMBER_FACING_ENFORCED].sort(),
    );
    // …and MOTIR-3188's plan-DECISION key, on the same terms again.
    expect(ENFORCED_PERMISSIONS.filter((k) => PLAN_DECISION_ENFORCED.includes(k)).sort()).toEqual(
      [...PLAN_DECISION_ENFORCED].sort(),
    );
    // …and MOTIR-3336's two lesson-library keys, on the same terms again.
    expect(ENFORCED_PERMISSIONS.filter((k) => LESSON_LIBRARY_ENFORCED.includes(k)).sort()).toEqual(
      [...LESSON_LIBRARY_ENFORCED].sort(),
    );
    // …and MOTIR-3629's removal split, on the same terms again.
    expect(ENFORCED_PERMISSIONS.filter((k) => REMOVAL_SPLIT_ENFORCED.includes(k)).sort()).toEqual(
      [...REMOVAL_SPLIT_ENFORCED].sort(),
    );
    expect(ENFORCED_PERMISSIONS).toHaveLength(
      shipped.length +
        ADMINISTRATIVE_ENFORCED.length +
        MEMBER_FACING_ENFORCED.length +
        PLAN_DECISION_ENFORCED.length +
        LESSON_LIBRARY_ENFORCED.length +
        REMOVAL_SPLIT_ENFORCED.length,
    );
  });

  it('renders the WHOLE model by default — the grid must not under-describe the product', () => {
    // The earlier revision filtered to `enforced` here. With 21 of 32 keys
    // planned that showed a quarter of the model and implied it was all of it —
    // the exact under-description this epic exists to fix. The no-dead-switch
    // rule belongs to the EDITOR, where a switch actually exists.
    const shown = permissionsByDomain().flatMap((g) => g.permissions.map((p) => p.key));
    expect([...shown].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('marks every rendered row with its enforcement, so the UI can say which are live', () => {
    for (const group of permissionsByDomain()) {
      for (const descriptor of group.permissions) {
        expect(['enforced', 'planned']).toContain(descriptor.enforcement);
        expect(descriptor.enforcement).toBe(PERMISSION_CATALOG[descriptor.key].enforcement);
      }
    }
  });

  it('can still narrow to the wired keys when a caller needs only those', () => {
    const enforced = permissionsByDomain({ include: 'enforced' }).flatMap((g) =>
      g.permissions.map((p) => p.key),
    );
    expect([...enforced].sort()).toEqual([...ENFORCED_PERMISSIONS].sort());
  });

  it('every PLANNED key is justified by a row in the inventory document', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'decisions', 'permission-inventory.md'), 'utf8');
    expect(
      PLANNED_PERMISSIONS.filter((k) => !doc.includes(`\`${k}\``)),
      'a key cannot be parked as `planned` without an operation that needs it',
    ).toEqual([]);
  });
});

describe('i18n totality — BOTH catalogs, so a key cannot ship half-translated', () => {
  it.each([
    ['en', en],
    ['zh', zh],
  ])('%s carries a label and a description for every permission', (locale, catalog) => {
    for (const key of PERMISSIONS) {
      const { labelKey, descriptionKey } = PERMISSION_CATALOG[key];
      const label = lookup(catalog, labelKey);
      const description = lookup(catalog, descriptionKey);
      expect(typeof label, `${locale} is missing ${labelKey}`).toBe('string');
      expect(String(label).trim(), `${locale}:${labelKey} is blank`).not.toBe('');
      expect(typeof description, `${locale} is missing ${descriptionKey}`).toBe('string');
      expect(String(description).trim(), `${locale}:${descriptionKey} is blank`).not.toBe('');
    }
  });

  it.each([
    ['en', en],
    ['zh', zh],
  ])('%s labels every domain heading', (locale, catalog) => {
    for (const domain of PERMISSION_DOMAINS) {
      const label = lookup(catalog, `permissions.domain.${domain}`);
      expect(typeof label, `${locale} is missing permissions.domain.${domain}`).toBe('string');
    }
  });

  it('has no permission entry in either catalog that the code does not know', () => {
    const slugs = new Set(PERMISSIONS.map((key) => permissionSlug(key)));
    for (const [locale, catalog] of [
      ['en', en],
      ['zh', zh],
    ] as const) {
      const block = lookup(catalog, 'permissions') as Record<string, unknown>;
      for (const entry of Object.keys(block)) {
        if (entry === 'domain') continue;
        expect(slugs.has(entry), `${locale} has orphan permission string "${entry}"`).toBe(true);
      }
    }
  });
});

describe('PERMISSION_IMPLICATIONS — the one key that confers another (MOTIR-3629)', () => {
  it('maps `work_item:delete` to `work_item:archive`, and nothing else', () => {
    // Asserted as the WHOLE map, not as one lookup: an entry added without an
    // argument is the failure mode this guard exists for, and an extra row here
    // would otherwise pass every test in this file.
    expect(PERMISSION_IMPLICATIONS).toEqual({ 'work_item:delete': ['work_item:archive'] });
  });

  it('names only real catalog keys, on both sides', () => {
    for (const [key, implied] of Object.entries(PERMISSION_IMPLICATIONS)) {
      expect(isPermissionKey(key), `implier "${key}" is not a catalog key`).toBe(true);
      for (const k of implied ?? []) {
        expect(isPermissionKey(k), `implied "${k}" is not a catalog key`).toBe(true);
      }
    }
  });

  it('is IRREFLEXIVE and NOT transitive — no implied key is itself an implier', () => {
    // `withImpliedPermissions` expands in ONE pass rather than to a closure, so
    // the two agree only while this holds. It holds trivially today, and the day
    // an entry would break it is the day someone must choose deliberately
    // between a second pass and a different edge — a red build, not a silent
    // widening. (See the constant's own header.)
    const impliers = new Set(Object.keys(PERMISSION_IMPLICATIONS));
    for (const [key, implied] of Object.entries(PERMISSION_IMPLICATIONS)) {
      for (const k of implied ?? []) {
        expect(k, 'an implication must not be reflexive').not.toBe(key);
        expect(impliers.has(k), `"${k}" is implied AND implies — expansion is one pass`).toBe(
          false,
        );
      }
    }
  });

  it('expands a held set, leaves an unrelated one alone, and never mutates its input', () => {
    const held = new Set<PermissionKey>(['project:browse', 'work_item:delete']);
    const expanded = withImpliedPermissions(held);
    expect([...expanded].sort()).toEqual(
      ['project:browse', 'work_item:archive', 'work_item:delete'].sort(),
    );
    expect([...held].sort()).toEqual(['project:browse', 'work_item:delete'].sort());
    expect([...withImpliedPermissions(['work_item:edit'] as PermissionKey[])]).toEqual([
      'work_item:edit',
    ]);
    // The other direction is NOT implied: archiving does not confer destroying.
    expect([...withImpliedPermissions(['work_item:archive'] as PermissionKey[])]).toEqual([
      'work_item:archive',
    ]);
  });

  it('leaves the IRREVERSIBLE set to `work_item:delete` alone', () => {
    // The reason the implication is safe to run everywhere: it only ever adds
    // the reversible half. A key that implied an irreversible one would put a
    // destroy behind a grant nobody ticked.
    for (const implied of Object.values(PERMISSION_IMPLICATIONS).flatMap((v) => v ?? [])) {
      expect(IRREVERSIBLE_PERMISSIONS).not.toContain(implied);
    }
  });
});

describe('the work_item domain reads in order of severity (MOTIR-3629)', () => {
  it('places archive between edit and delete, contiguously within its domain', () => {
    // The picker groups by domain and renders each group in PERMISSIONS order,
    // so the flat list and the grouped one agree only while every domain's keys
    // are contiguous here (MOTIR-3361). The ORDER within the domain is the
    // card's own argument made structural: edit a field, hide a row, destroy a
    // subtree.
    const workItem = PERMISSIONS.filter((k) => PERMISSION_CATALOG[k].domain === 'work_item');
    expect(workItem).toEqual([
      'work_item:edit',
      'work_item:archive',
      'work_item:delete',
      'work_item:triage',
    ]);
    const first = PERMISSIONS.indexOf(workItem[0]!);
    expect(PERMISSIONS.slice(first, first + workItem.length)).toEqual(workItem);
  });
});

describe('isPermissionKey narrows an untrusted value', () => {
  it('accepts every catalog key', () => {
    for (const key of PERMISSIONS) expect(isPermissionKey(key)).toBe(true);
  });

  it('rejects a near-miss, a scope, and a non-string', () => {
    expect(isPermissionKey('work_item:destroy')).toBe(false);
    expect(isPermissionKey('work_items:write')).toBe(false); // an MCP token SCOPE
    expect(isPermissionKey('')).toBe(false);
    expect(isPermissionKey(null)).toBe(false);
    expect(isPermissionKey(undefined)).toBe(false);
    expect(isPermissionKey(42)).toBe(false);
    expect(isPermissionKey({ key: 'project:browse' })).toBe(false);
  });
});

describe('sortByCatalogOrder', () => {
  it('returns catalog order regardless of input order', () => {
    const shuffled: PermissionKey[] = ['work_item:edit', 'project:browse', 'comment:moderate'];
    expect(sortByCatalogOrder(shuffled)).toEqual([
      'project:browse',
      'work_item:edit',
      'comment:moderate',
    ]);
  });

  it('drops duplicates and preserves an empty input', () => {
    expect(sortByCatalogOrder(['comment:add', 'comment:add'])).toEqual(['comment:add']);
    expect(sortByCatalogOrder([])).toEqual([]);
  });

  it('accepts a Set as well as an array', () => {
    expect(sortByCatalogOrder(new Set<PermissionKey>(['comment:add', 'project:browse']))).toEqual([
      'project:browse',
      'comment:add',
    ]);
  });
});

describe('the catalog module stays PURE — no Prisma, no IO, no React', () => {
  it('imports nothing that would stop it loading in a client or a test', () => {
    const source = readFileSync(join(ROOT, 'lib/permissions/catalog.ts'), 'utf8');
    expect(source, 'must not import the Prisma client').not.toMatch(/from '@\/lib\/db'/);
    expect(source, 'must not import @prisma/client').not.toMatch(/from '@prisma\/client'/);
    expect(source, 'must not import a repository or service').not.toMatch(
      /from '@\/lib\/(repositories|services)\//,
    );
    expect(source, 'must not import server-only').not.toMatch(/['"]server-only['"]/);
    expect(source, 'must not read the filesystem').not.toMatch(/from 'node:(fs|path)'/);
    expect(source, 'must not import React').not.toMatch(/from ['"]react['"]/);
    expect(source, 'must not import next/*').not.toMatch(/from ['"]next\//);
  });

  it('has no import at all outside the module (it is a leaf)', () => {
    const source = readFileSync(join(ROOT, 'lib/permissions/catalog.ts'), 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
