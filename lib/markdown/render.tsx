import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';

// Rendered Markdown links must be distinguishable WITHOUT relying on color
// (WCAG 2.4.1 / axe `link-in-text-block`). Tailwind's preflight resets
// `a { text-decoration: inherit }`, so a link inside body text would otherwise
// look identical to the surrounding prose. Underline it at the render layer —
// an inline style so it holds regardless of the surrounding stylesheet cascade
// (the editor's bundled markdown CSS is imported unlayered). `node` is dropped
// so it doesn't leak onto the DOM element.
const components: Components = {
  a: ({ node: _node, style, ...props }) => (
    <a {...props} style={{ ...style, textDecorationLine: 'underline' }} />
  ),
};

// Markdown render stack for the two work-item content axes (descriptionMd /
// explanationMd) — Story 1.4's "rich text shape: Markdown source, HTML-
// rendered" decision. This is the same pipeline GitHub uses:
//   - remark-gfm        → GitHub Flavored Markdown (tables, task lists,
//                         strikethrough, autolinks)
//   - rehype-sanitize   → XSS scrub: strips <script>/<iframe>/on*-handlers
//                         from any inline HTML before it reaches the DOM
//   - rehype-highlight  → syntax highlighting for fenced code blocks
//                         (emits hljs-* class names; theme CSS applied by the
//                         consuming surface in Epic 2)
//
// ORDER MATTERS: rehype-sanitize runs before rehype-highlight so highlight's
// generated <span class="hljs-*"> markup is added to already-sanitized
// content and isn't stripped. The editor itself (live-preview Markdown source
// editor) is Epic 2's issue-detail Subtask; this Story ships the render path.
export function renderMarkdown(md: string) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize, rehypeHighlight]}
      components={components}
    >
      {md}
    </ReactMarkdown>
  );
}
