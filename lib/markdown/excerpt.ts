// Markdown → plain-text excerpt (Subtask 7.0.3). Used by `toReadyItemDto` to
// build `descriptionExcerpt` — a short, syntax-free preview of an issue's
// Markdown body for a list row, so the page never ships full `@db.Text` bodies
// per row.
//
// This is a deliberately LIGHTWEIGHT regex strip, NOT the full render pipeline
// in `lib/markdown/render.tsx` (react-markdown + remark + rehype). An excerpt
// only needs the visible words, not a parsed/sanitized tree — pulling the React
// renderer in to extract text would be far heavier than the job warrants, and
// it doesn't import `react-markdown`, so the single-source-of-truth render
// guard (`tests/markdown/render-single-source.test.ts`) is unaffected.

const DEFAULT_MAX_CHARS = 200;

/**
 * Strip common Markdown syntax to plain text. Best-effort and intentionally
 * simple — it covers the constructs that show up in issue descriptions
 * (headings, emphasis, inline code, links/images, list bullets, blockquotes,
 * fenced code fences, horizontal rules) and collapses whitespace. It is NOT a
 * full parser; edge cases degrade to "leave the raw character in", which for an
 * excerpt is acceptable.
 */
function stripMarkdown(md: string): string {
  return (
    md
      // Fenced code-block fences (keep the code text, drop the ``` lines).
      .replace(/```[^\n]*\n?/g, '')
      .replace(/~~~[^\n]*\n?/g, '')
      // Images: ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Links: [text](url) → text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Reference-style link/image labels: [text][ref] → text
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      // Inline code: `code` → code
      .replace(/`([^`]*)`/g, '$1')
      // Bold / italic / strikethrough markers (run repeatedly via the char class).
      .replace(/(\*\*|__|\*|_|~~)/g, '')
      // Leading heading hashes, blockquote markers, list bullets, on each line.
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, '')
      // Horizontal rules on their own line.
      .replace(/^[ \t]*([-*_])[ \t]*(\1[ \t]*){2,}$/gm, '')
      // Collapse all runs of whitespace (incl. newlines) to single spaces.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Build a plain-text excerpt from a Markdown source. Returns `null` for a null
 * / empty (post-strip) input. Truncates to `maxChars` on a WORD boundary,
 * appending an ellipsis `…` ONLY when truncation actually dropped content. A
 * string already within `maxChars` is returned whole, no ellipsis.
 */
export function markdownToExcerpt(
  md: string | null | undefined,
  maxChars: number = DEFAULT_MAX_CHARS,
): string | null {
  if (!md) return null;
  const text = stripMarkdown(md);
  if (text.length === 0) return null;
  if (text.length <= maxChars) return text;

  // Truncate to maxChars, then back off to the last space so we don't cut a
  // word. If there is no space in the window (one very long token), hard-cut.
  const window = text.slice(0, maxChars);
  const lastSpace = window.lastIndexOf(' ');
  const head = lastSpace > 0 ? window.slice(0, lastSpace) : window;
  return `${head.trimEnd()}…`;
}
