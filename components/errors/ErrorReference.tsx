'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

// The REFERENCE line under the server-error card (design MOTIR-6854, § The
// reference): the error's `digest` — Next's opaque hash of the server error,
// no message and no data — which a reader can quote to support and which the
// boundary tags its Sentry report with. Rendered only when there IS a digest:
// an error thrown in the browser has none. The chip sits on `--el-surface`, so
// its ink is `--el-text-secondary`, never muted (CLAUDE.md's contrast table).

const COPIED_MS = 2000;

export interface ErrorReferenceProps {
  digest: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
}

export function ErrorReference({ digest, label, copyLabel, copiedLabel }: ErrorReferenceProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(digest);
      setCopied(true);
    } catch {
      // No clipboard (permission, insecure context): the chip is
      // `select-all`, so the reference is still one click from being copied.
    }
  }

  return (
    <p className="text-(--el-text-secondary) m-0 inline-flex items-center gap-2 font-sans text-sm">
      <span>{label}</span>
      <code className="bg-(--el-surface) border-(--el-border) text-(--el-text-secondary) select-all rounded-(--radius-control) border px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-xs">
        {digest}
      </code>
      {copied ? (
        <span role="status" className="inline-flex items-center gap-1 text-xs">
          <Check className="h-3 w-3" aria-hidden />
          {copiedLabel}
        </span>
      ) : (
        <button
          type="button"
          onClick={copy}
          aria-label={copyLabel}
          className="text-(--el-text-secondary) hover:bg-(--el-surface) inline-flex h-7 min-w-7 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Copy className="h-3 w-3" aria-hidden />
        </button>
      )}
    </p>
  );
}
