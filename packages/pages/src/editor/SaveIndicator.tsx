import { useId } from 'react';
import { Check, CloudOff, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { SaveStatus } from './autosave';
import type { PageEditorMessages } from './messages';

// The save indicator (Story MOTIR-5752 · MOTIR-7275), drawn by
// `design/pages/page.mock.html` state 8 and specified in
// `design/pages/design-notes.md` § _State 8 — the save indicator_: a chip at the
// trailing end of the sticky toolbar, a polite live region, one rendering per
// `SaveStatus`. Only `offline` carries a fill, because only it asks something of
// the writer (keep the tab open), and it says so in its tooltip.

interface Rendering {
  icon: LucideIcon;
  label: (m: PageEditorMessages['status']) => string;
  className: string;
}

const RENDERINGS: Record<SaveStatus, Rendering> = {
  saved: {
    icon: Check,
    label: (m) => m.saved,
    className: 'text-(--el-text-secondary)',
  },
  saving: {
    icon: LoaderCircle,
    label: (m) => m.saving,
    className: 'text-(--el-text-secondary)',
  },
  offline: {
    icon: CloudOff,
    label: (m) => m.offline,
    className: 'bg-(--el-warning-surface) text-(--el-warning-text)',
  },
  too_large: {
    icon: TriangleAlert,
    label: (m) => m.tooLarge,
    className: 'font-medium text-(--el-danger-on-surface)',
  },
};

export interface SaveIndicatorProps {
  status: SaveStatus;
  messages: PageEditorMessages['status'];
}

export function SaveIndicator({ status, messages }: SaveIndicatorProps) {
  const detailId = useId();
  const { icon: Icon, label, className } = RENDERINGS[status];
  const detail = status === 'offline' ? messages.offlineDetail : undefined;
  return (
    <>
      <span
        role="status"
        aria-live="polite"
        data-status={status}
        title={detail}
        aria-describedby={detail ? detailId : undefined}
        className={`ml-auto inline-flex items-center gap-1.5 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[12.5px] whitespace-nowrap ${className}`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label(messages)}
      </span>
      {/* The tooltip's text as the chip's description — outside the live
          region, so a status change announces the label alone. */}
      {detail ? (
        <span id={detailId} hidden>
          {detail}
        </span>
      ) : null}
    </>
  );
}
