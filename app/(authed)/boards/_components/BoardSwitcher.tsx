'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Check,
  ChevronDown,
  Columns3,
  Info,
  MoreHorizontal,
  Pencil,
  Plus,
  Rows3,
  Star,
  Trash2,
} from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { BoardSummaryDto } from '@/lib/dto/boards';
import {
  applyDefault,
  applyDelete,
  resolveActiveBoardId,
  sortBoards,
  upsertBoard,
} from './multiBoardState';

// BoardSwitcher (Subtask 3.7.4) — the multi-board switcher + create / rename /
// set-default / delete UI on `/boards`, per `design/boards/multi-board.mock.html`
// (3.7.1) + the "Multiple boards (Story 3.7)" design notes. A PURE CONSUMER of
// the 3.7.3 board API:
//   - GET    /api/boards          → the project's boards as switcher rows
//   - POST   /api/boards          → create (seeds default columns; non-default)
//   - PATCH  /api/boards/[id]     → rename ({name}) / set-default ({isDefault:true})
//   - DELETE /api/boards/[id]     → delete (guards: last-board 409, promote-default)
//
// The selected board is URL-addressable via `?board=<id>` (mirroring the 2.5.19
// `?peek` pattern — shareable, reload-safe), defaulting to the project's
// `isDefault` board when absent. Picking a board pushes `?board=<id>`;
// `BoardContainer` reads that param and re-lays from the selected board's
// projection (the server read is wired by Subtask 3.7.5 — until then the GET
// returns the default board, so the switch updates the URL + refetches but the
// projection is the default's; the switcher UI itself is complete).
//
// Lives in the board page header (always present — independent of the board
// PROJECTION's loading / error / empty states, so you can always switch away),
// at the left of the toolbar before the disabled [Filter] seam + [+ New issue].
//
// Writes are optimistic-with-reconcile against the 3.7.3 endpoints; a failed
// write reverts the optimistic list + a danger Toast. Outcomes (switch, create,
// delete-and-promote) are announced via an aria-live region. Colour strictly via
// `--el-*` (the Default badge = the neutral Pill, the active-board check + the
// New-board action via `--el-accent`, the delete callout via `--el-tint-sky`,
// danger Delete via `--el-danger`); shape via element-semantic tokens; the
// switcher is a `role="menu"` with `menuitemradio` rows, no nested buttons (a
// row is a div holding the pick + manage buttons as siblings).
//
// Permissions: board CRUD is a project-config write. Roles are Epic 6.4, so the
// affordances are membership-gated NOW (any member) with `canManage` defaulting
// true; `TODO(6.4)`: pass the project-admin flag so a non-admin sees the switcher
// (to switch) with New / manage hidden, and the server re-gates every write 403.

type BoardType = 'kanban' | 'scrum';

const NAME_MAX = 80;

export function BoardSwitcher({
  // TODO(6.4): wire to the project-admin role (matching 2.2.5 / 3.3 / 3.6). Today
  // board CRUD is membership-gated — any project member manages boards.
  canManage = true,
}: {
  canManage?: boolean;
}) {
  const t = useTranslations('boards');
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const boardParam = searchParams?.get('board') ?? null;

  // null = the board list is still loading (skeleton trigger); the load error is
  // a separate flag so a failed list load shows the inline retry, never blanks.
  const [boards, setBoards] = useState<BoardSummaryDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [menuOpen, setMenuOpen] = useState(false);
  // Which row's manage [⋯] submenu is open (an id, or null). Lives INSIDE the
  // switcher Popover content (absolutely positioned within the row), so it never
  // dismisses the outer popover.
  const [manageId, setManageId] = useState<string | null>(null);

  // Modal targets (null = closed). Rename / delete carry the board they act on.
  const [newOpen, setNewOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<BoardSummaryDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BoardSummaryDto | null>(null);

  const [live, setLive] = useState('');
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Plain handlers (no manual useCallback): React Compiler auto-memoizes this
  // component, so manual memoization is redundant here and the deps are inferred.
  const announce = (message: string) => {
    setLive(message);
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => setLive(''), 4000);
  };
  useEffect(() => () => void (liveTimer.current && clearTimeout(liveTimer.current)), []);

  // Load the project's boards (independent of the board projection BoardContainer
  // fetches). Re-runs on retry.
  useEffect(() => {
    let active = true;
    fetch('/api/boards', { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`boards ${res.status}`);
        const data = (await res.json()) as { boards: BoardSummaryDto[] };
        if (active) {
          setBoards(sortBoards(data.boards));
          setLoadError(false);
        }
      })
      .catch(() => {
        if (active) {
          setBoards(null);
          setLoadError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  // Navigate to a board by writing `?board=<id>`, preserving every other param
  // (mirrors usePeekOpen, Subtask 2.5.19). BoardContainer reads the param and
  // re-lays. Closes the menu.
  const selectBoard = (id: string) => {
    const params = new URLSearchParams(searchParams?.toString());
    params.set('board', id);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
    setMenuOpen(false);
    setManageId(null);
  };

  const activeId = boards ? resolveActiveBoardId(boards, boardParam) : null;
  const activeBoard = boards?.find((b) => b.id === activeId) ?? null;
  const isLastBoard = (boards?.length ?? 0) <= 1;

  // ── Create ────────────────────────────────────────────────────────────────
  const createBoard = async (name: string, type: BoardType) => {
    const res = await fetch('/api/boards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name, type }),
    });
    if (!res.ok) throw new Error(`create ${res.status}`);
    const created = (await res.json()) as BoardSummaryDto;
    setBoards((prev) => upsertBoard(prev ?? [], created));
    setNewOpen(false);
    announce(t('boardCreatedAnnounce', { name: created.name }));
    selectBoard(created.id);
  };

  // ── Rename ──────────────────────────────────────────────────────────────── (optimistic + reconcile)
  const renameBoard = async (board: BoardSummaryDto, name: string) => {
    const snapshot = boards;
    setBoards((prev) => (prev ?? []).map((b) => (b.id === board.id ? { ...b, name } : b)));
    setRenameTarget(null);
    try {
      const res = await fetch(`/api/boards/${board.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`rename ${res.status}`);
      const dto = (await res.json()) as BoardSummaryDto;
      setBoards((prev) => upsertBoard(prev ?? [], dto));
      announce(t('boardRenamedAnnounce', { name: dto.name }));
    } catch {
      if (snapshot) setBoards(snapshot);
      toast({
        variant: 'error',
        title: t('boardWriteErrorTitle'),
        description: t('boardRenameErrorDescription'),
      });
    }
  };

  // ── Set default ───────────────────────────────────────────────────────────
  const setDefaultBoard = async (board: BoardSummaryDto) => {
    const snapshot = boards;
    setBoards((prev) => applyDefault(prev ?? [], board.id));
    setManageId(null);
    try {
      const res = await fetch(`/api/boards/${board.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });
      if (!res.ok) throw new Error(`set-default ${res.status}`);
      const dto = (await res.json()) as BoardSummaryDto;
      setBoards((prev) => applyDefault(upsertBoard(prev ?? [], dto), dto.id));
      announce(t('boardSetDefaultAnnounce', { name: dto.name }));
    } catch {
      if (snapshot) setBoards(snapshot);
      toast({
        variant: 'error',
        title: t('boardWriteErrorTitle'),
        description: t('boardSetDefaultErrorDescription'),
      });
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────── (issues survive on the project)
  const deleteBoard = async (board: BoardSummaryDto) => {
    const snapshot = boards;
    const wasActive = board.id === activeId;
    const { boards: next, promotedDefaultId } = applyDelete(boards ?? [], board.id);
    setBoards(next);
    setDeleteTarget(null);
    setMenuOpen(false);
    try {
      const res = await fetch(`/api/boards/${board.id}`, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`delete ${res.status}`);
      const fallback = promotedDefaultId ?? next.find((b) => b.isDefault)?.id ?? next[0]?.id;
      announce(
        t('boardDeletedAnnounce', {
          name: board.name,
          current: next.find((b) => b.id === fallback)?.name ?? '',
        }),
      );
      // If the deleted board was the one being viewed, switch to the promoted
      // default so the board page isn't left pointing at a gone board.
      if (wasActive && fallback) selectBoard(fallback);
    } catch {
      if (snapshot) setBoards(snapshot);
      toast({
        variant: 'error',
        title: t('boardWriteErrorTitle'),
        description: t('boardDeleteErrorDescription'),
      });
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <button
        type="button"
        data-testid="board-switcher-retry"
        onClick={() => {
          setBoards(null);
          setLoadError(false);
          setReloadKey((k) => k + 1);
        }}
        className="inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) text-sm text-(--el-text-muted) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {t('boardListErrorRetry')}
      </button>
    );
  }

  if (!boards || !activeBoard) {
    // Skeleton trigger while the board list resolves (design: states section).
    return (
      <div
        data-testid="board-switcher-skeleton"
        aria-hidden
        className="h-(--height-control) w-40 animate-pulse rounded-(--radius-input) bg-(--el-muted)"
      />
    );
  }

  return (
    <div className="flex items-center">
      <Popover
        open={menuOpen}
        onOpenChange={(o) => {
          setMenuOpen(o);
          if (!o) setManageId(null);
        }}
      >
        <Popover.Trigger
          aria-label={t('switcherTriggerAria')}
          aria-haspopup="menu"
          data-testid="board-switcher-trigger"
          className="inline-flex h-(--height-control) max-w-[260px] items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) font-sans text-sm font-semibold text-(--el-text-strong) hover:border-(--el-border-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none data-[state=open]:border-(--el-border-strong) data-[state=open]:shadow-(--shadow-subtle)"
        >
          <Columns3 className="h-[15px] w-[15px] shrink-0 text-(--el-text-muted)" aria-hidden />
          <span className="truncate">{activeBoard.name}</span>
          {activeBoard.isDefault ? (
            <Pill tone="neutral" data-testid="board-switcher-active-default">
              {t('defaultBadge')}
            </Pill>
          ) : null}
          <ChevronDown className="ml-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
        </Popover.Trigger>

        <Popover.Content
          align="start"
          width={300}
          role="menu"
          aria-label={t('switcherMenuAria')}
          data-testid="board-switcher-menu"
          // overflow-visible (twMerge overrides the primitive's base overflow-hidden)
          // so the per-board manage `[⋯]` flyout — absolutely positioned inside this
          // content — isn't CLIPPED by the popover box (it opens below/right of a row).
          className="overflow-visible p-0"
        >
          <div className="flex flex-col gap-0.5 p-1.5">
            <p className="px-2 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
              {t('switcherMenuCap')}
            </p>

            {boards.map((board) => {
              const isActive = board.id === activeId;
              return (
                <div
                  key={board.id}
                  role="presentation"
                  className={`relative flex items-center gap-0.5 rounded-(--radius-control) ${
                    isActive ? 'bg-(--el-muted)' : 'hover:bg-(--el-muted)'
                  }`}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    data-testid={`board-switcher-pick-${board.id}`}
                    onClick={() => selectBoard(board.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13.5px] text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                  >
                    <Check
                      className={`h-[15px] w-[15px] shrink-0 text-(--el-accent) ${
                        isActive ? '' : 'invisible'
                      }`}
                      aria-hidden
                    />
                    <span className="truncate">{board.name}</span>
                    {board.isDefault ? (
                      <Pill tone="neutral" data-testid={`board-switcher-default-${board.id}`}>
                        {t('defaultBadge')}
                      </Pill>
                    ) : null}
                  </button>

                  {canManage ? (
                    <button
                      type="button"
                      aria-label={t('manageBoardAria', { name: board.name })}
                      aria-haspopup="menu"
                      aria-expanded={manageId === board.id}
                      data-testid={`board-switcher-manage-${board.id}`}
                      onClick={() => setManageId((cur) => (cur === board.id ? null : board.id))}
                      className="mr-0.5 inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                    >
                      <MoreHorizontal className="h-4 w-4" aria-hidden />
                    </button>
                  ) : null}

                  {manageId === board.id ? (
                    <div
                      role="menu"
                      aria-label={t('manageBoardAria', { name: board.name })}
                      data-testid={`board-switcher-manage-menu-${board.id}`}
                      className="absolute top-8 right-0 z-10 flex w-56 flex-col gap-0.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-1.5 shadow-(--shadow-elevated)"
                    >
                      <ManageItem
                        icon={<Pencil className="h-4 w-4" aria-hidden />}
                        label={t('renameBoard')}
                        testId={`board-switcher-rename-${board.id}`}
                        onClick={() => {
                          setManageId(null);
                          setMenuOpen(false);
                          setRenameTarget(board);
                        }}
                      />
                      <ManageItem
                        icon={<Star className="h-4 w-4" aria-hidden />}
                        label={t('setDefaultBoard')}
                        testId={`board-switcher-setdefault-${board.id}`}
                        disabled={board.isDefault}
                        onClick={() => void setDefaultBoard(board)}
                      />
                      <div className="mx-0.5 my-1 h-px bg-(--el-border)" />
                      <ManageItem
                        icon={<Trash2 className="h-4 w-4" aria-hidden />}
                        label={t('deleteBoard')}
                        testId={`board-switcher-delete-${board.id}`}
                        danger
                        disabled={isLastBoard}
                        onClick={() => {
                          setManageId(null);
                          setMenuOpen(false);
                          setDeleteTarget(board);
                        }}
                      />
                      {isLastBoard ? (
                        <p
                          data-testid="board-switcher-lastboard-note"
                          className="px-2 pt-1 pb-0.5 text-[11.5px] leading-snug text-(--el-text-muted)"
                        >
                          {t('lastBoardNote')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {canManage ? (
              <>
                <div className="mx-0.5 my-1 h-px bg-(--el-border)" />
                <button
                  type="button"
                  role="menuitem"
                  data-testid="board-switcher-new"
                  onClick={() => {
                    setMenuOpen(false);
                    setManageId(null);
                    setNewOpen(true);
                  }}
                  className="flex items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13.5px] font-medium text-(--el-accent) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                >
                  <Plus className="h-4 w-4 shrink-0" aria-hidden />
                  {t('newBoard')}
                </button>
              </>
            ) : null}
          </div>
        </Popover.Content>
      </Popover>

      {/* aria-live: switch / create / rename / delete-and-promote outcomes. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="board-switcher-live">
        {live}
      </span>

      {newOpen ? (
        <BoardFormModal
          mode="create"
          onClose={() => setNewOpen(false)}
          onSubmit={async (name, type) => {
            try {
              await createBoard(name, type);
            } catch {
              toast({
                variant: 'error',
                title: t('boardWriteErrorTitle'),
                description: t('boardCreateErrorDescription'),
              });
            }
          }}
        />
      ) : null}

      {renameTarget ? (
        <BoardFormModal
          mode="rename"
          initialName={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          onSubmit={async (name) => renameBoard(renameTarget, name)}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteBoardModal
          name={deleteTarget.name}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void deleteBoard(deleteTarget)}
        />
      ) : null}
    </div>
  );
}

function ManageItem({
  icon,
  label,
  testId,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={`flex items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13.5px] focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 ${
        danger
          ? 'text-(--el-danger) hover:bg-(--el-tint-rose)'
          : 'text-(--el-text) hover:bg-(--el-muted)'
      }`}
    >
      <span className={`shrink-0 ${danger ? 'text-(--el-danger)' : 'text-(--el-text-muted)'}`}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

// The create / rename modal — an Input (name) + (create only) a Kanban/Scrum
// type picker (Scrum disabled, Epic 4). Submitting hands the trimmed name (+
// type) up; an empty name is blocked client-side (mirrors the service guard).
function BoardFormModal({
  mode,
  initialName = '',
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'rename';
  initialName?: string;
  onClose: () => void;
  onSubmit: (name: string, type: BoardType) => void | Promise<void>;
}) {
  const t = useTranslations('boards');
  const [name, setName] = useState(initialName);
  const [type] = useState<BoardType>('kanban');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('boardNameRequired'));
      return;
    }
    setSaving(true);
    try {
      await onSubmit(trimmed, type);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="sm"
      title={mode === 'create' ? t('newBoardTitle') : t('renameBoardTitle')}
    >
      <div className="flex flex-col gap-4">
        <Input
          label={t('boardNameLabel')}
          autoFocus
          value={name}
          maxLength={NAME_MAX}
          error={error ?? undefined}
          data-testid={mode === 'create' ? 'board-new-name' : 'board-rename-name'}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />

        {mode === 'create' ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-(--el-text-secondary)">
              {t('boardTypeLabel')}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <div
                data-testid="board-type-kanban"
                aria-checked
                role="radio"
                className="flex items-center gap-2 rounded-(--radius-input) border border-(--el-accent) bg-(--el-muted) px-(--spacing-control-x) py-(--spacing-control-y) text-sm font-medium text-(--el-text)"
              >
                <Columns3 className="h-4 w-4 shrink-0 text-(--el-accent)" aria-hidden />
                {t('boardTypeKanban')}
              </div>
              <div
                data-testid="board-type-scrum"
                aria-checked={false}
                aria-disabled
                role="radio"
                className="flex items-center gap-2 rounded-(--radius-input) border border-(--el-border) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-muted) opacity-60"
              >
                <Rows3 className="h-4 w-4 shrink-0" aria-hidden />
                {t('boardTypeScrum')}
                <Pill tone="neutral" className="ml-auto">
                  {t('epic4Badge')}
                </Pill>
              </div>
            </div>
            <p className="mt-0.5 text-[11.5px] leading-snug text-(--el-text-muted)">
              {t('newBoardSeedHint')}
            </p>
          </fieldset>
        ) : null}
      </div>

      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          loading={saving}
          onClick={() => void submit()}
          data-testid={mode === 'create' ? 'board-new-submit' : 'board-rename-submit'}
        >
          {mode === 'create' ? t('createBoard') : t('save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

// The destructive delete confirm — a danger title + an info callout making the
// board-≠-issue-owner contract explicit (issues survive on the project), then a
// danger confirm. The callout puts the hue in the tinted BACKGROUND with
// `--el-text-strong` (finding #35).
function DeleteBoardModal({
  name,
  onClose,
  onConfirm,
}: {
  name: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('boards');
  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="sm"
      title={t('deleteBoardTitle', { name })}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-(--el-text-secondary)">{t('deleteBoardBody')}</p>
        <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) text-sm text-(--el-text-strong)">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <b>{t('deleteBoardCalloutLead')}</b> {t('deleteBoardCalloutBody')}
          </span>
        </div>
      </div>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="danger"
          leftIcon={<Trash2 className="h-4 w-4" />}
          data-testid="board-delete-confirm"
          onClick={onConfirm}
        >
          {t('deleteBoardConfirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
