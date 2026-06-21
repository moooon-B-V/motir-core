// The pre-plan REVISION view-model — the consumer-side (motir-core) helpers the
// revise/diff/cascade-back UI (Subtask 7.3.71 / MOTIR-1179) renders the read
// seam's (7.3.70) forward revision log + per-revision diffs with. It is PURE (no
// React, no fetch, no DOM) so the whole parsing/selecting layer is unit-testable.
//
// The diffs are COMPUTED upstream (motir-ai 7.3.24 `diffDoc`, persisted by 7.3.25)
// and passed through the read seam VERBATIM as the opaque `diff: unknown` field —
// motir-core NEVER recomputes them. This module only narrows that opaque payload
// into a renderable shape (defensively — motir-ai owns the wire shape, so a
// malformed/absent diff yields an empty change list, never a throw) and turns the
// raw paths/values into founder-readable strings.

import type { PreplanRevisionDTO, PreplanStateDTO } from '@/lib/dto/aiPreplan';
import { type DirectionDocKind, DIRECTION_DOC_ORDER } from './directionDoc';

// ── The diff shape (mirror of motir-ai `DocDiff`, src/llm/docDiff.ts) ─────────
// Re-declared on the consumer side because the DTO carries it as opaque `unknown`
// (motir-core does not import motir-ai). A flat list of leaf changes, each with a
// dotted/bracketed PATH into the structured doc and the before/after values.

export type DocDiffKind = 'added' | 'removed' | 'changed';

export interface DocDiffEntry {
  /** The dotted/bracketed path to the changed node, e.g. `mvpScope.deferrals[0].whyCut`. */
  path: string;
  kind: DocDiffKind;
  /** The previous value (absent for `added`). */
  before?: unknown;
  /** The revised value (absent for `removed`). */
  after?: unknown;
}

const DIFF_KINDS = new Set<DocDiffKind>(['added', 'removed', 'changed']);

/**
 * Narrow the opaque `diff` payload from a revision log entry into a renderable
 * `DocDiffEntry[]`. Defensive by contract: a non-array, or any entry missing a
 * recognised `kind`, is dropped — a malformed diff renders as "no changes", never
 * a crash. `before`/`after` are preserved only when actually present (so `added`
 * has no `before` and `removed` has no `after`, mirroring `diffDoc`).
 */
export function parseDocDiff(diff: unknown): DocDiffEntry[] {
  if (!Array.isArray(diff)) return [];
  const out: DocDiffEntry[] = [];
  for (const raw of diff) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.kind !== 'string' || !DIFF_KINDS.has(o.kind as DocDiffKind)) continue;
    out.push({
      path: typeof o.path === 'string' ? o.path : '',
      kind: o.kind as DocDiffKind,
      ...('before' in o ? { before: o.before } : {}),
      ...('after' in o ? { after: o.after } : {}),
    });
  }
  return out;
}

// ── changeKind ────────────────────────────────────────────────────────────────
// The persisted `changeKind` motir-ai writes (saveDoc): the create path is
// `created` (the v1 baseline, `diff` null); a revision is `direct` (the conductor
// attributed the reaction to this tier — the earliest changed) or `cascade`
// (re-derived because an upstream tier changed). The UI labels these; an
// unexpected value maps to `other` so it still renders legibly.

export type RevisionKind = 'created' | 'direct' | 'cascade' | 'other';

export function normalizeRevisionKind(changeKind: string | null): RevisionKind {
  switch (changeKind) {
    case 'created':
      return 'created';
    case 'direct':
      return 'direct';
    case 'cascade':
      return 'cascade';
    default:
      return 'other';
  }
}

// ── Path + value humanizing (for the diff rows) ──────────────────────────────

/**
 * Turn a DocDiff path (`mvpScope.deferrals[0].whyCut`) into a readable trail
 * ("MVP scope › Deferrals › 1 › Why cut"): split on dots, lift bracket indices
 * to their own 1-indexed segment, and de-camelCase each name. Empty path → "".
 */
export function humanizePath(path: string): string {
  if (!path) return '';
  const segments: string[] = [];
  for (const part of path.split('.')) {
    const m = part.match(/^([^[]*)((?:\[\d+\])*)$/);
    const name = m ? m[1]! : part;
    if (name) segments.push(deCamel(name));
    const brackets = m?.[2] ?? '';
    for (const n of brackets.matchAll(/\[(\d+)\]/g)) {
      segments.push(String(Number(n[1]) + 1)); // 1-index array positions for humans
    }
  }
  return segments.join(' › ');
}

function deCamel(s: string): string {
  const spaced = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

/**
 * Render a diff before/after VALUE as a short single-line string. Scalars pass
 * through; arrays/objects summarise structurally (so a nested change reads as a
 * compact label, not a JSON dump); null/undefined read as an em dash. Clamped to
 * `max` chars with an ellipsis.
 */
export function formatDiffValue(value: unknown, max = 160): string {
  if (value === undefined || value === null) return '—';
  let s: string;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
  else if (Array.isArray(value)) s = `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  else if (typeof value === 'object') s = `{${Object.keys(value as object).join(', ')}}`;
  else s = String(value);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── Per-kind revision-log selectors ──────────────────────────────────────────

export type RevisionsByKind = Partial<Record<DirectionDocKind, PreplanRevisionDTO[]>>;

/**
 * Project the read-seam DTO's per-artifact revision logs into a by-kind map,
 * each NEWEST-FIRST (the order the log viewer renders + the latest-revision diff
 * the gate surfaces both read from). Forward-only: the log is never reordered
 * across a re-fetch — only sorted for display.
 */
export function mapRevisions(dto: PreplanStateDTO): RevisionsByKind {
  const out: RevisionsByKind = {};
  for (const doc of dto.docs) {
    out[doc.kind] = [...doc.versions].sort((a, b) => b.version - a.version);
  }
  return out;
}

/**
 * The newest entry of a tier's log IF it represents an actual revision (version
 * &gt; 1) — the "what just changed" the gate displays prominently. Null for a
 * baseline-only tier (nothing has changed yet). Accepts the log in any order.
 */
export function latestRevision(
  versions: PreplanRevisionDTO[] | undefined,
): PreplanRevisionDTO | null {
  if (!versions || versions.length === 0) return null;
  const newest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  return newest.version > 1 ? newest : null;
}

/** Whether a tier's log has any revision beyond the baseline (drives the log viewer). */
export function hasRevisionHistory(versions: PreplanRevisionDTO[] | undefined): boolean {
  return !!versions && versions.some((v) => v.version > 1);
}

/** Journey order index of a tier (for "is the cascade routing taking us BACK?"). */
export function tierOrder(kind: DirectionDocKind): number {
  return DIRECTION_DOC_ORDER.indexOf(kind);
}
