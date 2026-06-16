import { Archive, Eye, Plug, SquarePen, Trash2, Zap, type LucideIcon } from 'lucide-react';
import { DEFAULT_TOKEN_SCOPES, type TokenScope } from '@/lib/mcp/scopes';

// Plain-language presentation metadata for the 6 token scopes (Story 7.7 ·
// Subtask 7.7.19, per the 7.7.18 design). The 7.7.16 `lib/mcp/scopes` module
// owns the canonical scope KEYS + the default-all-minus-delete set; this module
// owns their UI face — i18n label key, group, lucide glyph, and the delete
// danger flag — shared by the create-modal Permissions picker AND the token
// list's granted-scope display so the two never drift. Labels/descriptions
// themselves live in `settings.apiTokens.scopes.*` (never the raw
// `work_items:write` string — written for Yue's non-developer acceptance,
// Principle #18).

/** The capability groups the modal lays out across its two columns. */
export type ScopeGroup = 'read' | 'sprints' | 'integrations' | 'workItems';

export interface ScopeMeta {
  scope: TokenScope;
  /** i18n leaf under `settings.apiTokens.scopes` (`{i18nKey}.name` / `.desc`). */
  i18nKey: string;
  group: ScopeGroup;
  Icon: LucideIcon;
  /** The single irreversible scope — its own rose danger row, off by default. */
  danger?: boolean;
}

/** The 6 scopes in canonical display order (7.7.18): Read · Manage sprints ·
 * Connect integrations · Edit · Archive · Delete (danger). The list detail
 * renders granted scopes in this order; the modal groups them by column. */
export const SCOPE_META: ScopeMeta[] = [
  { scope: 'read', i18nKey: 'read', group: 'read', Icon: Eye },
  { scope: 'sprints:write', i18nKey: 'sprintsWrite', group: 'sprints', Icon: Zap },
  { scope: 'integration', i18nKey: 'integration', group: 'integrations', Icon: Plug },
  { scope: 'work_items:write', i18nKey: 'workItemsWrite', group: 'workItems', Icon: SquarePen },
  { scope: 'work_items:archive', i18nKey: 'workItemsArchive', group: 'workItems', Icon: Archive },
  {
    scope: 'work_items:delete',
    i18nKey: 'workItemsDelete',
    group: 'workItems',
    Icon: Trash2,
    danger: true,
  },
];

const META_BY_KEY = new Map<TokenScope, ScopeMeta>(SCOPE_META.map((m) => [m.scope, m]));

/** The scopes of one group, in canonical order — the modal renders a group as a
 * unit (Read / Sprints / Integrations in the left column, Work items right). */
export function scopesInGroup(group: ScopeGroup): ScopeMeta[] {
  return SCOPE_META.filter((m) => m.group === group);
}

/** A granted scope's metadata in canonical order — the list detail's chips. */
export function grantedScopeMeta(scopes: TokenScope[]): ScopeMeta[] {
  const granted = new Set(scopes);
  return SCOPE_META.filter((m) => granted.has(m.scope));
}

export const DELETE_SCOPE: TokenScope = 'work_items:delete';

/** Whether the grant includes the irreversible delete scope — the list always
 * surfaces this with a persistent rose "Can delete" pill (never hidden behind a
 * summary). */
export function grantsDelete(scopes: TokenScope[]): boolean {
  return scopes.includes(DELETE_SCOPE);
}

export type ScopeSummary = 'full' | 'standard' | 'readonly' | 'custom';

const ALL_COUNT = SCOPE_META.length;
const DEFAULT_SET = new Set<TokenScope>(DEFAULT_TOKEN_SCOPES);

/** Classify a grant SEMANTICALLY (Yue reads meaning, not `5 of 6` — 7.7.18):
 *  - `full` — all 6 incl. delete
 *  - `standard` — the default set (all minus delete)
 *  - `readonly` — `read` alone
 *  - `custom` — any other subset. */
export function summarizeScopes(scopes: TokenScope[]): ScopeSummary {
  const set = new Set(scopes);
  if (set.size === ALL_COUNT) return 'full';
  if (set.size === 1 && set.has('read')) return 'readonly';
  if (set.size === DEFAULT_SET.size && [...set].every((s) => DEFAULT_SET.has(s))) {
    return 'standard';
  }
  return 'custom';
}

export { META_BY_KEY };
