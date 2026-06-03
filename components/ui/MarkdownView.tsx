import { renderMarkdown } from '@/lib/markdown/render';

// MarkdownView — the read-only render surface for work-item Markdown content
// (descriptionMd / explanationMd). Story 1.4 fixed the storage shape (Markdown
// source) and the render stack (react-markdown + remark-gfm + rehype-sanitize +
// rehype-highlight, centralized in `lib/markdown/render.tsx`). This component is
// the thin, reusable wrapper around that stack — used by the MarkdownEditor's
// preview pane (2.3.5), the issue edit form (2.3.6), the future issue detail
// page, and any list-view description preview.
//
// There is exactly ONE remark/rehype pipeline in the codebase: `renderMarkdown`.
// Both this component and the editor's live preview render through it, so the
// editing surface and the read surface can never drift. A grep guard in the
// test suite enforces that no other file imports `react-markdown` directly.
//
// The `wmde-markdown` class hooks the GitHub-flavored markdown typography that
// ships with `@uiw/react-md-editor` (loaded by the MarkdownEditor); when this
// component renders without the editor on the page it degrades to unstyled-but-
// semantic HTML rather than breaking.

export interface MarkdownViewProps {
  /** The raw Markdown source to render. */
  value: string;
  /** Extra classes appended to the markdown container. */
  className?: string;
  /** Optional accessible label for the rendered region. */
  'aria-label'?: string;
}

export function MarkdownView({ value, className, ...rest }: MarkdownViewProps) {
  // `[&_a]:underline`: Tailwind's preflight resets `a { text-decoration: inherit }`,
  // so rendered Markdown links would otherwise rely on color alone — a WCAG
  // link-in-text-block failure (axe, serious). Underlining every link in the
  // rendered output makes them distinguishable without color. This utility lives
  // in @layer utilities, so it beats preflight's base reset.
  return (
    <div
      className={['wmde-markdown', '[&_a]:underline', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {renderMarkdown(value)}
    </div>
  );
}
