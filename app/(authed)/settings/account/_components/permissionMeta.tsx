import {
  Eye,
  MessageSquare,
  Sparkles,
  SquarePen,
  Trash2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  PERMISSION_CATALOG,
  permissionSlug,
  type PermissionDomain,
  type PermissionKey,
} from '@/lib/permissions/catalog';
import {
  DEFAULT_TOKEN_GRANT,
  GRANTABLE_PERMISSIONS,
  IRREVERSIBLE_PERMISSIONS,
  type TokenGrant,
} from '@/lib/tokens/grant';

// Presentation for the token GRANT (Story MOTIR-2572 · Subtask MOTIR-2579),
// replacing the six-entry `scopeMeta.tsx`. Shared by the three surfaces that
// show what a token may do — the create-modal picker, the token-list row, and
// the `/device` approval screen — so they cannot describe one grant in three
// different sets of words.
//
// ⚠️ IT WRITES NO COPY. The label and description of every row come from the
// SHIPPED `permissions.<slug>.label` / `.description` keys — the same strings
// the Roles & permissions screens render, already translated. A token picker
// with its own wording for the same thirty-one permissions would be a second
// source of truth for meaning, which is the drift the shared table exists to
// prevent, one level up.
//
// What this module DOES own is what the catalog does not carry: the per-domain
// glyph, the irreversible flag, and the row order.

/** One grantable permission, as a surface renders it. */
export interface PermissionMeta {
  key: PermissionKey;
  domain: PermissionDomain;
  /** i18n key for the human label — `permissions.<slug>.label`. */
  labelKey: string;
  /** i18n key for the one-line description — `permissions.<slug>.description`. */
  descriptionKey: string;
  Icon: LucideIcon;
  /** An irreversible key: its own rose danger row, withheld by default. */
  danger?: boolean;
}

/**
 * The glyph per DOMAIN, not per key — the one presentational fact the catalog
 * does not carry. Keyed by domain so a permission added to an existing domain
 * inherits an icon instead of rendering blank, which is the failure mode a
 * per-key map has the first time the catalog grows.
 */
const DOMAIN_ICON: Partial<Record<PermissionDomain, LucideIcon>> = {
  project: Eye,
  work_item: SquarePen,
  comment: MessageSquare,
  sprint: Zap,
  ai: Sparkles,
};

/** The irreversible key gets its own glyph — it is the one row a reader must
 *  not mistake for its neighbours. */
const KEY_ICON: Partial<Record<PermissionKey, LucideIcon>> = {
  'work_item:delete': Trash2,
};

/**
 * Every GRANTABLE permission, in catalog order, ready to render.
 *
 * Derived from `GRANTABLE_PERMISSIONS` rather than listed, so a permission can
 * only reach the picker by having a token-reachable operation behind it — and a
 * key added to the catalog appears here the moment an operation asserts it,
 * with no edit to this file.
 */
export const PERMISSION_META: PermissionMeta[] = GRANTABLE_PERMISSIONS.map((key) => {
  const descriptor = PERMISSION_CATALOG[key];
  return {
    key,
    domain: descriptor.domain,
    labelKey: descriptor.labelKey,
    descriptionKey: descriptor.descriptionKey,
    Icon: KEY_ICON[key] ?? DOMAIN_ICON[descriptor.domain] ?? Eye,
    ...(IRREVERSIBLE_PERMISSIONS.includes(key) ? { danger: true as const } : {}),
  };
});

const META_BY_KEY = new Map<PermissionKey, PermissionMeta>(PERMISSION_META.map((m) => [m.key, m]));

/** The i18n key for a DOMAIN heading — `permissions.domain.<domain>`. */
export function domainLabelKey(domain: PermissionDomain): string {
  return `domain.${domain}`;
}

/** The i18n leaf for a permission, under the `permissions` namespace. */
export function permissionLabelKeys(key: PermissionKey): { label: string; description: string } {
  const slug = permissionSlug(key);
  return { label: `${slug}.label`, description: `${slug}.description` };
}

/**
 * The grantable permissions GROUPED BY DOMAIN, in catalog order, with empty
 * domains dropped — the picker's two-column layout renders these as units.
 *
 * The grouping is the CATALOG's, not an invented one: the design (MOTIR-2578)
 * settled that the token screen must not teach a second way to organise the
 * same permissions the Roles & permissions screen already groups.
 */
export function permissionsByDomainForTokens(): {
  domain: PermissionDomain;
  permissions: PermissionMeta[];
}[] {
  const groups = new Map<PermissionDomain, PermissionMeta[]>();
  for (const meta of PERMISSION_META) {
    const list = groups.get(meta.domain) ?? [];
    list.push(meta);
    groups.set(meta.domain, list);
  }
  return [...groups.entries()].map(([domain, permissions]) => ({ domain, permissions }));
}

/** A granted permission's metadata, in catalog order — the list detail's chips. */
export function grantedPermissionMeta(grant: TokenGrant): PermissionMeta[] {
  const held = new Set(grant);
  return PERMISSION_META.filter((m) => held.has(m.key));
}

/**
 * Whether the grant includes an irreversible key.
 *
 * The list surfaces this with a persistent rose "Can delete" pill and NEVER
 * folds it into a summary word: a dangerous grant that a reader has to expand a
 * row to discover is a dangerous grant they will not discover.
 */
export function grantsDelete(grant: TokenGrant): boolean {
  return IRREVERSIBLE_PERMISSIONS.some((key) => grant.includes(key));
}

export type GrantSummary = 'full' | 'standard' | 'readonly' | 'custom';

const ALL_COUNT = GRANTABLE_PERMISSIONS.length;
const DEFAULT_SET = new Set<PermissionKey>(DEFAULT_TOKEN_GRANT);

/**
 * Classify a grant SEMANTICALLY — Yue reads meaning, not `5 of 6`.
 *
 *   * `full`     — everything, the irreversible key included
 *   * `standard` — the default grant (everything except the irreversible key)
 *   * `readonly` — `project:browse` alone
 *   * `custom`   — any other subset
 *
 * KEPT rather than re-decided at the new cardinality (MOTIR-2578): at six keys a
 * row could nearly list them, but a cell that grows with the catalog breaks the
 * day the catalog grows, and these four words read correctly over the new set.
 */
export function summarizeGrant(grant: TokenGrant): GrantSummary {
  const set = new Set(grant);
  if (set.size === ALL_COUNT) return 'full';
  if (set.size === 1 && set.has('project:browse')) return 'readonly';
  if (set.size === DEFAULT_SET.size && [...set].every((k) => DEFAULT_SET.has(k))) {
    return 'standard';
  }
  return 'custom';
}

export { META_BY_KEY };
