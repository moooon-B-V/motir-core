'use client';

import { useTranslations } from 'next-intl';
import type { DashboardWidgetType } from '@prisma/client';
import { Modal } from '@/components/ui/Modal';
import { WIDGET_REGISTRY, WIDGET_TYPES } from '@/lib/dashboards/widgetRegistry';

// The add-widget picker (6.3.5, design panel 3) — rendered FROM the 6.3.1
// widget-type registry (`WIDGET_TYPES`), never a hard-coded list, so a registry
// addition appears here with zero UI change (asserted in the tests with a
// test-only registry entry). Picking a type opens its config panel (the grid
// mounts WidgetConfigModal in create mode for the chosen type's editor kind).

function Thumbnail({ rendererKind }: { rendererKind: string }) {
  if (rendererKind === 'donut') {
    return (
      <svg width="58" height="58" viewBox="0 0 220 220" aria-hidden>
        <path
          d="M110,18 A92 92 0 0 1 175.05,175.05 L148.18,148.18 A54 54 0 0 0 110,56 Z"
          fill="var(--el-chart-cat-1)"
        />
        <path
          d="M175.05,175.05 A92 92 0 0 1 28.03,151.77 L61.89,134.52 A54 54 0 0 0 148.18,148.18 Z"
          fill="var(--el-chart-cat-2)"
        />
        <path
          d="M28.03,151.77 A92 92 0 0 1 110,18 L110,56 A54 54 0 0 0 61.89,134.52 Z"
          fill="var(--el-chart-cat-3)"
        />
      </svg>
    );
  }
  if (rendererKind === 'difference_area') {
    return (
      <svg width="118" height="58" viewBox="0 0 118 58" aria-hidden>
        <polyline
          points="6,44 28,26 50,34 72,14 94,30 112,20"
          fill="none"
          stroke="var(--el-chart-created)"
          strokeWidth="2.5"
        />
        <polyline
          points="6,50 28,42 50,36 72,40 94,28 112,32"
          fill="none"
          stroke="var(--el-chart-resolved)"
          strokeWidth="2.5"
        />
      </svg>
    );
  }
  // issue_table
  return (
    <svg width="118" height="58" viewBox="0 0 118 58" aria-hidden>
      <rect x="6" y="8" width="106" height="9" rx="2" fill="var(--el-border)" />
      <rect
        x="6"
        y="24"
        width="106"
        height="7"
        rx="2"
        fill="var(--el-border-strong)"
        opacity="0.5"
      />
      <rect
        x="6"
        y="36"
        width="106"
        height="7"
        rx="2"
        fill="var(--el-border-strong)"
        opacity="0.5"
      />
      <rect
        x="6"
        y="48"
        width="74"
        height="7"
        rx="2"
        fill="var(--el-border-strong)"
        opacity="0.5"
      />
    </svg>
  );
}

export function AddWidgetModal({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (type: DashboardWidgetType, editorKind: string) => void;
}) {
  const t = useTranslations('dashboards');

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('add.title')} size="md">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {WIDGET_TYPES.map((type) => {
          const def = WIDGET_REGISTRY[type];
          return (
            <button
              key={type}
              type="button"
              data-testid={`add-widget-${type}`}
              onClick={() => onPick(type, def.editorKind)}
              className="flex flex-col items-start gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding) text-left hover:border-(--el-accent) hover:shadow-(--shadow-card) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <span className="flex h-[58px] w-full items-center justify-center rounded-(--radius-control) bg-(--el-surface-soft)">
                <Thumbnail rendererKind={def.rendererKind} />
              </span>
              <span className="font-serif text-sm font-semibold text-(--el-text-strong)">
                {t(`add.${type}_name`)}
              </span>
              <span className="text-xs leading-relaxed text-(--el-text-muted)">
                {t(`add.${type}_desc`)}
              </span>
            </button>
          );
        })}
      </div>
      <Modal.Footer>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="inline-flex h-(--height-btn-md) items-center rounded-(--radius-btn) px-(--spacing-btn-x) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          {t('grid.cancel')}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
