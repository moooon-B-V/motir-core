'use client';

import { useTranslations } from 'next-intl';
import { ArrowRight, Minus, PencilLine, Plus } from 'lucide-react';
import {
  parseDocDiff,
  humanizePath,
  formatDiffValue,
  type DocDiffEntry,
  type DocDiffKind,
} from '@/lib/onboarding/revisions';

// Per-revision DIFF display (Subtask 7.3.71 / MOTIR-1179) — renders WHAT changed
// in a tier's doc on one revision, NOT just "updated". The `diff` is the opaque
// payload the 7.3.70 read seam passes through from motir-ai's `diffDoc` (7.3.24);
// this only NARROWS + renders it (`parseDocDiff`), never recomputes it. Each leaf
// change reads as: a tinted kind chip (Added / Removed / Changed) + the
// human-readable path into the doc + the before→after value. An empty / malformed
// diff renders the "nothing changed" line (a revision can touch nothing).
//
// Purely presentational. Colour routes through `--el-*` tints with
// `--el-text-strong` (AA per finding #35); shape through element-semantic tokens.

export interface RevisionDiffProps {
  /** The opaque per-revision diff from the read seam (`PreplanRevisionDTO.diff`). */
  diff: unknown;
}

export function RevisionDiff({ diff }: RevisionDiffProps) {
  const t = useTranslations('onboarding.chat.revisions');
  const entries = parseDocDiff(diff);

  if (entries.length === 0) {
    return <p className="text-sm text-(--el-text-muted)">{t('noChange')}</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry, i) => (
        <DiffRow key={`${entry.path}-${entry.kind}-${i}`} entry={entry} />
      ))}
    </ul>
  );
}

const KIND_STYLE: Record<
  DocDiffKind,
  { tint: string; labelKey: 'diffAdded' | 'diffRemoved' | 'diffChanged' }
> = {
  added: { tint: 'bg-(--el-tint-mint)', labelKey: 'diffAdded' },
  removed: { tint: 'bg-(--el-tint-rose)', labelKey: 'diffRemoved' },
  changed: { tint: 'bg-(--el-tint-sky)', labelKey: 'diffChanged' },
};

function KindGlyph({ kind }: { kind: DocDiffKind }) {
  if (kind === 'added') return <Plus className="size-3.5" aria-hidden="true" />;
  if (kind === 'removed') return <Minus className="size-3.5" aria-hidden="true" />;
  return <PencilLine className="size-3.5" aria-hidden="true" />;
}

function DiffRow({ entry }: { entry: DocDiffEntry }) {
  const t = useTranslations('onboarding.chat.revisions');
  const style = KIND_STYLE[entry.kind];
  const path = humanizePath(entry.path);

  return (
    <li className="rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface) px-(--spacing-control-x) py-(--spacing-control-y)">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong) ${style.tint}`}
        >
          <KindGlyph kind={entry.kind} />
          {t(style.labelKey)}
        </span>
        {path && <span className="text-sm font-medium text-(--el-text)">{path}</span>}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
        {entry.kind !== 'added' && (
          <span className="text-(--el-text-muted) line-through">
            {formatDiffValue(entry.before)}
          </span>
        )}
        {entry.kind === 'changed' && (
          <ArrowRight className="size-3.5 text-(--el-text-faint)" aria-hidden="true" />
        )}
        {entry.kind !== 'removed' && (
          <span className="text-(--el-text)">{formatDiffValue(entry.after)}</span>
        )}
      </div>
    </li>
  );
}
