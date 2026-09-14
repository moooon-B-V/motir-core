'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';

// THE COPYABLE CODE BLOCK (Story MOTIR-4906 · Subtask MOTIR-5336), built to
// `design/github/design-notes.md` §20 · Panel 12d. Every fenced block in a HOW TO
// TEST body renders through it (the opt-in `copyableCode` `pre` override in
// `lib/markdown/render.tsx`), and so does the derived *Locally* fetch command.
//
// ⚠️ THE CONTROL SITS IN A BAR ABOVE THE CODE, NEVER OVER IT. A long command
// scrolls sideways inside its own block, and at ~400px every block does; an
// overlaid button would cover the command the reader is about to copy.
//
// ⚠️ IT COPIES `code`, NOT THE RENDERED TEXT. The highlighter wraps tokens in
// `hljs-*` spans; the caller reads the text off the source tree, so what lands
// on the clipboard is exactly what the author fenced.

/** How long the copied state holds before the control returns to rest. */
const COPIED_MS = 2000;

type CopyState = 'rest' | 'copied' | 'failed';

export function CopyableCodeBlock({
  language,
  code,
  children,
}: {
  /** The fence's language AS WRITTEN, or null for a bare fence. */
  language: string | null;
  /** The exact text the control copies. */
  code: string;
  /** The rendered code (the highlighted `<code>`); omitted, `code` renders plain. */
  children?: ReactNode;
}) {
  const t = useTranslations('github.development.howToTest.code');
  const [state, setState] = useState<CopyState>('rest');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setState('copied');
      timer.current = setTimeout(() => setState('rest'), COPIED_MS);
    } catch {
      // Denied permission, an insecure origin, or no clipboard at all. The code is
      // still on screen and selectable, which is what the sentence tells them.
      setState('failed');
    }
  }

  const copied = state === 'copied';
  return (
    <div className="motir-code-block my-2 min-w-0 overflow-hidden rounded-(--radius-input) border border-(--el-border) bg-(--el-surface) [[data-port]_&]:bg-(--el-card)">
      <div className="flex min-h-7 items-center justify-between gap-2 border-b border-(--el-border-soft) bg-(--el-surface-soft) pr-1 pl-(--spacing-control-x)">
        <span className="font-mono text-[11px] text-(--el-text-secondary)">{language ?? ''}</span>
        <span className="flex min-w-0 items-center gap-2" aria-live="polite">
          {state === 'failed' ? (
            <span className="text-xs text-(--el-text-secondary)">{t('copyFailed')}</span>
          ) : null}
          <button
            type="button"
            aria-label={t('copyAria')}
            data-state={state}
            onClick={() => void copy()}
            className={
              copied
                ? 'inline-flex h-6 shrink-0 items-center gap-1 rounded-(--radius-control) bg-(--el-tint-mint) px-(--spacing-control-x) text-xs font-medium text-(--el-text-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none'
                : 'inline-flex h-6 shrink-0 items-center gap-1 rounded-(--radius-control) px-(--spacing-control-x) text-xs font-medium text-(--el-text-secondary) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none'
            }
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
            {copied ? t('copied') : t('copy')}
          </button>
        </span>
      </div>
      <pre className="m-0 overflow-x-auto px-(--spacing-input-x) py-(--spacing-input-y) font-mono text-xs leading-relaxed whitespace-pre text-(--el-code-text)">
        {children ?? <code>{code}</code>}
      </pre>
    </div>
  );
}
