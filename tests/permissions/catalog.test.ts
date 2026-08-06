import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import {
  ENFORCED_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSION_DOMAINS,
  PLANNED_PERMISSIONS,
  isEnforced,
  isPermissionKey,
  permissionDescriptor,
  permissionSlug,
  permissionsByDomain,
  sortByCatalogOrder,
} from '@/lib/permissions/catalog';
import type { PermissionKey } from '@/lib/permissions/catalog';

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
    for (const opts of [{}, { include: 'enforced' as const }]) {
      for (const group of permissionsByDomain(opts)) {
        expect(group.permissions.length, `domain "${group.domain}" is empty`).toBeGreaterThan(0);
      }
    }
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

describe('enforcement — the seam that lets naming and wiring land separately', () => {
  it('partitions the catalog exactly: enforced + planned = every key, no overlap', () => {
    expect([...ENFORCED_PERMISSIONS, ...PLANNED_PERMISSIONS].sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
    expect(ENFORCED_PERMISSIONS.filter((k) => PLANNED_PERMISSIONS.includes(k))).toEqual([]);
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
    expect(ENFORCED_PERMISSIONS).toHaveLength(shipped.length + ADMINISTRATIVE_ENFORCED.length);
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
