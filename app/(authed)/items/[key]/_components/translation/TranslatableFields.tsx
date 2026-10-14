'use client';

import { MarkdownView, type MarkdownViewProps } from '@/components/ui/MarkdownView';
import { WorkItemTitle } from '@/components/markdown/WorkItemTitle';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { useFieldTranslation } from './TranslationProvider';

// THE FIELD RENDERERS, wrapped (Story MOTIR-7735 · Subtask MOTIR-8122). Each
// renders the stored text through the SAME renderer as before, and swaps in the
// translation only when its field is translated and the view is on the
// translation — so markdown structure, a code block, a link and a work-item chip
// render and point exactly as in the original (design panel 5). A pending field
// keeps its original text in the same box, so nothing moves while it waits.
//
// With no provider (the public page) each is the bare renderer it wraps.

/** A markdown body (the description, the explanation) — `MarkdownView`, wrapped. */
export function TranslatableMarkdown({
  fieldRef,
  value,
  ...rest
}: MarkdownViewProps & { fieldRef: string }) {
  const { text } = useFieldTranslation(fieldRef);
  return <MarkdownView {...rest} value={text ?? value} data-translated={text ? '' : undefined} />;
}

/** The title — `WorkItemTitle`, wrapped (its bare-key links resolve as before). */
export function TranslatableTitle({
  title,
  projectIdentifier,
  workItemRefs,
}: {
  title: string;
  projectIdentifier: string;
  workItemRefs: WorkItemRefMap;
}) {
  const { text } = useFieldTranslation('title');
  return (
    <WorkItemTitle
      title={text ?? title}
      projectIdentifier={projectIdentifier}
      workItemRefs={workItemRefs}
    />
  );
}
