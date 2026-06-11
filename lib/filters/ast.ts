// The FilterAST (Story 6.1 · Subtask 6.1.1) — the single interchange shape of
// the advanced filter builder: the builder UI edits it, the versioned URL
// param carries it (THE serialization Story 6.2 persists as saved filters),
// and the repository compiler turns it into a parameterized WHERE fragment.
// ONE level only — `combinator` over flat rows; nested condition groups are
// the documented extension (groups are where a builder becomes a parser).
//
// Kept pure (no React, no Prisma) like its 2.5.4 sibling
// `lib/issues/issueListFilter.ts` — unit-tested in isolation, importable from
// both the Server Component read path and the client builder.

import type { IssueFilter } from '@/lib/issues/issueListFilter';
import { UNASSIGNED_TOKEN } from '@/lib/issues/issueListFilter';

/** The flat AND/OR over the rows — "Match all" / "Match any". */
export type FilterCombinator = 'and' | 'or';

/** The registered built-in field ids (Subtask 6.1.1 scope — everything
 * shipped today; 6.1.2 adds the Epic-5 fields through the registry). */
export type FilterFieldId =
  | 'kind'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'reporter'
  | 'sprint'
  | 'text'
  | 'created'
  | 'updated'
  | 'due'
  | 'storyPoints'
  | 'estimate';

/** Every operator any field type offers (per-field sets live in the registry). */
export type FilterOperatorId =
  // enum-ish fields
  | 'is_any_of'
  | 'is_none_of'
  | 'is_empty'
  | 'is_not_empty'
  // text
  | 'contains'
  | 'not_contains'
  // numbers
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  // dates
  | 'on_or_before'
  | 'on_or_after'
  | 'between'
  | 'in_last_days'
  | 'in_next_days';

/**
 * A condition's value, by operator arity: a value list (enum ops), a string
 * (text ops / single dates as `YYYY-MM-DD`), a number (comparisons / day
 * windows), a `[from, to]` date pair (`between`), or null (the zero-arity
 * empty/not-empty ops).
 */
export type FilterConditionValue = string[] | string | number | [string, string] | null;

export interface FilterCondition {
  field: FilterFieldId;
  operator: FilterOperatorId;
  value: FilterConditionValue;
}

export interface FilterAst {
  combinator: FilterCombinator;
  conditions: FilterCondition[];
}

/** The row cap — the over-long-filter sanity guard the story pins. */
export const FILTER_ROW_CAP = 20;

/** The empty-bucket sentinel an assignee value list may carry ("Unassigned" —
 * the Jira basic facet has the same option; also what makes the 2.5.4 facet
 * upgrade lossless). Re-exported from the facet module so the two stay one
 * token. */
export const FILTER_UNASSIGNED_TOKEN = UNASSIGNED_TOKEN;

/** The sprint value list's empty-bucket sentinel ("Backlog" — no sprint). */
export const FILTER_BACKLOG_TOKEN = 'backlog';

export const FILTER_PARAM = 'filter';
export const FILTER_PARAM_VERSION = 'v1';

// ---------------------------------------------------------------------------
// The versioned URL codec — `?filter=v1:<compact-json-base64url>`
// ---------------------------------------------------------------------------
//
// Compact wire form: `{ "c": "and" | "or", "f": [[field, operator, value]…] }`
// — tuples, not objects, to keep shared URLs short. base64url (no padding) so
// the param needs no percent-encoding. Decoding NEVER throws: a malformed /
// foreign / over-cap / structurally-invalid param yields a typed, recoverable
// failure state the page renders as "invalid filter" instead of crashing
// (deep validation against the registry — operator sets, value shapes — is
// `validateFilterAst`'s job in lib/filters/registry.ts; the codec owns
// structure + version only, so the two layers report at the right altitude).

export type FilterDecodeResult =
  | { ok: true; ast: FilterAst }
  | { ok: false; reason: 'malformed' | 'unsupported-version' | 'invalid'; detail: string };

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Serialize an AST into the `?filter=` param value. */
export function encodeFilterParam(ast: FilterAst): string {
  const compact = {
    c: ast.combinator,
    f: ast.conditions.map((row) => [row.field, row.operator, row.value]),
  };
  return `${FILTER_PARAM_VERSION}:${toBase64Url(JSON.stringify(compact))}`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isWireValue(v: unknown): v is FilterConditionValue {
  if (v === null) return true;
  if (typeof v === 'string' || typeof v === 'number')
    return typeof v !== 'number' || Number.isFinite(v);
  return isStringArray(v);
}

/**
 * Type the compact wire form (`{ c, f }`) into an AST — the structural half
 * both carriers share (the URL param after base64/JSON peeling, the stored
 * envelope after its version check). Field/operator ids and value SHAPES are
 * checked just enough to type the rows (`string` ids, a wire-representable
 * value); whether the ids exist and the values satisfy their (field,
 * operator) arity is the registry's `validateFilterAst`.
 */
function decodeCompactForm(parsed: unknown): FilterDecodeResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid', detail: 'not an object' };
  }
  const { c, f } = parsed as { c?: unknown; f?: unknown };
  if (c !== 'and' && c !== 'or') return { ok: false, reason: 'invalid', detail: 'bad combinator' };
  if (!Array.isArray(f)) return { ok: false, reason: 'invalid', detail: 'rows not an array' };
  if (f.length > FILTER_ROW_CAP) {
    return { ok: false, reason: 'invalid', detail: `over the ${FILTER_ROW_CAP}-row cap` };
  }

  const conditions: FilterCondition[] = [];
  for (const row of f) {
    if (!Array.isArray(row) || row.length !== 3) {
      return { ok: false, reason: 'invalid', detail: 'bad row shape' };
    }
    const [field, operator, value] = row as [unknown, unknown, unknown];
    if (typeof field !== 'string' || typeof operator !== 'string' || !isWireValue(value)) {
      return { ok: false, reason: 'invalid', detail: 'bad row shape' };
    }
    conditions.push({
      field: field as FilterFieldId,
      operator: operator as FilterOperatorId,
      value,
    });
  }
  return { ok: true, ast: { combinator: c, conditions } };
}

/**
 * Parse a `?filter=` param value. Structure + version only — deep validation
 * against the registry (operator sets, value arity) is `validateFilterAst`'s
 * job, which the read path runs next and whose typed errors the caller maps
 * to the same recoverable "invalid filter" state.
 */
export function decodeFilterParam(raw: string): FilterDecodeResult {
  const sep = raw.indexOf(':');
  if (sep < 0) return { ok: false, reason: 'malformed', detail: 'missing version prefix' };
  const version = raw.slice(0, sep);
  if (version !== FILTER_PARAM_VERSION) {
    return { ok: false, reason: 'unsupported-version', detail: version };
  }
  const json = fromBase64Url(raw.slice(sep + 1));
  if (json === null) return { ok: false, reason: 'malformed', detail: 'not base64url' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed', detail: 'not JSON' };
  }
  return decodeCompactForm(parsed);
}

// ---------------------------------------------------------------------------
// The stored-envelope codec — the SECOND carrier (Story 6.2 saved filters)
// ---------------------------------------------------------------------------
//
// A saved filter persists the SAME compact wire form the URL param carries,
// as JSONB instead of base64url: `{ v: 'v1', c, f }` — the version moves from
// the string prefix into a field, everything else is byte-for-byte the
// codec's shape ("one codec, two carriers"). Decoding NEVER throws: a
// hand-corrupted or future-versioned stored envelope yields the same typed,
// recoverable FilterDecodeResult the URL path yields, which the resolve read
// surfaces as a designed degraded state instead of a crash.

/** The JSONB shape a `saved_filter.ast_envelope` column stores. */
export interface FilterEnvelope {
  v: string;
  c: FilterCombinator;
  f: Array<[string, string, FilterConditionValue]>;
}

/** Serialize an AST into the stored-envelope JSON (the `?filter=` param's
 * compact form with the version as a field). */
export function encodeFilterEnvelope(ast: FilterAst): FilterEnvelope {
  return {
    v: FILTER_PARAM_VERSION,
    c: ast.combinator,
    f: ast.conditions.map((row) => [row.field, row.operator, row.value]),
  };
}

/**
 * Parse a stored envelope (an `unknown` straight from JSONB). Structure +
 * version only, exactly like {@link decodeFilterParam} — the caller runs
 * `validateFilterAst` next and maps its typed errors to the same recoverable
 * state.
 */
export function decodeFilterEnvelope(raw: unknown): FilterDecodeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed', detail: 'not an object' };
  }
  const { v, ...compact } = raw as { v?: unknown; c?: unknown; f?: unknown };
  if (typeof v !== 'string') return { ok: false, reason: 'malformed', detail: 'missing version' };
  if (v !== FILTER_PARAM_VERSION) {
    return { ok: false, reason: 'unsupported-version', detail: v };
  }
  return decodeCompactForm(compact);
}

// ---------------------------------------------------------------------------
// The basic→advanced upgrade (the one-way conversion the mirror ships)
// ---------------------------------------------------------------------------

/**
 * Upgrade a 2.5.4 facet state into builder rows — LOSSLESS for every facet
 * combination: each multi-select facet becomes one `is_any_of` row (the
 * "Unassigned" bucket rides the assignee row as the sentinel token — the same
 * union the facet bar expresses), the text quick-filter becomes a `contains`
 * row, and the rows AND together (facets are AND-of-IN, exactly the
 * degenerate `match all` case). Complex builder states do NOT down-convert —
 * the mirror's one-way rule.
 */
export function facetFilterToAst(facets: IssueFilter): FilterAst {
  const conditions: FilterCondition[] = [];
  if (facets.kinds.length > 0) {
    conditions.push({ field: 'kind', operator: 'is_any_of', value: [...facets.kinds] });
  }
  if (facets.statuses.length > 0) {
    conditions.push({ field: 'status', operator: 'is_any_of', value: [...facets.statuses] });
  }
  if (facets.assigneeIds.length > 0 || facets.includeUnassigned) {
    const value = [...facets.assigneeIds];
    if (facets.includeUnassigned) value.push(FILTER_UNASSIGNED_TOKEN);
    conditions.push({ field: 'assignee', operator: 'is_any_of', value });
  }
  if (facets.text !== null) {
    conditions.push({ field: 'text', operator: 'contains', value: facets.text });
  }
  return { combinator: 'and', conditions };
}
