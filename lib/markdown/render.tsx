import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import { WORKITEM_HREF_RE } from '@/lib/mentions/workItemRefs';
import { WorkItemRefChip } from '@/components/markdown/WorkItemRefChip';
import { CopyableCodeBlock } from '@/components/markdown/CopyableCodeBlock';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// Mention tokens (Story 5.1 · Subtask 5.1.4) are stored as Markdown links with
// the `mention:` scheme — `[@Display Name](mention:<userId>)` (the durable
// format `lib/mentions/parse.ts` is the authority on). Work-item references
// (Story 5.8 · 5.8.2) are the EXACT parallel: `[KEY](motir:<workItemId>)` (the
// format `lib/mentions/workItemRefs.ts` owns). TWO layers scrub URL protocols
// and BOTH must allow these schemes — each for `a.href` only, leaving the rest
// of the XSS posture untouched (scripts, iframes, on*-handlers, and every other
// non-allowlisted scheme — javascript:, data:, … — stay dead):
//
//  1. react-markdown's own urlTransform (runs first): the default empties any
//     href outside its http/https/mailto/… allowlist, so a passthrough is
//     added for well-formed `mention:` / `motir:` hrefs ahead of the default.
//  2. rehype-sanitize's schema protocol allowlist.
const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'mention', 'motir'],
  },
};

// A well-formed mention href: the id is the cuid character set, non-empty —
// mirrors MENTION_TOKEN_RE in lib/mentions/parse.ts. (WORKITEM_HREF_RE is the
// `motir:` analogue, imported from lib/mentions/workItemRefs.ts.)
const MENTION_HREF_RE = /^mention:[A-Za-z0-9_-]+$/;

// Layer 1 above: only a WELL-FORMED mention / work-item href bypasses the
// default transform (a malformed one is scrubbed exactly as before, then
// degrades to plain text in the `a` component below).
function urlTransform(url: string): string {
  return MENTION_HREF_RE.test(url) || WORKITEM_HREF_RE.test(url) ? url : defaultUrlTransform(url);
}

// Rendered Markdown links must be distinguishable WITHOUT relying on color
// (WCAG 2.4.1 / axe `link-in-text-block`). Tailwind's preflight resets
// `a { text-decoration: inherit }`, so a link inside body text would otherwise
// look identical to the surrounding prose. Underline it at the render layer —
// an inline style so it holds regardless of the surrounding stylesheet cascade
// (the editor's bundled markdown CSS is imported unlayered). `node` is dropped
// so it doesn't leak onto the DOM element.
//
// A `mention:` href never becomes a navigable anchor: a well-formed token
// renders as the designed user chip (`mention-chip`, styled in
// markdown-editor.css — tint background + strong text, finding #35); a
// malformed/stale one degrades to the plain display-name text. Never a broken
// link (comments.mock.html panel 5).
//
// A `motir:` href is the work-item analogue (Subtask 5.8.6): a well-formed token
// renders as the LIVE internal-link chip (`WorkItemRefChip` — type icon · key ·
// title · status, opening the quick-view peek), resolved against the
// `workItemRefs` summary map threaded in from the surface; a malformed one
// degrades to the plain authored key. The components are built per-render so the
// `a` handler can close over that map.
//
// A GFM `table` is wrapped in its OWN scroll block (MOTIR-2039). A `<table>` is
// sized by its content: when its min-content width exceeds the column it does
// not wrap, shrink or clip — it paints straight across the right rail and off
// the viewport, and the escaped columns are unreachable. `min-w-0` on the issue
// detail page's `1fr` track (bug-issue-detail-eyebrow-overflows-viewport) is
// necessary but not sufficient — it only bounds children that scroll
// THEMSELVES, which is why `.motir-prose pre` carries `overflow-x: auto`.
// Wrapping (rather than `table { display: block; overflow-x: auto }`) keeps the
// element a real `display: table`, so the column auto-sizing survives; the
// wrapper is the bounded scroll container; its RULES + padding come from
// markdown-editor.css, but the containment itself is an inline style for the
// same reason the link underline above is one — `renderMarkdown` also serves
// surfaces that never load that stylesheet (`ConventionPanel`,
// `FeatureCatalogView`, `DirectionDocView`), and a table must not escape its
// column on any of them.
//
// A fenced code block gains a CLICK-TO-COPY bar ONLY when the surface opts in
// (`copyableCode`, Story MOTIR-4906 · MOTIR-5336, `design/github/design-notes.md`
// §20). The HOW TO TEST body is where a reader copies commands; a description
// or a comment did not ask for a control, so without the option nothing about
// their render changes. It is a `pre` override here — inside the ONE pipeline —
// rather than a second renderer, so the sanitize and highlight passes still run
// over the code first.
function buildComponents(workItemRefs?: WorkItemRefMap, copyableCode = false): Components {
  return {
    ...(copyableCode
      ? {
          // The block draws its own `<pre>`; the highlighted `<code>` is its child.
          pre: ({ node, children }) => {
            const code = codeChildOf(node);
            return (
              <CopyableCodeBlock language={code.language} code={code.text}>
                {children}
              </CopyableCodeBlock>
            );
          },
        }
      : {}),
    table: ({ node: _node, children, ...props }) => (
      <div className="motir-table-wrap" style={{ maxWidth: '100%', overflowX: 'auto' }}>
        <table {...props}>{children}</table>
      </div>
    ),
    a: ({ node: _node, style, href, children, ...props }) => {
      if (typeof href === 'string' && href.startsWith('mention:')) {
        return MENTION_HREF_RE.test(href) ? (
          <span className="mention-chip">{children}</span>
        ) : (
          <>{children}</>
        );
      }
      if (typeof href === 'string' && href.startsWith('motir:')) {
        if (!WORKITEM_HREF_RE.test(href)) return <>{children}</>;
        const id = href.slice('motir:'.length);
        return <WorkItemRefChip summary={workItemRefs?.[id]} fallbackLabel={children} />;
      }
      return (
        <a {...props} href={href} style={{ ...style, textDecorationLine: 'underline' }}>
          {children}
        </a>
      );
    },
  };
}

// Markdown render stack for the two work-item content axes (descriptionMd /
// explanationMd) — Story 1.4's "rich text shape: Markdown source, HTML-
// rendered" decision. This is the same pipeline GitHub uses:
//   - remark-gfm        → GitHub Flavored Markdown (tables, task lists,
//                         strikethrough, autolinks)
//   - rehype-sanitize   → XSS scrub: strips <script>/<iframe>/on*-handlers
//                         from any inline HTML before it reaches the DOM
//                         (schema extended above for `mention:` hrefs only)
//   - rehype-highlight  → syntax highlighting for fenced code blocks
//                         (emits hljs-* class names; theme CSS applied by the
//                         consuming surface in Epic 2)
//
// ORDER MATTERS: rehype-sanitize runs before rehype-highlight so highlight's
// generated <span class="hljs-*"> markup is added to already-sanitized
// content and isn't stripped. The editor itself (live-preview Markdown source
// editor) is Epic 2's issue-detail Subtask; this Story ships the render path.
/** A hast node, as far as the copy control reads one. */
interface HastLike {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

function hastText(node: HastLike): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

/**
 * The fenced block's language AS WRITTEN (`language-nushell` → `nushell`, known
 * to the highlighter or not) and its text EXACTLY — read off the hast tree, so
 * the highlighter's `hljs-*` spans cannot change what is copied. The one
 * trailing newline mdast adds to every fenced block is not part of what the
 * author wrote, so it is dropped.
 */
function codeChildOf(node: unknown): { language: string | null; text: string } {
  const pre = node as HastLike | undefined;
  const code = pre?.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  if (!code) return { language: null, text: pre ? hastText(pre).replace(/\n$/, '') : '' };
  const classes = code.properties?.className;
  const list = Array.isArray(classes) ? classes.map(String) : [];
  const lang = list.find((c) => c.startsWith('language-'));
  return {
    language: lang ? lang.slice('language-'.length) : null,
    text: hastText(code).replace(/\n$/, ''),
  };
}

export interface RenderMarkdownOptions {
  /**
   * Resolved work-item reference summaries (Subtask 5.8.6), keyed by id, that
   * the `motir:` token chip renders against (current key · title · status). The
   * surface (detail page · comments · peek) resolves these and threads them in;
   * omitted, a `motir:` token still degrades safely (a struck-through bare key).
   */
  workItemRefs?: WorkItemRefMap;
  /**
   * OPT-IN click-to-copy on every fenced code block (MOTIR-5336): a bar above
   * the code with the fence's language and a Copy control. Off by default, so
   * descriptions and comments render exactly as before. Inline `code` never
   * gets a control.
   */
  copyableCode?: boolean;
}

export function renderMarkdown(md: string, opts: RenderMarkdownOptions = {}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, sanitizeSchema], rehypeHighlight]}
      components={buildComponents(opts.workItemRefs, opts.copyableCode)}
      urlTransform={urlTransform}
    >
      {md}
    </ReactMarkdown>
  );
}
