'use client';

import { type CSSProperties, type ReactNode } from 'react';
import { Ellipsis, GripVertical, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Popover } from '@/components/ui/Popover';
import type { DashboardWidgetDto } from '@/lib/dto/dashboards';
import { WidgetBody } from './WidgetBody';
import { SOURCE_GLYPH, WIDGET_TYPE_GLYPH, deriveWidgetTitle, sourceLine } from './widgetMeta';

// The widget card chrome (6.3.5, design panels 2/3/5): a Card with a header
// (type glyph · derived title · source line · the mode-appropriate actions)
// over the per-type body. VIEW mode gives the owner an overflow menu
// (Configure / Remove); EDIT mode swaps in the drag grip + inline configure +
// remove affordances. A viewer (non-owner) gets the read-only card. The card is
// a labelled region (`role="group"` + the title) so one failing widget stays an
// isolated, screen-reader-named cell.

export interface WidgetCardProps {
  widget: DashboardWidgetDto;
  mode: 'view' | 'edit';
  isOwner: boolean;
  customFieldNames?: Record<string, string>;
  onConfigure?: (widget: DashboardWidgetDto) => void;
  onRemove?: (widget: DashboardWidgetDto) => void;
  /** Drag-handle wiring from the sortable wrapper (edit mode only). */
  dragHandleProps?: Record<string, unknown>;
  /** Sortable transform/transition + ref, applied to the outer card. */
  style?: CSSProperties;
  setNodeRef?: (node: HTMLElement | null) => void;
  dragging?: boolean;
}

export function WidgetCard({
  widget,
  mode,
  isOwner,
  customFieldNames,
  onConfigure,
  onRemove,
  dragHandleProps,
  style,
  setNodeRef,
  dragging = false,
}: WidgetCardProps) {
  const t = useTranslations('dashboards');
  const title = deriveWidgetTitle(widget.type, widget.config, t, customFieldNames);
  const Glyph = WIDGET_TYPE_GLYPH[widget.type];
  const editing = mode === 'edit';

  const sourceText = sourceLine(widget.source, t);
  const SourceIcon = widget.source.kind === 'stale' ? null : SOURCE_GLYPH[widget.source.kind];

  return (
    <section
      ref={setNodeRef}
      style={style}
      role="group"
      aria-label={t('widget.regionAria', { title })}
      data-testid={`dashboard-widget-${widget.id}`}
      // `data-tilt` floats the dashboard widget under the 3D / Immersive style
      // (small widgets tilt toward the cursor; large ones just float). Inert
      // under every other style + reduced motion.
      data-tilt=""
      // `data-surface` opts the dashboard/report widget into the surface-MATERIAL
      // layer (glassmorphism frost, aurora glow), like the board card. Inert under
      // non-material styles. 7.3.38.
      data-surface="card"
      className={`flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) shadow-(--shadow-subtle) ${
        dragging ? 'opacity-60 shadow-(--shadow-elevated)' : ''
      }`}
    >
      <header className="flex items-center gap-2 border-b border-(--el-border) px-2.5 py-2">
        {editing ? (
          <button
            type="button"
            aria-label={t('grid.reorderAria', { title })}
            data-testid={`dashboard-widget-grip-${widget.id}`}
            className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center text-(--el-text-faint) hover:text-(--el-text-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            {...dragHandleProps}
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
        ) : null}
        <Glyph className="size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-semibold text-(--el-text-strong)">{title}</h4>
          {!editing ? (
            <p className="flex items-center gap-1 truncate text-[11.5px] text-(--el-text-muted)">
              {SourceIcon ? <SourceIcon className="size-3 shrink-0" aria-hidden /> : null}
              <span className="truncate">{sourceText}</span>
            </p>
          ) : null}
        </div>

        {editing && isOwner ? (
          <>
            <IconAction
              label={t('widget.configure')}
              testId={`dashboard-widget-configure-${widget.id}`}
              onClick={() => onConfigure?.(widget)}
            >
              <SlidersHorizontal className="size-[15px]" aria-hidden />
            </IconAction>
            <IconAction
              label={t('widget.remove')}
              testId={`dashboard-widget-remove-${widget.id}`}
              danger
              onClick={() => onRemove?.(widget)}
            >
              <Trash2 className="size-[15px]" aria-hidden />
            </IconAction>
          </>
        ) : !editing && isOwner ? (
          <WidgetOverflow
            onConfigure={() => onConfigure?.(widget)}
            onRemove={() => onRemove?.(widget)}
          />
        ) : null}
      </header>

      <div className="min-w-0 flex-1">
        <WidgetBody
          widget={widget}
          customFieldNames={customFieldNames}
          onReconfigure={isOwner ? () => onConfigure?.(widget) : undefined}
        />
      </div>
    </section>
  );
}

function IconAction({
  label,
  testId,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  testId?: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className={`inline-flex size-[26px] shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
        danger ? 'hover:text-(--el-danger)' : 'hover:text-(--el-text)'
      }`}
    >
      {children}
    </button>
  );
}

function WidgetOverflow({
  onConfigure,
  onRemove,
}: {
  onConfigure: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('dashboards');
  return (
    <Popover>
      <Popover.Trigger
        aria-label={t('widget.optionsAria')}
        className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <Ellipsis className="size-[15px]" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={180} align="end" className="p-1">
        <MenuItem onClick={onConfigure} icon={<SlidersHorizontal className="size-4" aria-hidden />}>
          {t('widget.configure')}
        </MenuItem>
        <MenuItem onClick={onRemove} danger icon={<Trash2 className="size-4" aria-hidden />}>
          {t('widget.remove')}
        </MenuItem>
      </Popover.Content>
    </Popover>
  );
}

function MenuItem({
  onClick,
  icon,
  danger = false,
  children,
}: {
  onClick: () => void;
  icon: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm focus-visible:bg-(--el-muted) focus-visible:outline-none ${
        danger
          ? 'text-(--el-text) hover:bg-(--el-muted) hover:text-(--el-danger)'
          : 'text-(--el-text) hover:bg-(--el-muted)'
      }`}
    >
      <span className="shrink-0 text-(--el-text-muted)">{icon}</span>
      {children}
    </button>
  );
}
