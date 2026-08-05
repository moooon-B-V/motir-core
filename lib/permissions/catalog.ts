// The permission CATALOG (Epic MOTIR-2254 · Story MOTIR-2255 · Subtask
// MOTIR-2260) — the single, code-owned, exhaustive list of the permissions
// Motir enforces. Pure data + pure helpers: no Prisma client, no IO, no React,
// so it imports cleanly from the server, the client and a test.
//
// ⚠️ A PERMISSION IS CODE, NEVER A ROW A USER AUTHORS. A key exists here
// because somewhere in the codebase there is a gate that consults it. Letting a
// user invent one would put a switch on a settings page that controls nothing —
// the precise lie this model exists to prevent. The catalog therefore starts at
// EXACTLY what Motir enforces today (one key per shipped predicate in
// `lib/projects/access.ts`, plus the `project:administer` umbrella) rather than
// copying the mirror product's larger catalog, which would ship keys with no
// enforcement behind them on day one. It grows as enforcement grows.
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
] as const;

/** One catalog domain — the group a permission renders under. */
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

/**
 * Every permission Motir enforces, in `resource:action` form. Frozen and
 * exhaustive: {@link PermissionKey} is derived from it, so every consumer is
 * exhaustive by construction and a key that does not exist fails to compile.
 *
 * One key per shipped predicate in `lib/projects/access.ts`:
 *
 * | key                        | predicate                    |
 * | -------------------------- | ---------------------------- |
 * | `project:browse`           | `canBrowse`                  |
 * | `project:administer`       | `canManageProject`           |
 * | `work_item:edit`           | `canEdit`                    |
 * | `comment:add`              | `canComment`                 |
 * | `comment:moderate`         | `canModerateComments`        |
 * | `attachment:create`        | `canCreateAttachments`       |
 * | `attachment:delete_any`    | `canDeleteAllAttachments`    |
 * | `watcher:manage`           | `canManageWatchers`          |
 * | `public_request:submit`    | `canSubmitToTriage`          |
 * | `public_request:upvote`    | `canUpvotePublicRequest`     |
 * | `public_request:comment`   | `canCommentPublicRequest`    |
 *
 * `project:administer` is deliberately ONE umbrella covering every settings
 * domain. Splitting it per domain is Story MOTIR-2256's whole job; this story
 * must not start it.
 */
export const PERMISSIONS = [
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
] as const;

/** One permission key — the union derived from {@link PERMISSIONS}. */
export type PermissionKey = (typeof PERMISSIONS)[number];

/** A permission's render metadata: its group and its two i18n keys. */
export interface PermissionDescriptor {
  key: PermissionKey;
  domain: PermissionDomain;
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

/** The domain each permission belongs to. Total over {@link PERMISSIONS}. */
const PERMISSION_DOMAIN_BY_KEY: Record<PermissionKey, PermissionDomain> = {
  'project:browse': 'project',
  'project:administer': 'project',
  'work_item:edit': 'work_item',
  'comment:add': 'comment',
  'comment:moderate': 'comment',
  'attachment:create': 'attachment',
  'attachment:delete_any': 'attachment',
  'watcher:manage': 'watcher',
  'public_request:submit': 'public_request',
  'public_request:upvote': 'public_request',
  'public_request:comment': 'public_request',
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
      domain: PERMISSION_DOMAIN_BY_KEY[key],
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

/**
 * The catalog grouped for rendering — domains in {@link PERMISSION_DOMAINS}
 * order, each carrying its permissions in {@link PERMISSIONS} order. This is the
 * render order the Roles & permissions grid walks, so the grid's grouping is a
 * property of the catalog rather than a decision re-made in a component.
 */
export function permissionsByDomain(): {
  domain: PermissionDomain;
  permissions: PermissionDescriptor[];
}[] {
  return PERMISSION_DOMAINS.map((domain) => ({
    domain,
    permissions: PERMISSIONS.map((key) => PERMISSION_CATALOG[key]).filter(
      (descriptor) => descriptor.domain === domain,
    ),
  }));
}

/** Sort an arbitrary permission collection into canonical catalog order. */
export function sortByCatalogOrder(keys: Iterable<PermissionKey>): PermissionKey[] {
  const held = new Set(keys);
  return PERMISSIONS.filter((key) => held.has(key));
}
