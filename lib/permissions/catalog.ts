// The permission CATALOG (Epic MOTIR-2254 · Story MOTIR-2255 · Subtask
// MOTIR-2260) — the single, code-owned, exhaustive list of the permissions
// Motir enforces. Pure data + pure helpers: no Prisma client, no IO, no React,
// so it imports cleanly from the server, the client and a test.
//
// ⚠️ A PERMISSION IS CODE, NEVER A ROW A USER AUTHORS. A key exists here
// because the product has an operation it governs. Letting a user invent one
// would put a switch on a settings page that controls nothing — the precise lie
// this model exists to prevent.
//
// The key set is derived from `docs/decisions/permission-inventory.md`
// (MOTIR-2274), which walks every `app/api/**/route.ts`, every `'use server'`
// action and all 122 services and records a DECIDED policy per operation. The
// first eleven keys came from the eleven predicates in `lib/projects/access.ts`;
// the inventory established that those eleven were one corner of the surface,
// so the catalog now covers what the product actually does.
//
// ⚠️ EVERY KEY CARRIES AN `enforcement`. `enforced` means a shipped gate
// consults it today. `planned` means the inventory justified it and no card has
// wired the call sites yet. This is what lets the vocabulary be named in one
// change and enforced in another WITHOUT weakening the orphan guard: that guard
// keeps full strength over `enforced` keys, and a `planned` key is excluded from
// `getRoleCatalog`, so it can never render as a switch.
//
// The `planned` list empties across TWO stories, and the split is deliberate:
//   * MOTIR-2256 — the twelve ADMINISTRATIVE keys that fall out of
//     `project:administer`. Behaviour-neutral for the built-in roles wherever
//     the umbrella already stood, because Admin holds all twelve.
//   * MOTIR-2291 — the eight MEMBER-FACING keys, whose operations are governed
//     by NOTHING today; wiring them removes capability from real actors, which
//     is a different kind of change and is argued on its own.
// (`repository:connect` WAS the twenty-first. MOTIR-2294 RETIRED it rather than
// wiring it: all six of its operations — the GitHub and GitLab OAuth legs,
// `/api/github/setup` and `/api/github/organizations` — bind an installation to a
// WORKSPACE and resolve no project at all, so no project role could ever govern
// them. Attaching a repository TO a project is `repository:manage`, which stays.
// A key with no operation behind it is exactly the lie the opening rule forbids.)
//
// The `resource:action` form is the mirror convention (Plane names permissions
// `workitem:edit`; Jira's permission names read the same way).
//
// ⚠️ "PERMISSION", NOT "SCOPE". `lib/mcp/scopes.ts` deliberately records that an
// API-token SCOPE is a separate axis — it NARROWS its owner's role and gates MCP
// operations. The two vocabularies stay distinct; nothing here is a scope and
// nothing there is a permission.

/**
 * The domain groups, in the order a UI renders them. Every permission carries
 * exactly one, and a domain with no permissions is a guard failure (an empty
 * heading is a worse surface than a missing one).
 */
export const PERMISSION_DOMAINS = [
  'project',
  'work_item',
  'comment',
  'attachment',
  'watcher',
  'public_request',
  'member',
  'board',
  'sprint',
  'workflow',
  'field',
  'estimation',
  'report',
  'repository',
  'import',
  'ai',
] as const;

/**
 * Whether a key is wired to a gate yet.
 *
 *   * `enforced` — a shipped `assertCan*` / predicate consults it TODAY.
 *   * `planned`  — justified by a row in docs/decisions/permission-inventory.md,
 *                  awaiting MOTIR-2256 (administrative) or MOTIR-2291
 *                  (member-facing). NEVER offered to a user.
 */
export type PermissionEnforcement = 'enforced' | 'planned';

/** One catalog domain — the group a permission renders under. */
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

/**
 * Every permission Motir enforces, in `resource:action` form. Frozen and
 * exhaustive: {@link PermissionKey} is derived from it, so every consumer is
 * exhaustive by construction and a key that does not exist fails to compile.
 *
 * Grouped by domain in {@link PERMISSION_DOMAINS} order, and within a domain the
 * `enforced` keys come before the `planned` ones. See PERMISSION_META for each
 * key's domain and enforcement, and the inventory document for the operation
 * that justifies it.
 */
export const PERMISSIONS = [
  'project:administer',
  'project:browse',
  'work_item:edit',
  'work_item:delete',
  'work_item:triage',
  'comment:add',
  'comment:moderate',
  'attachment:create',
  'attachment:delete_any',
  'watcher:manage',
  'public_request:comment',
  'public_request:submit',
  'public_request:upvote',
  'member:manage',
  'project:manage_access',
  'board:configure',
  'sprint:manage',
  'automation:manage',
  'workflow:manage',
  'component:manage',
  'field:manage',
  'label:manage',
  'estimation:manage',
  'report:view',
  'saved_filter:manage',
  'repository:manage',
  'repository:manage_access',
  'import:run',
  'ai:configure',
  'ai:plan',
  'ai:view_plan',
] as const;

/** One permission key — the union derived from {@link PERMISSIONS}. */
export type PermissionKey = (typeof PERMISSIONS)[number];

/** A permission's render metadata: its group and its two i18n keys. */
export interface PermissionDescriptor {
  key: PermissionKey;
  domain: PermissionDomain;
  /** Whether a gate consults this key today — see {@link PermissionEnforcement}. */
  enforcement: PermissionEnforcement;
  /** i18n key for the human label (under the `permissions` namespace). */
  labelKey: string;
  /** i18n key for the one-line description shown beside the label. */
  descriptionKey: string;
}

/**
 * The i18n SLUG for a permission key — the `:` replaced by `_`, because
 * next-intl treats `.` as its path separator and a raw `resource:action` key
 * would read awkwardly inside one. `work_item:edit` → `work_item_edit`, so the
 * label key is `permissions.work_item_edit.label`. Domains are a closed set, so
 * the flattening is unambiguous.
 */
export function permissionSlug(key: PermissionKey): string {
  return key.replace(':', '_');
}

/**
 * The domain + ENFORCEMENT of each permission. Total over {@link PERMISSIONS}.
 *
 * `enforced` — a shipped gate consults this key today.
 * `planned`  — the inventory (docs/decisions/permission-inventory.md) justified it and
 *              MOTIR-2256 / MOTIR-2291 have not wired it yet. A planned key
 *              NEVER reaches a user.
 */
const PERMISSION_META: Record<
  PermissionKey,
  { domain: PermissionDomain; enforcement: PermissionEnforcement }
> = {
  'project:administer': { domain: 'project', enforcement: 'enforced' },
  'project:browse': { domain: 'project', enforcement: 'enforced' },
  'work_item:edit': { domain: 'work_item', enforcement: 'enforced' },
  'work_item:delete': { domain: 'work_item', enforcement: 'enforced' }, // MOTIR-2354
  'work_item:triage': { domain: 'work_item', enforcement: 'enforced' }, // MOTIR-2354
  'comment:add': { domain: 'comment', enforcement: 'enforced' },
  'comment:moderate': { domain: 'comment', enforcement: 'enforced' },
  'attachment:create': { domain: 'attachment', enforcement: 'enforced' },
  'attachment:delete_any': { domain: 'attachment', enforcement: 'enforced' },
  'watcher:manage': { domain: 'watcher', enforcement: 'enforced' },
  'public_request:comment': { domain: 'public_request', enforcement: 'enforced' },
  'public_request:submit': { domain: 'public_request', enforcement: 'enforced' },
  'public_request:upvote': { domain: 'public_request', enforcement: 'enforced' },
  'member:manage': { domain: 'member', enforcement: 'enforced' },
  'project:manage_access': { domain: 'member', enforcement: 'enforced' },
  'board:configure': { domain: 'board', enforcement: 'enforced' },
  'sprint:manage': { domain: 'sprint', enforcement: 'enforced' }, // MOTIR-2350
  'automation:manage': { domain: 'workflow', enforcement: 'enforced' },
  'workflow:manage': { domain: 'workflow', enforcement: 'enforced' },
  'component:manage': { domain: 'field', enforcement: 'enforced' },
  'field:manage': { domain: 'field', enforcement: 'enforced' },
  'label:manage': { domain: 'field', enforcement: 'enforced' },
  'estimation:manage': { domain: 'estimation', enforcement: 'enforced' },
  'report:view': { domain: 'report', enforcement: 'enforced' }, // MOTIR-2351
  'saved_filter:manage': { domain: 'report', enforcement: 'enforced' }, // MOTIR-2352
  'repository:manage': { domain: 'repository', enforcement: 'enforced' },
  'repository:manage_access': { domain: 'repository', enforcement: 'enforced' },
  'import:run': { domain: 'import', enforcement: 'enforced' }, // MOTIR-2353
  'ai:configure': { domain: 'ai', enforcement: 'enforced' },
  'ai:plan': { domain: 'ai', enforcement: 'planned' },
  'ai:view_plan': { domain: 'ai', enforcement: 'enforced' }, // MOTIR-2363
};

/**
 * The catalog: every permission's descriptor, keyed by permission. Typed
 * `Record<PermissionKey, …>`, so a key added to {@link PERMISSIONS} without a
 * descriptor is a COMPILE error — the totality guarantee, re-asserted at runtime
 * by `tests/permissions/catalog.test.ts` so it survives a type-erasure refactor.
 */
export const PERMISSION_CATALOG: Record<PermissionKey, PermissionDescriptor> = Object.fromEntries(
  PERMISSIONS.map((key) => [
    key,
    {
      key,
      domain: PERMISSION_META[key].domain,
      enforcement: PERMISSION_META[key].enforcement,
      labelKey: `permissions.${permissionSlug(key)}.label`,
      descriptionKey: `permissions.${permissionSlug(key)}.description`,
    } satisfies PermissionDescriptor,
  ]),
) as Record<PermissionKey, PermissionDescriptor>;

/** Membership test usable on an untrusted string (a persisted / posted value). */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/** The descriptor for a permission. */
export function permissionDescriptor(key: PermissionKey): PermissionDescriptor {
  return PERMISSION_CATALOG[key];
}

/** Whether a shipped gate consults this key today. */
export function isEnforced(key: PermissionKey): boolean {
  return PERMISSION_CATALOG[key].enforcement === 'enforced';
}

/** The keys a gate consults today — what a user may actually be shown. */
export const ENFORCED_PERMISSIONS: readonly PermissionKey[] = PERMISSIONS.filter(isEnforced);

/**
 * The keys the inventory justified but nothing has wired yet. Named so a test
 * can pin it against the inventory document, and so "the model is fully
 * enforced" has a machine-readable definition: this array is empty. That takes
 * BOTH MOTIR-2256 (the twelve administrative keys) and MOTIR-2291 (the eight
 * member-facing ones) — neither story empties it alone.
 */
export const PLANNED_PERMISSIONS: readonly PermissionKey[] = PERMISSIONS.filter(
  (key) => !isEnforced(key),
);

/**
 * The catalog grouped for rendering — domains in {@link PERMISSION_DOMAINS}
 * order, each carrying its permissions in {@link PERMISSIONS} order. This is the
 * render order the Roles & permissions grid walks, so the grid's grouping is a
 * property of the catalog rather than a decision re-made in a component.
 *
 * ⚠️ RETURNS EVERY KEY, INCLUDING `planned` — and that is deliberate.
 *
 * An earlier revision filtered to `enforced` here, reasoning that a key no gate
 * consults would become a switch controlling nothing. The reasoning is right and
 * the placement was wrong: with 21 of 32 keys planned, filtering meant the
 * Roles & permissions page showed a QUARTER of the model and implied that was
 * all of it — which is precisely the under-description this epic exists to fix.
 * Trading one lie for a larger one.
 *
 * The rule belongs where a switch actually exists. The read-only GRID shows the
 * whole model and marks each row's `enforcement`, so the page is honest about
 * both what the product governs and what is not wired yet. The role EDITOR
 * (MOTIR-2257) is what must never let a `planned` key be toggled.
 *
 * `{ include: 'enforced' }` narrows to the wired keys for a caller that needs
 * only those. Domains left empty by a filter are dropped, so a heading is never
 * drawn with nothing under it.
 */
export function permissionsByDomain(
  options: { include?: 'enforced' | 'all' } = {},
): { domain: PermissionDomain; permissions: PermissionDescriptor[] }[] {
  const all = options.include !== 'enforced';
  return PERMISSION_DOMAINS.map((domain) => ({
    domain,
    permissions: PERMISSIONS.map((key) => PERMISSION_CATALOG[key]).filter(
      (descriptor) =>
        descriptor.domain === domain && (all || descriptor.enforcement === 'enforced'),
    ),
  })).filter((group) => group.permissions.length > 0);
}

/** Sort an arbitrary permission collection into canonical catalog order. */
export function sortByCatalogOrder(keys: Iterable<PermissionKey>): PermissionKey[] {
  const held = new Set(keys);
  return PERMISSIONS.filter((key) => held.has(key));
}
