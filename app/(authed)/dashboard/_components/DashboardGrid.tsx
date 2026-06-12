'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Ellipsis,
  LayoutDashboard,
  Lock,
  Pencil,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Link from 'next/link';
import type { DashboardAccess, DashboardLayout, DashboardWidgetType } from '@prisma/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import { useToast } from '@/components/ui/Toast';
import { DASHBOARD_MAX_WIDGETS } from '@/lib/dashboards/constants';
import { WIDGET_REGISTRY } from '@/lib/dashboards/widgetRegistry';
import type {
  DashboardDetailDto,
  DashboardSummaryDto,
  DashboardWidgetDto,
} from '@/lib/dto/dashboards';
import { AccessCards } from './AccessCards';
import { AddWidgetModal } from './AddWidgetModal';
import { WidgetCard } from './WidgetCard';
import { WidgetConfigModal, emptyDraft, type WidgetDraft } from './WidgetConfigModal';
import type { ProjectLite } from './DataSourceField';
import { columnCount, computeWidgetMove, reflowToLayout, widgetsByColumn } from './gridModel';

// The dashboard grid (6.3.5, design panels 2/3) — view vs edit, the 1/2/3
// column layout picker, the registry-driven add-widget flow, per-widget
// configure/remove, and cross-column drag (the 3.2 dnd-kit vocabulary;
// server-minted fractional positions via the 6.3.1 move endpoint, optimistic
// with rollback). Owner-only edit affordances; a workspace viewer gets the
// read-only grid (each widget still gated per-VIEWER by the 6.3.2 reads).

interface ConfigState {
  open: boolean;
  mode: 'create' | 'edit';
  type: DashboardWidgetType;
  editorKind: string;
  widgetId?: string;
  initial?: WidgetDraft;
}

const LAYOUTS: DashboardLayout[] = ['one', 'two', 'three'];

export function DashboardGrid({
  detail,
  dashboards,
  projects,
}: {
  detail: DashboardDetailDto;
  dashboards: DashboardSummaryDto[];
  projects: ProjectLite[];
}) {
  const t = useTranslations('dashboards');
  const tToast = useTranslations('dashboards.toast');
  const { toast } = useToast();
  const router = useRouter();

  const isOwner = detail.isOwner;
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [name, setName] = useState(detail.name);
  const [access, setAccess] = useState<DashboardAccess>(detail.access);
  const [layout, setLayout] = useState<DashboardLayout>(detail.layout);
  const [widgets, setWidgets] = useState<DashboardWidgetDto[]>(detail.widgets);

  const [addOpen, setAddOpen] = useState(false);
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [removeTarget, setRemoveTarget] = useState<DashboardWidgetDto | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeDrag, setActiveDrag] = useState<string | null>(null);

  const colCount = columnCount(layout);
  const cols = widgetsByColumn(widgets, colCount);
  const atCap = widgets.length >= DASHBOARD_MAX_WIDGETS;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const toastError = useCallback(
    (description: string) => toast({ variant: 'error', title: tToast('errorTitle'), description }),
    [toast, tToast],
  );

  // ── Widget move (dnd) — optimistic with rollback ──
  const moveWidget = useCallback(
    (activeId: string, targetColumn: number, overWidgetId: string | null) => {
      const snap = widgets;
      const plan = computeWidgetMove(snap, activeId, targetColumn, overWidgetId);
      if (!plan) return;
      setWidgets(plan.widgets);
      void fetch(
        `/api/dashboards/${encodeURIComponent(detail.id)}/widgets/${encodeURIComponent(
          activeId,
        )}/move`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            column: plan.column,
            afterId: plan.afterId,
            beforeId: plan.beforeId,
          }),
        },
      )
        .then((res) => {
          if (!res.ok) {
            setWidgets(snap);
            toastError(tToast('moveWidgetError'));
          }
        })
        .catch(() => {
          setWidgets(snap);
          toastError(tToast('moveWidgetError'));
        });
    },
    [widgets, detail.id, toastError, tToast],
  );

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveDrag(null);
      const { active, over } = e;
      if (!over) return;
      const overData = over.data.current as { type?: string; column?: number } | undefined;
      if (overData?.type === 'widget' && typeof overData.column === 'number') {
        moveWidget(String(active.id), overData.column, String(over.id));
      } else if (overData?.type === 'column' && typeof overData.column === 'number') {
        moveWidget(String(active.id), overData.column, null);
      }
    },
    [moveWidget],
  );

  // ── Layout change — optimistic + reflow, then refetch authoritative ──
  const changeLayout = useCallback(
    (next: DashboardLayout) => {
      if (next === layout) return;
      const snapLayout = layout;
      const snapWidgets = widgets;
      setLayout(next);
      setWidgets((ws) => reflowToLayout(ws, columnCount(next)));
      void fetch(`/api/dashboards/${encodeURIComponent(detail.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ layout: next }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`layout ${res.status}`);
          // Pull the authoritative reflowed widget columns/positions.
          const fresh = await fetch(`/api/dashboards/${encodeURIComponent(detail.id)}`, {
            headers: { accept: 'application/json' },
          });
          if (fresh.ok) {
            const body = (await fresh.json()) as { dashboard: DashboardDetailDto };
            setWidgets(body.dashboard.widgets);
          }
        })
        .catch(() => {
          setLayout(snapLayout);
          setWidgets(snapWidgets);
          toastError(tToast('layoutError'));
        });
    },
    [layout, widgets, detail.id, toastError, tToast],
  );

  // ── Add / configure / remove widgets ──
  const openCreate = useCallback((type: DashboardWidgetType, editorKind: string) => {
    setAddOpen(false);
    setConfig({ open: true, mode: 'create', type, editorKind, initial: emptyDraft() });
  }, []);

  const openConfigure = useCallback((widget: DashboardWidgetDto) => {
    const editorKind = WIDGET_REGISTRY[widget.type].editorKind;
    setConfig({
      open: true,
      mode: 'edit',
      type: widget.type,
      editorKind,
      widgetId: widget.id,
      initial: draftFromWidget(widget),
    });
  }, []);

  const onWidgetSaved = useCallback((saved: DashboardWidgetDto) => {
    setWidgets((ws) => {
      const exists = ws.some((w) => w.id === saved.id);
      return exists ? ws.map((w) => (w.id === saved.id ? saved : w)) : [...ws, saved];
    });
  }, []);

  const confirmRemove = useCallback(
    (widget: DashboardWidgetDto) => {
      const snap = widgets;
      setRemoveTarget(null);
      setWidgets((ws) => ws.filter((w) => w.id !== widget.id));
      void fetch(
        `/api/dashboards/${encodeURIComponent(detail.id)}/widgets/${encodeURIComponent(widget.id)}`,
        { method: 'DELETE', headers: { accept: 'application/json' } },
      )
        .then((res) => {
          if (!res.ok) {
            setWidgets(snap);
            toastError(tToast('removeWidgetError'));
          }
        })
        .catch(() => {
          setWidgets(snap);
          toastError(tToast('removeWidgetError'));
        });
    },
    [widgets, detail.id, toastError, tToast],
  );

  // ── Dashboard-level: rename / access / delete ──
  const rename = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (!trimmed || trimmed === name) {
        setRenameOpen(false);
        return;
      }
      const snap = name;
      setName(trimmed);
      setRenameOpen(false);
      void fetch(`/api/dashboards/${encodeURIComponent(detail.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
        .then((res) => {
          if (!res.ok) {
            setName(snap);
            toastError(tToast('renameError'));
          }
        })
        .catch(() => {
          setName(snap);
          toastError(tToast('renameError'));
        });
    },
    [name, detail.id, toastError, tToast],
  );

  const changeAccess = useCallback(
    (next: DashboardAccess) => {
      const snap = access;
      setAccess(next);
      setAccessOpen(false);
      void fetch(`/api/dashboards/${encodeURIComponent(detail.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ access: next }),
      })
        .then((res) => {
          if (!res.ok) {
            setAccess(snap);
            toastError(tToast('accessError'));
          }
        })
        .catch(() => {
          setAccess(snap);
          toastError(tToast('accessError'));
        });
    },
    [access, detail.id, toastError, tToast],
  );

  const deleteDashboard = useCallback(() => {
    setDeleteOpen(false);
    void fetch(`/api/dashboards/${encodeURIComponent(detail.id)}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
      .then((res) => {
        if (res.ok) router.push('/dashboard');
        else toastError(tToast('deleteError'));
      })
      .catch(() => toastError(tToast('deleteError')));
  }, [detail.id, router, toastError, tToast]);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <nav
            className="flex items-center gap-1 text-xs text-(--el-text-muted)"
            aria-label="Breadcrumb"
          >
            <Link href="/dashboard" className="hover:text-(--el-text) hover:underline">
              {t('backToList')}
            </Link>
            <ChevronRight className="size-3.5" aria-hidden />
            <span className="text-(--el-text-secondary)">{name}</span>
          </nav>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{name}</h1>
            <DashboardSwitcher current={detail.id} dashboards={dashboards} />
          </div>
          <div className="mt-1 flex items-center gap-2 text-sm text-(--el-text-muted)">
            <AccessPill access={access} />
            <span>
              {isOwner
                ? t('grid.ownerMeta', { count: widgets.length })
                : t('grid.sharedMeta', { owner: detail.owner.name, count: widgets.length })}
            </span>
          </div>
        </div>

        {isOwner ? (
          <div className="flex items-center gap-2">
            {mode === 'view' ? (
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Pencil className="size-4" />}
                onClick={() => setMode('edit')}
              >
                {t('grid.edit')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Check className="size-4" />}
                onClick={() => setMode('view')}
              >
                {t('grid.done')}
              </Button>
            )}
            <DashboardOptionsMenu
              onRename={() => setRenameOpen(true)}
              onAccess={() => setAccessOpen(true)}
              onDelete={() => setDeleteOpen(true)}
            />
          </div>
        ) : null}
      </header>

      {mode === 'edit' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-3 py-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-(--el-text-strong)">
              {t('grid.layoutLabel')}
            </span>
            <LayoutPicker layout={layout} onChange={changeLayout} />
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Plus className="size-4" />}
              disabled={atCap}
              onClick={() => setAddOpen(true)}
              data-testid="dashboard-add-widget"
            >
              {t('grid.addWidget')}
            </Button>
          </div>
          <span
            className={`flex items-center gap-1.5 text-xs ${atCap ? 'text-(--el-warning)' : 'text-(--el-text-muted)'}`}
          >
            {atCap ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
            {atCap
              ? t('grid.capReachedNote', { max: DASHBOARD_MAX_WIDGETS })
              : t('grid.capNote', { count: widgets.length, max: DASHBOARD_MAX_WIDGETS })}
          </span>
        </div>
      ) : null}

      {widgets.length === 0 ? (
        <EmptyGrid owner={isOwner} onAdd={() => setAddOpen(true)} editing={mode === 'edit'} />
      ) : mode === 'edit' && isOwner ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={(e: DragStartEvent) => setActiveDrag(String(e.active.id))}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          <Grid colCount={colCount}>
            {cols.map((colWidgets, c) => (
              <EditColumn key={c} column={c}>
                <SortableContext
                  items={colWidgets.map((w) => w.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {colWidgets.map((w) => (
                    <SortableWidget
                      key={w.id}
                      widget={w}
                      onConfigure={openConfigure}
                      onRemove={(widget) => setRemoveTarget(widget)}
                    />
                  ))}
                </SortableContext>
              </EditColumn>
            ))}
          </Grid>
          <DragOverlay>
            {activeDrag ? (
              <div className="rounded-(--radius-card) border border-(--el-accent) bg-(--el-page-bg) px-3 py-2 text-sm font-semibold text-(--el-text-secondary) shadow-(--shadow-elevated)">
                {widgets.find((w) => w.id === activeDrag)
                  ? deriveTitleSafe(widgets.find((w) => w.id === activeDrag)!, t)
                  : null}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <Grid colCount={colCount}>
          {cols.map((colWidgets, c) => (
            <div
              key={c}
              className="flex flex-col gap-4"
              aria-label={t('grid.columnAria', { n: c + 1 })}
            >
              {colWidgets.map((w) => (
                <WidgetCard
                  key={w.id}
                  widget={w}
                  mode="view"
                  isOwner={isOwner}
                  onConfigure={openConfigure}
                  onRemove={(widget) => setRemoveTarget(widget)}
                />
              ))}
            </div>
          ))}
        </Grid>
      )}

      {/* ── Modals ── */}
      <AddWidgetModal open={addOpen} onOpenChange={setAddOpen} onPick={openCreate} />

      {config ? (
        <WidgetConfigModal
          open={config.open}
          onOpenChange={(o) => setConfig((c) => (c ? { ...c, open: o } : c))}
          mode={config.mode}
          type={config.type}
          editorKind={config.editorKind}
          dashboardId={detail.id}
          widgetId={config.widgetId}
          projects={projects}
          initial={config.initial}
          onSaved={onWidgetSaved}
        />
      ) : null}

      {removeTarget ? (
        <RemoveWidgetModal
          widget={removeTarget}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => confirmRemove(removeTarget)}
        />
      ) : null}

      {renameOpen ? (
        <RenameModal initial={name} onCancel={() => setRenameOpen(false)} onSave={rename} />
      ) : null}

      {accessOpen ? (
        <AccessModal initial={access} onCancel={() => setAccessOpen(false)} onSave={changeAccess} />
      ) : null}

      {deleteOpen ? (
        <DeleteModal
          name={name}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={deleteDashboard}
        />
      ) : null}
    </div>
  );
}

// ── Layout helpers ───────────────────────────────────────────────────────────

function Grid({ colCount, children }: { colCount: number; children: React.ReactNode }) {
  const colsClass =
    colCount === 1 ? 'sm:grid-cols-1' : colCount === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3';
  return <div className={`grid grid-cols-1 gap-4 ${colsClass}`}>{children}</div>;
}

function EditColumn({ column, children }: { column: number; children: React.ReactNode }) {
  const t = useTranslations('dashboards');
  const { setNodeRef, isOver } = useDroppable({
    id: `col-${column}`,
    data: { type: 'column', column },
  });
  return (
    <div
      ref={setNodeRef}
      aria-label={t('grid.columnAria', { n: column + 1 })}
      data-testid={`dashboard-column-${column}`}
      className={`flex min-h-32 flex-col gap-4 rounded-(--radius-card) p-1 ${
        isOver
          ? 'bg-(--el-tint-lavender) outline-2 -outline-offset-2 outline-dashed outline-(--el-accent)'
          : ''
      }`}
    >
      {children}
      <div className="rounded-(--radius-control) border border-dashed border-(--el-border-strong) px-3 py-3 text-center text-xs text-(--el-text-faint)">
        {t('grid.dropHere')}
      </div>
    </div>
  );
}

function SortableWidget({
  widget,
  onConfigure,
  onRemove,
}: {
  widget: DashboardWidgetDto;
  onConfigure: (w: DashboardWidgetDto) => void;
  onRemove: (w: DashboardWidgetDto) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: widget.id,
    data: { type: 'widget', column: widget.column },
  });
  return (
    <WidgetCard
      widget={widget}
      mode="edit"
      isOwner
      setNodeRef={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      dragging={isDragging}
      dragHandleProps={{ ...attributes, ...listeners }}
      onConfigure={onConfigure}
      onRemove={onRemove}
    />
  );
}

function EmptyGrid({
  owner,
  editing,
  onAdd,
}: {
  owner: boolean;
  editing: boolean;
  onAdd: () => void;
}) {
  const t = useTranslations('dashboards');
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-(--radius-card) border border-dashed border-(--el-border) bg-(--el-surface-soft) px-6 py-14 text-center">
      <LayoutDashboard className="size-7 text-(--el-text-faint)" aria-hidden />
      <h3 className="font-serif text-base font-semibold text-(--el-text-strong)">
        {owner ? t('grid.emptyTitle') : t('grid.emptyViewerTitle')}
      </h3>
      <p className="max-w-[44ch] text-sm text-(--el-text-muted)">
        {owner ? t('grid.emptyBody') : t('grid.emptyViewerBody')}
      </p>
      {owner && editing ? (
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus className="size-4" />}
          onClick={onAdd}
          className="mt-1"
        >
          {t('grid.addWidget')}
        </Button>
      ) : null}
    </div>
  );
}

function LayoutPicker({
  layout,
  onChange,
}: {
  layout: DashboardLayout;
  onChange: (l: DashboardLayout) => void;
}) {
  const t = useTranslations('dashboards');
  const labels: Record<DashboardLayout, string> = {
    one: t('grid.layoutOne'),
    two: t('grid.layoutTwo'),
    three: t('grid.layoutThree'),
  };
  return (
    <div className="inline-flex items-center gap-0.5 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) p-0.5">
      {LAYOUTS.map((l) => {
        const n = columnCount(l);
        const selected = l === layout;
        return (
          <button
            key={l}
            type="button"
            aria-label={labels[l]}
            aria-pressed={selected}
            data-testid={`layout-${l}`}
            onClick={() => onChange(l)}
            className={`inline-flex h-7 items-center gap-0.5 rounded-(--radius-control) px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
              selected ? 'bg-(--el-accent)' : 'hover:bg-(--el-muted)'
            }`}
          >
            {Array.from({ length: n }).map((_, i) => (
              <span
                key={i}
                className={`block h-3.5 w-1 rounded-[1px] ${
                  selected ? 'bg-(--el-accent-text)' : 'bg-(--el-text-faint)'
                }`}
              />
            ))}
          </button>
        );
      })}
    </div>
  );
}

function AccessPill({ access }: { access: DashboardAccess }) {
  const t = useTranslations('dashboards');
  return access === 'workspace' ? (
    <Pill status="in-progress">
      <Users className="size-3" aria-hidden />
      {t('accessWorkspace')}
    </Pill>
  ) : (
    <Pill tone="neutral">
      <Lock className="size-3" aria-hidden />
      {t('accessPrivate')}
    </Pill>
  );
}

function DashboardOptionsMenu({
  onRename,
  onAccess,
  onDelete,
}: {
  onRename: () => void;
  onAccess: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('dashboards');
  return (
    <Popover>
      <Popover.Trigger
        aria-label={t('optionsAria')}
        className="inline-flex size-8 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <Ellipsis className="size-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={184} align="end" className="p-1">
        <MenuRow onClick={onRename} icon={<Pencil className="size-4" aria-hidden />}>
          {t('rename')}
        </MenuRow>
        <MenuRow onClick={onAccess} icon={<Users className="size-4" aria-hidden />}>
          {t('changeAccess')}
        </MenuRow>
        <MenuRow onClick={onDelete} danger icon={<Trash2 className="size-4" aria-hidden />}>
          {t('delete')}
        </MenuRow>
      </Popover.Content>
    </Popover>
  );
}

function DashboardSwitcher({
  current,
  dashboards,
}: {
  current: string;
  dashboards: DashboardSummaryDto[];
}) {
  const t = useTranslations('dashboards');
  return (
    <Popover>
      <Popover.Trigger
        aria-label={t('grid.switchAria')}
        className="inline-flex size-7 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <ChevronsUpDown className="size-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={260} align="start" className="p-1">
        <div className="flex flex-col gap-0.5" role="menu">
          {dashboards.map((d) => (
            <Link
              key={d.id}
              href={`/dashboard/${d.id}`}
              role="menuitem"
              className={`flex items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none ${
                d.id === current ? 'text-(--el-text) font-semibold' : 'text-(--el-text-secondary)'
              }`}
            >
              <LayoutDashboard className="size-4 shrink-0 text-(--el-text-muted)" aria-hidden />
              <span className="flex-1 truncate">{d.name}</span>
              {d.id === current ? (
                <Check className="size-4 text-(--el-accent)" aria-hidden />
              ) : null}
            </Link>
          ))}
        </div>
      </Popover.Content>
    </Popover>
  );
}

function MenuRow({
  onClick,
  icon,
  danger = false,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none ${
        danger ? 'text-(--el-text) hover:text-(--el-danger)' : 'text-(--el-text)'
      }`}
    >
      <span className="shrink-0 text-(--el-text-muted)">{icon}</span>
      {children}
    </button>
  );
}

// ── Dashboard-level modals ────────────────────────────────────────────────────

function RemoveWidgetModal({
  widget,
  onCancel,
  onConfirm,
}: {
  widget: DashboardWidgetDto;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('dashboards');
  const tc = useTranslations('common');
  const title = deriveTitleSafe(widget, t);
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()} size="sm" title={t('widget.remove')}>
      <p className="text-sm leading-relaxed text-(--el-text-secondary)">{t('deleteModal.body')}</p>
      <p className="mt-1 text-sm font-semibold text-(--el-text)">{title}</p>
      <Modal.Footer>
        <Button variant="ghost" onClick={onCancel}>
          {tc('cancel')}
        </Button>
        <Button
          variant="danger"
          leftIcon={<Trash2 className="size-4" />}
          onClick={onConfirm}
          data-testid="dashboard-widget-remove-confirm"
        >
          {t('widget.remove')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function RenameModal({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const t = useTranslations('dashboards');
  const tc = useTranslations('common');
  const [value, setValue] = useState(initial);
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()} size="sm" title={t('renameModal.title')}>
      <Input
        label={t('renameModal.label')}
        value={value}
        autoFocus
        maxLength={100}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSave(value);
          }
        }}
        data-testid="dashboard-rename-input"
      />
      <Modal.Footer>
        <Button variant="ghost" onClick={onCancel}>
          {tc('cancel')}
        </Button>
        <Button variant="primary" onClick={() => onSave(value)} disabled={!value.trim()}>
          {t('renameModal.submit')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function AccessModal({
  initial,
  onCancel,
  onSave,
}: {
  initial: DashboardAccess;
  onCancel: () => void;
  onSave: (a: DashboardAccess) => void;
}) {
  const t = useTranslations('dashboards');
  const tc = useTranslations('common');
  const [value, setValue] = useState<DashboardAccess>(initial);
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()} size="sm" title={t('accessModal.title')}>
      <AccessCards value={value} onChange={setValue} />
      <Modal.Footer>
        <Button variant="ghost" onClick={onCancel}>
          {tc('cancel')}
        </Button>
        <Button variant="primary" onClick={() => onSave(value)}>
          {t('accessModal.submit')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function DeleteModal({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('dashboards');
  const tc = useTranslations('common');
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()} size="sm">
      <h2 className="flex items-center gap-2.5 font-serif text-lg font-semibold text-(--el-text-strong)">
        <Trash2 className="size-5 shrink-0 text-(--el-danger)" aria-hidden />
        {t('deleteModal.title', { name })}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)">
        {t('deleteModal.body')}
      </p>
      <Modal.Footer>
        <Button variant="ghost" onClick={onCancel}>
          {tc('cancel')}
        </Button>
        <Button
          variant="danger"
          leftIcon={<Trash2 className="size-4" />}
          onClick={onConfirm}
          data-testid="dashboard-delete-confirm"
        >
          {t('deleteModal.confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

// ── Pure helpers shared with the card ──

function draftFromWidget(widget: DashboardWidgetDto): WidgetDraft {
  const base = emptyDraft();
  const source =
    widget.source.kind === 'saved_filter'
      ? {
          kind: 'saved_filter' as const,
          savedFilterId: widget.source.savedFilterId,
          projectId: null,
        }
      : widget.source.kind === 'project'
        ? { kind: 'project' as const, savedFilterId: null, projectId: widget.source.projectId }
        : base.source;
  const cfg = widget.config as unknown as Record<string, unknown>;
  return {
    ...base,
    source,
    pageSize: typeof cfg.pageSize === 'number' ? cfg.pageSize : base.pageSize,
    statisticType: typeof cfg.statisticType === 'string' ? cfg.statisticType : null,
    period: (cfg.period as WidgetDraft['period']) ?? base.period,
    daysBack: typeof cfg.daysBack === 'number' ? cfg.daysBack : base.daysBack,
    cumulative: typeof cfg.cumulative === 'boolean' ? cfg.cumulative : base.cumulative,
  };
}

function deriveTitleSafe(
  widget: DashboardWidgetDto,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (widget.type === 'distribution') {
    const stat = (widget.config as { statisticType?: string }).statisticType ?? '';
    return t('widgetTitle.distribution', { statistic: stat });
  }
  return t(`widgetTitle.${widget.type}`);
}
