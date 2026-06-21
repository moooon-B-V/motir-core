'use client';

import { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Card } from '@/components/ui/Card';

// The detail rail's field-card grammar (Story 2.4), extracted from
// CoreFieldsPanel so the custom-field cards (Subtask 5.3.7) compose the SAME
// chrome — uppercase label + corner chevron + value line — per
// design/work-items/custom-fields.mock.html ("FieldCard verbatim, no new card
// chrome").

export function Avatar({ name }: { name: string }) {
  return (
    <span
      className="bg-(--el-text) text-(--el-text-inverted) inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

// A field card: caption + value (display mode) with a corner chevron that
// toggles into the control (edit mode). The chevron is a real button with an
// accessible name; the caption is a plain <div> (the control carries its own
// accessible name). `editable={false}` drops the chevron (read-only fields).
export function FieldCard({
  label,
  editable = true,
  editing,
  onToggle,
  children,
}: {
  label: string;
  editable?: boolean;
  editing?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const t = useTranslations('issueViews');
  const tc = useTranslations('common');
  return (
    <Card className="px-3.5 py-2.5 shadow-(--shadow-card)">
      <div className="flex items-start justify-between gap-2">
        <div className="font-sans text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
          {label}
        </div>
        {editable ? (
          <button
            type="button"
            // Don't steal focus on click: otherwise clicking the chevron to
            // collapse a focused free-text field (due/estimate) blurs it first,
            // which closes edit mode, and the click then re-opens it — the field
            // never collapses. Keyboard users still reach it via Tab.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggle}
            aria-expanded={editing}
            aria-label={`${editing ? tc('close') : t('edit')} ${label}`}
            className="-mt-0.5 rounded p-0.5 text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <ChevronDown
              className={cn('h-4 w-4 transition-transform', editing && 'rotate-180')}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
      <div className="text-(--el-text) mt-1.5 font-sans text-sm">{children}</div>
    </Card>
  );
}
