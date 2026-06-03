import { Sparkles } from 'lucide-react';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Pill } from '@/components/ui/Pill';
import type { WorkItemExplanationSourceDto } from '@/lib/dto/workItems';

// The issue's "why this matters" axis (Story 1.4's `explanationMd`), rendered
// read-only beneath the description (Subtask 2.4.2). When the provenance is
// `ai_draft` it carries an "AI-drafted" badge so a reader knows the prose was
// machine-generated and may want review. Editing / regenerating the explanation
// is an Epic-7 concern — there is NO control here. An absent explanation hides
// the section entirely (no empty placeholder).

export interface IssueExplanationProps {
  explanationMd: string | null;
  explanationSource: WorkItemExplanationSourceDto;
}

export function IssueExplanation({ explanationMd, explanationSource }: IssueExplanationProps) {
  if (!explanationMd) return null;

  return (
    <section aria-label="Explanation" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-foreground font-sans text-sm font-semibold">Explanation</h2>
        {explanationSource === 'ai_draft' ? (
          <Pill tone="neutral">
            <Sparkles className="h-3 w-3" aria-hidden />
            AI-drafted
          </Pill>
        ) : null}
      </div>
      <MarkdownView value={explanationMd} aria-label="Issue explanation" />
    </section>
  );
}
