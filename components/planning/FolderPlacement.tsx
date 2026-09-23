'use client';

import { Folder, FolderX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { PlanItemChangeDto, PlanPlacementSideDto } from '@/lib/dto/planReview';
import { workItemCrumbLabel } from '@/lib/planning/projectCanvasModel';

// Where a proposal will be FILED, on the plan review (Story MOTIR-5310 ·
// MOTIR-5418, to `design/ai-planning/design-notes.md` Part XVII).
//
// The folder VOCABULARY is composed, not redrawn: the lucide `folder` glyph in
// `--el-text-secondary` and the `Parked ▸ 2025` path joined with `▸` are the tree
// story's (`design/work-items/folders.mock.html`, the quick view's Folder field and
// the item page's `ParentBreadcrumb`). Every element here is TEXT, never a control
// (§17.10), so a reader without `work_item:edit` sees exactly the same pixels.

/** The path separator the folder vocabulary already ships. */
export const FOLDER_PATH_SEPARATOR = ' ▸ ';

/** The segment a collapsed path puts in its middle. */
const ELLIPSIS = '…';

/**
 * A long path collapses by COUNT, never by measurement (Part XVII §17.6): a path
 * longer than `max` segments becomes `first ▸ … ▸ last`. The first segment says
 * whose, the last says where; the middle is what a reader can most afford to
 * lose. Pure, so the rule is asserted without a layout engine.
 *
 * The ceilings are the design's: 3 on the card's placement line and the
 * breadcrumb segment, 4 on the list row's fact.
 */
export function collapseFolderPath(path: readonly string[], max: number): string[] {
  if (path.length <= max || path.length < 3) return [...path];
  return [path[0]!, ELLIPSIS, path[path.length - 1]!];
}

/** The full path as one reader string — the element's `title` and its accessible name. */
export function folderPathText(path: readonly string[]): string {
  return path.join(FOLDER_PATH_SEPARATOR);
}

/**
 * The folder path, drawn: glyph, then the (collapsed) segments with the LAST one
 * emphasised — it is the destination — and the full path in `title` (hover) and a
 * visually-hidden span (the accessible name), so hover and focus both read it whole.
 */
export function FolderPathLabel({
  path,
  max,
  lastClassName = 'font-medium text-(--el-text)',
  glyphClassName = 'size-3.5',
  srPrefix,
  srText,
  toneClassName = 'text-(--el-text-secondary)',
  segmentClassName = '',
}: {
  path: readonly string[];
  max: number;
  lastClassName?: string;
  glyphClassName?: string;
  /** A visually-hidden word ahead of the path, e.g. the breadcrumb's `Folder:`. */
  srPrefix?: string;
  /** The whole accessible sentence, when the path sits inside one. */
  srText?: string;
  /** The ink of the glyph and the separators. */
  toneClassName?: string;
  /** Applied to EVERY segment — a diff's struck old side. */
  segmentClassName?: string;
}) {
  const full = folderPathText(path);
  const shown = collapseFolderPath(path, max);
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 ${toneClassName}`}
      title={full}
      data-testid="folder-path"
    >
      <Folder className={`${glyphClassName} shrink-0`} aria-hidden="true" />
      <span className="sr-only">{srText ?? (srPrefix ? `${srPrefix} ${full}` : full)}</span>
      <span className="flex min-w-0 items-center gap-1" aria-hidden="true">
        {shown.map((segment, i) => (
          <span key={`${i}-${segment}`} className="flex min-w-0 items-center gap-1">
            {i > 0 ? <span className="shrink-0">▸</span> : null}
            <span
              data-testid="folder-path-segment"
              className={`min-w-0 truncate ${segmentClassName} ${i === shown.length - 1 ? lastClassName : ''}`}
            >
              {segment}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * The card's bottom-slot line for a proposal filed into a folder (Part XVII §17.2),
 * or the deleted-folder state (§17.5) — `Folder deleted` behind lucide `folder-x`,
 * the words in `--el-text-strong`. Text first; the glyph and the badge are the
 * second and third channels.
 */
export function PlacementLine({
  folderPath,
  folderMissing,
}: {
  folderPath: readonly string[] | null;
  folderMissing: boolean;
}) {
  const t = useTranslations('planReview');
  if (folderMissing) {
    return (
      <div
        data-testid="placement-line"
        data-folder-missing="true"
        className="mt-1.5 flex shrink-0 items-center gap-1 overflow-hidden text-xs"
      >
        <FolderX className="size-3.5 shrink-0 text-(--el-text-secondary)" aria-hidden="true" />
        <span className="sr-only">{t('folderMissingAria')}</span>
        <span className="truncate font-medium text-(--el-text-strong)" aria-hidden="true">
          {t('folderMissing')}
        </span>
      </div>
    );
  }
  if (!folderPath || folderPath.length === 0) return null;
  return (
    <div
      data-testid="placement-line"
      className="mt-1.5 flex shrink-0 items-center overflow-hidden text-xs"
    >
      <FolderPathLabel
        path={folderPath}
        max={3}
        srText={t('placementFiledIn', { path: folderPathText(folderPath) })}
      />
    </div>
  );
}

/**
 * One SIDE of a placement change, in a diff (Part XVII §17.4): a folder side
 * carries the glyph and its path; the project root reads `Project root` once a
 * folder is on the other side; a work item keeps its identifier.
 */
export function PlacementSide({
  side,
  fallback,
  max,
  className,
  segmentClassName = '',
}: {
  side: PlanPlacementSideDto;
  /** The plain string the change row carries for this side (a key, or null). */
  fallback: string | null;
  max: number;
  /** The side's ink (and weight) — old and new sides differ. */
  className: string;
  /** The struck old side's strike, applied per segment. */
  segmentClassName?: string;
}) {
  const t = useTranslations('planReview');
  const tf = useTranslations('folders');
  if (side.kind === 'folder') {
    if (side.folderMissing || !side.folderPath) {
      return (
        <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
          <FolderX className="size-3 shrink-0" aria-hidden="true" />
          <span className={`truncate ${segmentClassName}`}>{t('folderMissing')}</span>
        </span>
      );
    }
    return (
      <FolderPathLabel
        path={side.folderPath}
        max={max}
        glyphClassName="size-3"
        lastClassName=""
        toneClassName={className}
        segmentClassName={segmentClassName}
      />
    );
  }
  if (side.kind === 'root') {
    return <span className={`truncate ${className} ${segmentClassName}`}>{tf('projectRoot')}</span>;
  }
  const proposed = proposedParentLabel(side, t('proposedCrumb'));
  return (
    <span className={`truncate ${className} ${segmentClassName}`} title={proposed ?? undefined}>
      {proposed ?? side.identifier ?? fallback ?? '—'}
    </span>
  );
}

/**
 * A PROPOSED parent — an `add` in this plan that approve has not created yet —
 * named in the breadcrumb's own grammar, `New · <title>` (MOTIR-6055 ·
 * `design-notes.md` Part XIX §19.3), so the reader sees the same words on the
 * card as in the crumb of the level it is drawn on. `null` for every other side:
 * a committed parent (and an APPROVED add) is named by its key.
 */
export function proposedParentLabel(
  side: PlanPlacementSideDto | undefined,
  proposedWord: string,
): string | null {
  if (side?.kind !== 'workItem' || side.identifier != null || !side.proposedTitle) return null;
  return workItemCrumbLabel(proposedWord, side.proposedTitle);
}

/** The NEW side of a change as the reader's words: the proposed-parent label for
 *  a move under an un-created `add`, else the change's own `to`. */
export function changeToText(change: PlanItemChangeDto, proposedWord: string): string | null {
  return (
    (change.field === 'parent' ? proposedParentLabel(change.placement?.to, proposedWord) : null) ??
    change.to
  );
}

/** True when a `parent` change moves a card into or out of a FOLDER — the row is
 *  then labelled `Placement`, because a folder is not a parent (§17.4). */
export function isFolderPlacementChange(change: {
  field: string;
  placement?: { from: PlanPlacementSideDto; to: PlanPlacementSideDto };
}): boolean {
  return (
    change.field === 'parent' &&
    change.placement !== undefined &&
    (change.placement.from.kind === 'folder' || change.placement.to.kind === 'folder')
  );
}
