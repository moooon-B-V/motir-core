'use client';

import { useState } from 'react';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { SectionLabel } from '@/components/ui/SectionLabel';

/**
 * /tokens/markdown-editor — specimen route for the MarkdownEditor primitive
 * (Subtask 2.3.5). Renders every variant (min / full / read-only) plus the
 * read-only MarkdownView render path for visual review, and is swept by the
 * axe sweep in tests/e2e/shell-a11y.spec.ts.
 *
 * Kept off the big /tokens page so the heavy, client-only editor doesn't bloat
 * the design-system index; the card explicitly sanctions a sub-route.
 */

const SAMPLE = `# Release notes

A **bold** idea, an _italic_ aside, and a [link](https://example.com).

- list item one
- list item two

\`\`\`ts
const answer = 42;
\`\`\`

| Col A | Col B |
| ----- | ----- |
| a     | b     |
`;

export default function MarkdownEditorSpecimenPage() {
  const [minValue, setMinValue] = useState('A short description.');
  const [fullValue, setFullValue] = useState(SAMPLE);

  // NOTE: arbitrary `max-w-[48rem]`, NOT `max-w-3xl` — this project's Tailwind theme
  // resolves `max-w-{key}` against the --spacing-* scale (--spacing-3xl = 40px), so
  // `max-w-3xl` would collapse the page to a ~40px column (see components/ui/Modal.tsx
  // for the same gotcha; real pages use max-w-[Nrem]).
  return (
    <main className="bg-background text-foreground mx-auto max-w-[48rem] px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Markdown editor</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        The rich-text editor + read-only render path over the <code>descriptionMd</code> Markdown
        storage shape (Subtask 2.3.5).
      </p>

      <section className="mt-8 flex flex-col gap-2">
        <SectionLabel>Compact (size=&quot;min&quot;)</SectionLabel>
        <MarkdownEditor
          label="Description (compact)"
          size="min"
          value={minValue}
          onChange={setMinValue}
        />
      </section>

      <section className="mt-8 flex flex-col gap-2">
        <SectionLabel>Full (size=&quot;full&quot;)</SectionLabel>
        <MarkdownEditor
          label="Description (full)"
          size="full"
          value={fullValue}
          onChange={setFullValue}
        />
      </section>

      <section className="mt-8 flex flex-col gap-2">
        <SectionLabel>Read-only editor</SectionLabel>
        <MarkdownEditor
          label="Description (read-only)"
          readOnly
          value={SAMPLE}
          onChange={() => {}}
        />
      </section>

      <section className="mt-8 flex flex-col gap-2">
        <SectionLabel>MarkdownView (render path)</SectionLabel>
        <MarkdownView value={SAMPLE} aria-label="Rendered description" />
      </section>
    </main>
  );
}
