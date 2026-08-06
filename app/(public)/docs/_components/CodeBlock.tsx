'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';

// A code block with a copy affordance (Story 11.4 · Subtask 11.4.7 — MOTIR-2188;
// design `design/api-docs/` Panels 1–2, 9).
//
// ⚠️ THE WIDE-CONTENT RULE, and it is the reason this is a component rather than
// a `<pre>`: a `curl` line is wider than any phone. The `<pre>` scrolls inside
// its own container (`overflow-x-auto`) and the bordered wrapper clips
// (`overflow-hidden`), so the PAGE never scrolls sideways. `min-w-0` on the
// wrapper is what stops a flex parent from being widened by the content instead
// (`notes.html`'s min-w-0 overflow class).
//
// The only client component on the surface — everything else renders on the
// server, because a reference is text.

export function CodeBlock({
  caption,
  code,
  copyable = false,
}: {
  /** What the block IS — `curl`, `application/json`, `response headers`. */
  caption: string;
  code: string;
  /** Only the runnable samples get a copy button; a schema is read, not run. */
  copyable?: boolean;
}) {
  const t = useTranslations('apiDocs');
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    // The confirmation is the STATE of this button, not a toast: the reader is
    // looking at the thing they clicked, and a toast would announce a success
    // they can already see.
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative min-w-0 overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-code-bg)">
      <div className="flex items-center gap-2 border-b border-(--el-border-soft) bg-(--el-surface-soft) px-3 py-2 font-mono text-[11px] text-(--el-text-faint)">
        {caption}
      </div>
      {copyable && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={copy}
          className="absolute top-9 right-2"
        >
          {copied ? t('codeCopied') : t('codeCopy')}
        </Button>
      )}
      <pre className="m-0 overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-relaxed whitespace-pre text-(--el-code-text)">
        {code}
      </pre>
    </div>
  );
}
