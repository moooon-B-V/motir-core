'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { MarkdownEditor, type MentionCandidate } from '@/components/ui/MarkdownEditor';
import { Avatar } from '../../_components/issueCellPrimitives';

// The comment composer (Subtask 5.1.5) — the shipped MarkdownEditor in its
// compact comment mode, per `design/work-items/comments.mock.html` panels 3–4:
//
//   * `new`   — led by the viewer's avatar; at REST a collapsed one-line
//               "Add a comment…" invitation (so a long thread isn't dominated
//               by an empty editor — the Jira shape); focusing expands it.
//               <Esc> with an empty body collapses back to rest.
//   * `reply` — opens expanded inside the thread rail, the replied-to author
//               pre-mentioned (the Jira auto-tag — the parent seeds
//               `initialValue`); ghost Cancel + primary Reply.
//   * `edit`  — expanded over the row's Markdown source (mentions round-trip
//               intact — 5.1.4); ghost Cancel + primary Save.
//
// Submit is disabled while empty/submitting; while posting the button is busy
// and the editor read-only (the panel-3 submitting state). The parent owns the
// Server Action call — `onSubmit` resolves to an error message or null, so the
// composer renders failures inline and keeps the draft.

export type ComposerMode = 'new' | 'reply' | 'edit';

export function CommentComposer({
  mode,
  label,
  submitLabel,
  authorName,
  initialValue = '',
  mentionCandidates,
  onSubmit,
  onCancel,
}: {
  mode: ComposerMode;
  /** Accessible label for the editing surface (visually hidden — the design
   * leads with the avatar, not a field label). */
  label: string;
  submitLabel: string;
  /** The viewer's name — draws the leading avatar (the `new` composer only). */
  authorName?: string;
  initialValue?: string;
  mentionCandidates: MentionCandidate[];
  /** Resolve to an error message to show inline, or null on success. */
  onSubmit: (bodyMd: string) => Promise<string | null>;
  /** Reply/edit only — Cancel and <Esc> hand control back to the row. */
  onCancel?: () => void;
}) {
  const t = useTranslations('comments');
  const tc = useTranslations('common');
  const [expanded, setExpanded] = useState(mode !== 'new');
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restRef = useRef<HTMLButtonElement>(null);

  const empty = value.trim().length === 0;

  function collapseToRest() {
    setExpanded(false);
    setValue('');
    setError(null);
    // Focus the rest invitation so keyboard users land somewhere sane.
    requestAnimationFrame(() => restRef.current?.focus());
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (mode === 'new') {
      // <Esc> with an empty body collapses back to rest (panel 3); a draft
      // stays put — collapsing would destroy it.
      if (empty) collapseToRest();
      return;
    }
    onCancel?.();
  }

  function submit() {
    if (empty || submitting) return;
    setSubmitting(true);
    setError(null);
    void onSubmit(value).then((message) => {
      setSubmitting(false);
      if (message) {
        setError(message);
        return;
      }
      if (mode === 'new') collapseToRest();
    });
  }

  if (!expanded) {
    return (
      <div className="flex items-start gap-2.5">
        {authorName ? <Avatar name={authorName} /> : null}
        <button
          ref={restRef}
          type="button"
          onClick={() => setExpanded(true)}
          className="border-(--el-border) bg-(--el-surface) text-(--el-text-muted) hover:border-(--el-border-strong) hover:text-(--el-text-secondary) h-(--height-control) min-w-0 flex-1 rounded-(--radius-input) border px-(--spacing-control-x) text-left font-sans text-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {t('addPlaceholder')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5" onKeyDown={handleKeyDown}>
      {mode === 'new' && authorName ? <Avatar name={authorName} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <MarkdownEditor
          value={value}
          onChange={setValue}
          label={label}
          labelHidden
          size="compact"
          readOnly={submitting}
          mentionCandidates={mentionCandidates}
        />
        {error ? (
          <p
            role="alert"
            className="text-(--el-text-strong) bg-(--el-tint-rose) rounded-(--radius-control) px-2.5 py-1.5 font-sans text-xs"
          >
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {/* Ghost Cancel rides reply/edit only (panel 3/4) — the `new`
              composer collapses via <Esc> on an empty body instead. */}
          {mode !== 'new' ? (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
              {tc('cancel')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            onClick={submit}
            disabled={empty}
            loading={submitting}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
