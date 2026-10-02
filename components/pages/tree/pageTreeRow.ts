import type { CSSProperties, FocusEventHandler, KeyboardEventHandler } from 'react';
import type { PageParentDto, PageTreeRowDto } from '@/lib/dto/pages';

// The `/pages` tree's shared row vocabulary (Story MOTIR-5753 · MOTIR-7373) —
// `design/pages/design-notes.md` § The page tree. Kept apart from `PageTree.tsx`
// so the two row components and the tree agree on one set of names without a
// circular import.

export type PageTreeFolderRowDto = Extract<PageTreeRowDto, { kind: 'folder' }>;
export type PageTreePageRowDto = Extract<PageTreeRowDto, { kind: 'page' }>;

/**
 * A level's key, which is also the key of the ROW that owns it: `root`,
 * `folder:<id>` or `page:<id>` — the `parent` query `GET /api/pages/tree` takes.
 */
export type LevelKey = string;

export const ROOT_LEVEL: LevelKey = 'root';

/** The key of a row — and of the level its children make. */
export function rowKey(row: PageTreeRowDto): LevelKey {
  return `${row.kind}:${row.id}`;
}

/** The level a create under `parent` lands in. */
export function parentKey(parent: PageParentDto): LevelKey {
  return parent.kind === 'root' ? ROOT_LEVEL : `${parent.kind}:${parent.id}`;
}

/** The parent a level key names. */
export function parentOf(key: LevelKey): PageParentDto {
  if (key === ROOT_LEVEL) return { kind: 'root' };
  const at = key.indexOf(':');
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  return kind === 'folder' ? { kind: 'folder', id } : { kind: 'page', id };
}

/**
 * Row metrics per density. `default` is `/pages`' — `TreeTable`'s 40px rows and
 * 22px per level, after a 6px gutter the drag handle (MOTIR-7376) sits in.
 * `compact` is the page route's sidebar (MOTIR-7375, `page--tree-sidebar.mock.html`):
 * 32px rows, 14px per level.
 */
export const DENSITY = {
  default: { rowPx: 40, indentPx: 22, gutterPx: 6 },
  compact: { rowPx: 32, indentPx: 14, gutterPx: 6 },
} as const;

export type PageTreeDensity = keyof typeof DENSITY;

/** What every treeitem carries — the tree owns focus, keys and placement. */
export interface TreeItemProps {
  depth: number;
  tabIndex: 0 | -1;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onFocus: FocusEventHandler<HTMLDivElement>;
  style: CSSProperties;
}

/**
 * A row's own chrome — `TreeTable`'s row grammar inside `role="tree"`: the ink,
 * the hover fill, and the focus ring drawn INSET so it never spills under the
 * neighbouring rule. Rules between rows come from the tree's `divide-y`.
 */
export const TREE_ROW_CLASS =
  'relative flex items-center gap-2 pr-2 text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-inset';

/** The chevron button's own chrome — a 16px slot, out of the tab order. */
export const CHEVRON_CLASS =
  'relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-icon-muted) hover:text-(--el-text) focus-visible:outline-none';
