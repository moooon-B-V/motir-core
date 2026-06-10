// The diff-renderer registry (Story 5.5 · Subtask 5.5.1) — the single source
// of truth for what every `work_item_revision.diff` key means to the History
// feed. Per the mistake-#29 lesson the registry is TOTAL BY CONSTRUCTION over
// an OPEN key set: every key the codebase writes today has an explicit entry
// (renderable or suppressed — suppression is a decision, never an accident),
// and any key it doesn't know falls through to the generic renderer — a
// legible "changed <key>" entry, never a throw, never a silent drop. The
// totality-guard test (tests/work-items/activity-registry-totality.test.ts)
// scans the services' recordRevision call sites and fails when a sibling
// story lands a key with no explicit disposition, forcing the
// renderable-vs-suppressed decision instead of letting the fallback absorb it
// unnoticed.
//
// Two-phase contract (how the service keeps resolution batched, no N+1):
//   1. `collectDiffRefs` walks a page's diffs and gathers every referenced id
//      (users / status keys / sprints / issues) WITHOUT touching the DB.
//   2. The service resolves all refs in one batched lookup set, builds a
//      DisplayResolvers, and `buildEntryParts` renders each revision from the
//      in-memory maps.
// Renderers therefore do no I/O — they are pure (diff value, resolvers) →
// parts functions, unit-testable without a database.

import type { ActivityEntryPartDto, ActivityValueDto } from '@/lib/dto/activity';

/** The `{ from, to }` cell every scalar diff key carries. */
interface DiffCell {
  from: unknown;
  to: unknown;
}

/** Ids a page of diffs references, gathered before the batched lookups. */
export interface DiffRefs {
  users: Set<string>;
  statuses: Set<string>;
  sprints: Set<string>;
  issues: Set<string>;
}

/** The user-shaped display value (narrowed so the actor needs no re-check). */
export type ActivityUserValue = Extract<ActivityValueDto, { type: 'user' }>;

/**
 * The in-memory resolution maps the service builds from ONE batched lookup
 * set per page. Each resolver returns the typed display value, degrading to
 * a null display field (stored id kept) when the referent no longer exists.
 */
export interface DisplayResolvers {
  user(id: string): ActivityUserValue;
  status(key: string): ActivityValueDto;
  sprint(id: string): ActivityValueDto;
  issue(id: string): ActivityValueDto;
}

type RefCollector = (value: unknown, refs: DiffRefs) => void;
type PartRenderer = (key: string, value: unknown, r: DisplayResolvers) => ActivityEntryPartDto[];

type RegistryEntry =
  | { disposition: 'suppressed' }
  | { disposition: 'renderable'; collectRefs?: RefCollector; render: PartRenderer };

// ---------------------------------------------------------------------------
// Value helpers — defensive by design. A diff value is attacker-shaped as far
// as the renderer is concerned (it round-trips through a JSON column and is
// written by call sites this subtask doesn't own), so every accessor
// tolerates a malformed shape and degrades to the generic form.
// ---------------------------------------------------------------------------

/** Cap for stringified unknown values so a pathological blob can't flood the feed. */
const MAX_GENERIC_LENGTH = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A `{ from, to }` cell, or null when the value isn't one. */
function asCell(value: unknown): DiffCell | null {
  if (!isRecord(value)) return null;
  if (!('from' in value) || !('to' in value)) return null;
  return { from: value['from'], to: value['to'] };
}

/** Safe, bounded display string for an arbitrary JSON value. */
function safeString(v: unknown): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else {
    try {
      s = JSON.stringify(v) ?? '';
    } catch {
      s = '';
    }
  }
  return s.length > MAX_GENERIC_LENGTH ? `${s.slice(0, MAX_GENERIC_LENGTH)}…` : s;
}

/** `null`/`undefined` → "None" side; everything else → bounded string. */
function safeStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : safeString(v);
}

function noneOr(v: unknown, build: (present: unknown) => ActivityValueDto): ActivityValueDto {
  return v === null || v === undefined ? { type: 'none' } : build(v);
}

function textValue(v: unknown): ActivityValueDto {
  return noneOr(v, (p) => ({ type: 'text', text: safeString(p) }));
}

function dateValue(v: unknown): ActivityValueDto {
  return noneOr(v, (p) =>
    typeof p === 'string' ? { type: 'date', date: p } : { type: 'text', text: safeString(p) },
  );
}

/** The total fallback — ALSO the renderer behind unknown keys (mistake #29). */
function genericPart(key: string, value: unknown): ActivityEntryPartDto {
  const cell = asCell(value);
  if (cell) {
    return {
      kind: 'generic',
      key,
      from: safeStringOrNull(cell.from),
      to: safeStringOrNull(cell.to),
    };
  }
  return { kind: 'generic', key, from: null, to: safeStringOrNull(value) };
}

// ---------------------------------------------------------------------------
// Shared renderer shapes
// ---------------------------------------------------------------------------

/** Scalar field rendered with plain text values (title, priority, kind, …). */
function textField(): RegistryEntry {
  return {
    disposition: 'renderable',
    render: (key, value) => {
      const cell = asCell(value);
      if (!cell) return [genericPart(key, value)];
      return [{ kind: 'field', field: key, from: textValue(cell.from), to: textValue(cell.to) }];
    },
  };
}

/** Body fields — "updated the Description", never the text itself. */
function editedField(): RegistryEntry {
  return {
    disposition: 'renderable',
    render: (key) => [{ kind: 'fieldEdited', field: key }],
  };
}

/** Date-valued scalar field (dueDate, archivedAt). */
function dateField(): RegistryEntry {
  return {
    disposition: 'renderable',
    render: (key, value) => {
      const cell = asCell(value);
      if (!cell) return [genericPart(key, value)];
      return [{ kind: 'field', field: key, from: dateValue(cell.from), to: dateValue(cell.to) }];
    },
  };
}

/** Field whose sides resolve through one of the batched lookup maps. */
function resolvedField(
  ref: keyof DiffRefs,
  resolve: (r: DisplayResolvers, id: string) => ActivityValueDto,
): RegistryEntry {
  const sideRefs = (cell: DiffCell): string[] =>
    [cell.from, cell.to].filter((s): s is string => typeof s === 'string');
  return {
    disposition: 'renderable',
    collectRefs: (value, refs) => {
      const cell = asCell(value);
      if (cell) for (const id of sideRefs(cell)) refs[ref].add(id);
    },
    render: (key, value, r) => {
      const cell = asCell(value);
      if (!cell) return [genericPart(key, value)];
      const side = (v: unknown): ActivityValueDto =>
        noneOr(v, (p) => (typeof p === 'string' ? resolve(r, p) : textValue(p)));
      return [{ kind: 'field', field: key, from: side(cell.from), to: side(cell.to) }];
    },
  };
}

/**
 * In-flight collection shape (attachments / labels / components — Stories
 * 5.2 / 5.4): `{ added: [...] }` / `{ removed: [...] }`. Elements render by
 * their `name` / `title` / `label` property when present, else the bounded
 * string form. Registered ahead of the sibling merges so the keys land with
 * a disposition; a shape mismatch degrades to the generic part.
 */
function collectionField(): RegistryEntry {
  const itemLabel = (el: unknown): string => {
    if (isRecord(el)) {
      for (const prop of ['name', 'title', 'label']) {
        const candidate = el[prop];
        if (typeof candidate === 'string') return candidate;
      }
    }
    return safeString(el);
  };
  return {
    disposition: 'renderable',
    render: (key, value) => {
      if (!isRecord(value)) return [genericPart(key, value)];
      const parts: ActivityEntryPartDto[] = [];
      for (const op of ['added', 'removed'] as const) {
        const items = value[op];
        if (Array.isArray(items) && items.length > 0) {
          parts.push({ kind: 'collection', field: key, op, items: items.map(itemLabel) });
        }
      }
      return parts.length > 0 ? parts : [genericPart(key, value)];
    },
  };
}

// ---------------------------------------------------------------------------
// The registry — every key of the plan-time call-site audit (2026-06-10),
// each with an explicit disposition.
// ---------------------------------------------------------------------------

/**
 * Keys that NEVER produce a feed entry (Jira shows no board-reorder noise in
 * History): pure `position` / `backlogRank` writes and the denormalised
 * `key` / `identifier` columns the create path snapshots. The trail keeps the
 * rows; the feed hides them. Living IN the registry keeps suppression total
 * — the count predicate (`countDisplayableByWorkItem`) and the page filter
 * read this same list, so they can never disagree.
 */
export const SUPPRESSED_DIFF_KEYS = ['position', 'backlogRank', 'key', 'identifier'] as const;

const suppressed: RegistryEntry = { disposition: 'suppressed' };

const linksEntry: RegistryEntry = {
  disposition: 'renderable',
  collectRefs: (value, refs) => {
    if (!isRecord(value)) return;
    for (const op of ['added', 'removed'] as const) {
      const items = value[op];
      if (!Array.isArray(items)) continue;
      for (const el of items) {
        if (isRecord(el) && typeof el['toId'] === 'string') refs.issues.add(el['toId']);
      }
    }
  },
  render: (key, value, r) => {
    if (!isRecord(value)) return [genericPart(key, value)];
    const parts: ActivityEntryPartDto[] = [];
    for (const op of ['added', 'removed'] as const) {
      const items = value[op];
      if (!Array.isArray(items)) continue;
      for (const el of items) {
        if (!isRecord(el) || typeof el['toId'] !== 'string') {
          parts.push(genericPart(key, el));
          continue;
        }
        parts.push({
          kind: 'link',
          op,
          linkKind: typeof el['kind'] === 'string' ? el['kind'] : 'relates_to',
          target: r.issue(el['toId']),
        });
      }
    }
    return parts.length > 0 ? parts : [genericPart(key, value)];
  },
};

/**
 * The 5.1.2 comment-deletion record (changeKind `comment_deleted`, diff
 * `{ comment: { from: { commentId, authorId, replyCount }, to: null } }`) —
 * who deleted whose comment + the reply count, NEVER the content (the
 * verified Jira rule: History shows deletions, content is gone).
 */
const commentEntry: RegistryEntry = {
  disposition: 'renderable',
  collectRefs: (value, refs) => {
    const cell = asCell(value);
    if (cell && isRecord(cell.from) && typeof cell.from['authorId'] === 'string') {
      refs.users.add(cell.from['authorId']);
    }
  },
  render: (key, value, r) => {
    const cell = asCell(value);
    if (!cell || !isRecord(cell.from) || typeof cell.from['authorId'] !== 'string') {
      return [genericPart(key, value)];
    }
    const replyCount = cell.from['replyCount'];
    return [
      {
        kind: 'commentDeleted',
        author: r.user(cell.from['authorId']),
        replyCount: typeof replyCount === 'number' ? replyCount : 0,
      },
    ];
  },
};

/** Exact-match dispositions. */
const REGISTRY: Record<string, RegistryEntry> = {
  // -- suppressed (the explicit noise policy) ------------------------------
  position: suppressed,
  backlogRank: suppressed,
  key: suppressed,
  identifier: suppressed,
  // -- plain scalar fields -------------------------------------------------
  title: textField(),
  kind: textField(),
  priority: textField(),
  explanationSource: textField(),
  estimateMinutes: textField(),
  storyPoints: textField(),
  projectId: textField(),
  // -- body fields: edit recorded, content never inlined --------------------
  descriptionMd: editedField(),
  explanationMd: editedField(),
  // -- resolved fields (batched display lookups) ----------------------------
  status: resolvedField('statuses', (r, key) => r.status(key)),
  assigneeId: resolvedField('users', (r, id) => r.user(id)),
  reporterId: resolvedField('users', (r, id) => r.user(id)),
  sprintId: resolvedField('sprints', (r, id) => r.sprint(id)),
  parentId: resolvedField('issues', (r, id) => r.issue(id)),
  // -- date fields ----------------------------------------------------------
  dueDate: dateField(),
  archivedAt: dateField(),
  // -- composite shapes ------------------------------------------------------
  links: linksEntry,
  comment: commentEntry,
  // -- in-flight 5.2 / 5.4 collection shapes (registered ahead of merge) ----
  attachments: collectionField(),
  labels: collectionField(),
  components: collectionField(),
};

/**
 * Prefix-matched dispositions for dynamic key families. `customFields.<key>`
 * (Story 5.3, in flight) renders as a text field for now; the definition /
 * option-label resolution upgrades once the 5.3 reads merge — until then the
 * stored values display in their raw form, which is the documented fallback,
 * not a crash or a drop.
 */
const PREFIX_REGISTRY: ReadonlyArray<{ prefix: string; entry: RegistryEntry }> = [
  { prefix: 'customFields.', entry: textField() },
];

const GENERIC_ENTRY: RegistryEntry = {
  disposition: 'renderable',
  render: (key, value) => [genericPart(key, value)],
};

/**
 * The total lookup: exact entry, else prefix entry, else the generic
 * fallback. NEVER returns undefined — that is the registry's whole contract.
 */
export function dispositionFor(key: string): RegistryEntry {
  const exact = REGISTRY[key];
  if (exact) return exact;
  const byPrefix = PREFIX_REGISTRY.find((p) => key.startsWith(p.prefix));
  if (byPrefix) return byPrefix.entry;
  return GENERIC_ENTRY;
}

/** True when the key has an explicit (non-fallback) disposition. */
export function isRegisteredDiffKey(key: string): boolean {
  return key in REGISTRY || PREFIX_REGISTRY.some((p) => key.startsWith(p.prefix));
}

function isSuppressedKey(key: string): boolean {
  return dispositionFor(key).disposition === 'suppressed';
}

/** Anchor changeKinds that render regardless of (and instead of) the diff. */
const ANCHOR_KINDS = new Set(['created', 'archived']);

function diffKeysOf(diff: unknown): string[] {
  return isRecord(diff) ? Object.keys(diff) : [];
}

/**
 * Whether a revision produces a feed entry at all. Anchor kinds always do;
 * anything else needs at least one non-suppressed diff key. MUST stay in
 * lockstep with `countDisplayableByWorkItem`'s SQL predicate — both read
 * their key lists from this module.
 */
export function isDisplayableRevision(changeKind: string, diff: unknown): boolean {
  if (ANCHOR_KINDS.has(changeKind)) return true;
  return diffKeysOf(diff).some((k) => !isSuppressedKey(k));
}

/** Phase 1 — gather every id a revision's diff references (no I/O). */
export function collectDiffRefs(changeKind: string, diff: unknown, refs: DiffRefs): void {
  if (ANCHOR_KINDS.has(changeKind)) return;
  if (!isRecord(diff)) return;
  for (const [key, value] of Object.entries(diff)) {
    const entry = dispositionFor(key);
    if (entry.disposition === 'renderable') entry.collectRefs?.(value, refs);
  }
}

export function emptyDiffRefs(): DiffRefs {
  return { users: new Set(), statuses: new Set(), sprints: new Set(), issues: new Set() };
}

/**
 * Phase 2 — render a revision's parts from the resolved maps. `created` /
 * `archived` render as their anchor part ("created the issue") rather than a
 * 17-field dump; every other kind walks the diff through the registry, drops
 * suppressed keys, and keeps the renderable remainder (mixed diffs render
 * partially). Returns [] only for a non-displayable revision.
 */
export function buildEntryParts(
  changeKind: string,
  diff: unknown,
  resolvers: DisplayResolvers,
): ActivityEntryPartDto[] {
  if (changeKind === 'created') return [{ kind: 'created' }];
  if (changeKind === 'archived') return [{ kind: 'archived' }];
  const parts: ActivityEntryPartDto[] = [];
  if (!isRecord(diff)) return parts;
  for (const [key, value] of Object.entries(diff)) {
    const entry = dispositionFor(key);
    if (entry.disposition === 'suppressed') continue;
    parts.push(...entry.render(key, value, resolvers));
  }
  return parts;
}
