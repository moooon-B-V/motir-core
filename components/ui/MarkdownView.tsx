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
  // Link underlining (WCAG link-in-text-block) is handled inside renderMarkdown
  // so every render surface — this view, the editor preview, the server render —
  // gets it from the ONE module.
  return (
    <div className={['wmde-markdown', className].filter(Boolean).join(' ')} {...rest}>
      {renderMarkdown(value)}
    </div>
  );
}
