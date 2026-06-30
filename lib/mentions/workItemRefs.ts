// Work-item reference parsing (Story 5.8 · Subtask 5.8.2). A reference to
// ANOTHER work item serializes into stored Markdown as a durable token —
// `[<KEY>](motir:<workItemId>)` — exactly parallel to the user-mention token
// `[@Display Name](mention:<userId>)` that `lib/mentions/parse.ts` owns. The
// body stays plain Markdown (one storage format), renders as a live
// internal-link chip in MarkdownView (5.8.6), and is parseable server-side.
//
// A reference can also appear as a BARE project key the author just typed
// (`MOTIR-11`) — especially in the plain-text TITLE field, which has no editor
// and so no `@` picker. Both forms are extracted here.
//
// THIS helper is the server-side half: the work-items / comments service
// (5.8.3) extracts the referenced ids + keys from a body before resolving them
// to viewable work items and auto-creating the `relates_to` links. Pure string
// work — no Prisma, no IO — so it is unit-testable and importable anywhere.
// Key → id resolution (which needs the workspace/project + permission scope)
// is the service's job, NOT this module's.

/**
 * One work-item reference token: `[<KEY>](motir:<workItemId>)`. The bracket
 * label is the display key (anything up to the closing bracket); the payload
 * is the work-item cuid. Defined with `/g` for `matchAll` (which clones the
 * regex per call, so the shared constant carries no lastIndex state).
 */
export const WORKITEM_TOKEN_RE = /\[[^\]]*\]\(motir:([A-Za-z0-9_-]+)\)/g;

/**
 * A well-formed `motir:` href: the id is the cuid character set, non-empty —
 * mirrors WORKITEM_TOKEN_RE's payload group, and the render layer's
 * WORKITEM_HREF_RE (lib/markdown/render.tsx).
 */
export const WORKITEM_HREF_RE = /^motir:[A-Za-z0-9_-]+$/;

/** Escape a project identifier for safe interpolation into a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the bare-key matcher for a project. A work item's identifier is
 * `${project.identifier}-${number}` (lib/issues/aliasRedirect.ts), so a bare
 * reference is the project's prefix + `-` + digits, word-boundaried. The
 * prefix match is case-insensitive (a user may type `motir-11`); callers
 * canonicalise the capture to upper-case via {@link parseWorkItemRefs}.
 */
export function buildWorkItemKeyRe(projectIdentifier: string): RegExp {
  return new RegExp(`\\b${escapeRe(projectIdentifier)}-(\\d+)\\b`, 'gi');
}

/**
 * Extract the referenced work-item **ids** from a body — one per distinct id in
 * first-seen order. These come from explicit `motir:` tokens (the `@`-picker /
 * planner-emitted form). Malformed near-tokens (no `motir:` scheme, unclosed
 * bracket) simply don't match — they are body text, never an error.
 */
export function parseWorkItemTokenIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(WORKITEM_TOKEN_RE)) {
    const id = match[1] as string;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Extract the referenced work-item **keys** (`MOTIR-11`) for THIS project from
 * a body — one per distinct key in first-seen order, canonicalised to the
 * upper-case prefix form. Only the given project's prefix matches (a different
 * project's bare key is left as plain text — cross-project bare references are
 * out of scope; resolution stays same-project).
 */
export function parseWorkItemKeys(text: string, projectIdentifier: string): string[] {
  const prefix = projectIdentifier.toUpperCase();
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(buildWorkItemKeyRe(projectIdentifier))) {
    const key = `${prefix}-${match[1] as string}`;
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Rewrite every BARE project key (`MOTIR-11`) in `text` to the canonical
 * work-item link token `[MOTIR-11](motir:<id>)`, using `resolve` (a canonical
 * upper-case `KEY-N` → work-item id map). This is the WRITE-side companion to
 * {@link parseWorkItemRefs}: parsing a bare key auto-creates the `relates_to`
 * edge (5.8.3), but only the explicit token renders as a chip (5.8.6) — so
 * without this rewrite a bare key wires the edge yet stays plain text. Resolving
 * it to the canonical token closes that gap (bug MOTIR-1440): a bare key then
 * BOTH relates AND chips. Idempotent + non-destructive:
 *
 *  - An already-explicit `[label](motir:<id>)` token is left verbatim — the
 *    bare-key scan steps over the text INSIDE a token — so re-normalising a
 *    stored body is a no-op (and the in-app editor's round-trip stays stable).
 *  - A bare key absent from `resolve` (unknown / unresolved / cross-project)
 *    stays plain text — never invent a token for a key that doesn't resolve.
 *  - Only THIS project's prefix is a candidate (the parser's same-project rule).
 *
 * Pure string work — no Prisma, no IO. The caller resolves key → id ONCE
 * (`workItemRepository.findByIdentifiers`) and passes the map in.
 */
export function normalizeWorkItemRefs(
  text: string,
  projectIdentifier: string,
  resolve: ReadonlyMap<string, string>,
): string {
  if (resolve.size === 0) return text;
  const prefix = projectIdentifier.toUpperCase();
  // ONE pass alternating between a whole `motir:` token (group 1 — left
  // verbatim) and a bare key (group 2 = its number). Matching the token form
  // FIRST means a key sitting inside a token's label is consumed by the token
  // branch and never re-wrapped — that is what makes the rewrite idempotent.
  const tokenSrc = '\\[[^\\]]*\\]\\(motir:[A-Za-z0-9_-]+\\)';
  const keySrc = `\\b${escapeRe(projectIdentifier)}-(\\d+)\\b`;
  const re = new RegExp(`(${tokenSrc})|${keySrc}`, 'gi');
  return text.replace(re, (match, tokenMatch, keyNum) => {
    if (tokenMatch !== undefined) return match; // an existing token — untouched
    const key = `${prefix}-${keyNum as string}`;
    const id = resolve.get(key);
    return id ? `[${key}](motir:${id})` : match; // unresolved key stays plain
  });
}

/** The referenced ids (from `motir:` tokens) and bare keys found in a body. */
export interface WorkItemRefs {
  /** Work-item ids captured from explicit `motir:` tokens. */
  ids: string[];
  /** Bare `KEY-N` references for this project (upper-cased). */
  keys: string[];
}

/**
 * Extract every work-item reference from a body — both explicit `motir:` token
 * ids and bare project keys — each deduped in first-seen order. The service
 * then resolves keys → ids, unions with the token ids, drops self / forbidden /
 * unresolved targets, and auto-creates the `relates_to` links (5.8.3).
 */
export function parseWorkItemRefs(text: string, projectIdentifier: string): WorkItemRefs {
  // Strip `motir:` tokens before scanning for bare keys, so a token's bracket
  // label (`[MOTIR-805](motir:…)`) isn't ALSO counted as a bare key — its id is
  // already captured. Replace with a space to preserve word boundaries.
  const withoutTokens = text.replace(WORKITEM_TOKEN_RE, ' ');
  return {
    ids: parseWorkItemTokenIds(text),
    keys: parseWorkItemKeys(withoutTokens, projectIdentifier),
  };
}

// --- Intra-plan item-link tokens (Story 7.4 generation · MOTIR-1418) ---------
// The 7.4 generator (MOTIR-845 descriptions / MOTIR-850 explanations) references
// work items as item-link tokens. For an EXISTING item it emits the real
// `[label](motir:<id>)` token (handled by the parser above). But for an
// INTRA-PLAN sibling — another `add` PlanItem in the SAME plan, with no real
// WorkItem id yet — it emits `[label](motir-ref:planItem:<planItemId>)`, keyed
// to the SAME `planItem:` temp-ref the structural `parentRef`/`blockedByRefs`
// carry. `materialize` REWRITES every such token to the real `motir:<id>` once
// the sibling becomes a WorkItem, so the stored body chips (5.8.6) and
// auto-relates (5.8.3) like any other reference — instead of landing as a
// broken temp-ref token.

/**
 * One intra-plan item-link token: `[<label>](motir-ref:planItem:<planItemId>)`.
 * Group 1 = the display label; group 2 = the planItem id (the `planItem:` prefix
 * stripped — the bare id materialize's temp-ref → work-item-id map is keyed by).
 * `/g` for `matchAll`/`replace`. The `motir-ref:planItem:` prefix can't match an
 * existing-item `motir:<id>` token or a bare key, so those pass through.
 */
export const INTRA_PLAN_REF_TOKEN_RE = /\[([^\]]*)\]\(motir-ref:planItem:([A-Za-z0-9_-]+)\)/g;

/**
 * Extract the intra-plan sibling planItem ids referenced in a body — one per
 * distinct id in first-seen order. Pure string work; the structural `planItem:`
 * prefix is already stripped (these are the bare ids).
 */
export function parseIntraPlanRefIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(INTRA_PLAN_REF_TOKEN_RE)) {
    const id = match[2] as string;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** The rewritten body + the temp-ref ids that did NOT resolve (left inert). */
export interface IntraPlanRewriteResult {
  body: string;
  /** planItem ids whose token was left as-is because they resolved to no item. */
  unresolved: string[];
}

/**
 * Rewrite every intra-plan token `[label](motir-ref:planItem:<id>)` in `text` to
 * the real work-item link token `[label](motir:<workItemId>)`, using `resolve`
 * (a planItem id → created work-item id map — the SAME map materialize already
 * builds for `parentRef` / edge refs). A token whose id does NOT resolve (a
 * dangling ref) is left VERBATIM — inert text, never a half-token or crash — and
 * its id is reported in `unresolved` so the caller can surface it. Existing
 * `motir:<id>` tokens and bare keys are untouched (the `motir-ref:planItem:`
 * prefix matches neither). Pure string work — no Prisma, no IO. Non-destructive
 * and idempotent: a body with no intra-plan token returns unchanged.
 */
export function rewriteIntraPlanRefs(
  text: string,
  resolve: ReadonlyMap<string, string>,
): IntraPlanRewriteResult {
  const unresolved: string[] = [];
  const body = text.replace(INTRA_PLAN_REF_TOKEN_RE, (match, label: string, planItemId: string) => {
    const id = resolve.get(planItemId);
    if (!id) {
      unresolved.push(planItemId);
      return match; // dangling temp-ref → left inert
    }
    return `[${label}](motir:${id})`;
  });
  return { body, unresolved };
}
