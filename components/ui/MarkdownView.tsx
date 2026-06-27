import { renderMarkdown } from '@/lib/markdown/render';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import './markdown-editor.css';

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
// Typography comes from the shared `motir-prose` styles (markdown-editor.css)
// — the SAME content styles the WYSIWYG editor uses (2.3.10), so the read
// surface and the edit surface share one look. The legacy `wmde-markdown` class
// is kept as a stable styling/test hook.

export interface MarkdownViewProps {
  /** The raw Markdown source to render. */
  value: string;
  /** Extra classes appended to the markdown container. */
  className?: string;
  /** Optional accessible label for the rendered region. */
  'aria-label'?: string;
  /**
   * Resolved work-item reference summaries (Subtask 5.8.6) for the `motir:`
   * token chips in `value` — current key · title · status. The surface resolves
   * them (detail page · comments · peek) and passes them through to
   * `renderMarkdown`; omitted, a token degrades to a struck-through bare key.
   */
  workItemRefs?: WorkItemRefMap;
}

export function MarkdownView({ value, className, workItemRefs, ...rest }: MarkdownViewProps) {
  // Link underlining (WCAG link-in-text-block) is handled inside renderMarkdown
  // so every render surface — this view, the editor preview, the server render —
  // gets it from the ONE module.
  return (
    <div
      className={['wmde-markdown', 'motir-prose', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {renderMarkdown(value, { workItemRefs })}
    </div>
  );
}
