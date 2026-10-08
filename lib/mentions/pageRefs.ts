// Page reference parsing (Story MOTIR-7694 · MOTIR-7696). A page tagged in a
// work item's Description or Explanation serializes into stored Markdown as a
// durable token — `[<title at insert>](motir-page:<pageId>)` — the page-side
// sibling of the work-item token `[<KEY>](motir:<id>)` (`./workItemRefs.ts`) and
// the user-mention token `[@Name](mention:<id>)` (`./parse.ts`). The body stays
// plain Markdown; the label is only the title at insert, and every reader
// resolves the CURRENT title from the id.
//
// Pure string work — no Prisma, no IO — so the editor, the render layer and the
// save-path derivation (`workItemsService`) share ONE grammar.

/**
 * One page-reference token: `[<label>](motir-page:<pageId>)`. Group 1 = the
 * label, group 2 = the page cuid. `/g` for `matchAll` / `replace`.
 *
 * The label class excludes `[` as well as `]`, for the quadratic-scan reason
 * `WORKITEM_TOKEN_RE` gives (MOTIR-4202). The `motir-page:` scheme matches
 * neither a `motir:` nor a `mention:` token, so those pass through.
 */
export const PAGE_TOKEN_RE = /\[([^\]\[]*)\]\(motir-page:([A-Za-z0-9_-]+)\)/g;

/** A well-formed `motir-page:` href — the render layer's test for a page chip. */
export const PAGE_HREF_RE = /^motir-page:([A-Za-z0-9_-]+)$/;

/**
 * The page ids a body tags — one per distinct id, in first-seen order. A
 * malformed near-token (no scheme, unclosed bracket) is body text, never an
 * error.
 */
export function parsePageTokenIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PAGE_TOKEN_RE)) {
    const id = match[2] as string;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The token the picker inserts for a page. Brackets in the title are dropped
 * from the label, because the token grammar ends a label at the first `]` and
 * refuses a `[` inside it.
 */
export function formatPageToken(pageId: string, title: string): string {
  const label = title.replace(/[[\]]/g, '').trim() || 'page';
  return `[${label}](motir-page:${pageId})`;
}

/**
 * Rewrite every page token's LABEL with `relabel(pageId, label)` — the hook a
 * reader that may not see a page's title uses to strip it (Visitor reads,
 * `lib/visitor/readScope.ts`). The id is kept, so the chip still renders its
 * unavailable state. Text outside tokens is untouched.
 */
export function relabelPageTokens(
  text: string,
  relabel: (pageId: string, label: string) => string,
): string {
  return text.replace(
    PAGE_TOKEN_RE,
    (_match, label: string, pageId: string) => `[${relabel(pageId, label)}](motir-page:${pageId})`,
  );
}
