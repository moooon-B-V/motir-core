'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, ChevronDown, Key, Server, Terminal, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type {
  WorkItemDto,
  WorkItemImplementationSourceDto,
  WorkItemPlanningSourceDto,
} from '@/lib/dto/workItems';
import { FieldCard } from './FieldCard';

// Work-item PROVENANCE on the detail rail (Story MOTIR-1685 · MOTIR-1693), per
// design/work-items/provenance.mock.html. Two read-only triples — Planning
// (source · harness · model) and Implementation (source · harness · model) —
// each "—" when null (the common case: no execution yet, or a pre-feature item).
//
// COLLAPSED BY DEFAULT, at the BOTTOM of the rail (ADR Decision 7): provenance is
// secondary metadata, so it renders as a single closed "Provenance" disclosure
// (the shipped "Show all custom fields" toggle grammar in CustomFieldsSection.tsx
// — a full-width button + a ChevronDown that rotates 180° on open) the user
// EXPANDS to reveal the two triple FieldCards. Read-only: provenance is set by the
// create seams + the session tools, never edited by hand (no chevron on the inner
// cards). Native shows only "Native · Motir" — the read DTO already strips the
// native model (recorded server-side for analysis, never exposed).

// The source chip's tint class — the hue lives in the tint BACKGROUND with
// --el-text-strong text (colour rule / finding #35). `neutral` marks the HUMAN
// "manual" source, a neutral --el-surface chip (a human is not a model). Static
// arbitrary-value classes so each routes through the --el-* swap layer.
type SourceMeta = { icon: LucideIcon; labelKey: string; tintClass: string; neutral?: boolean };

const NEUTRAL_CHIP =
  'border border-(--el-border-soft) bg-(--el-surface) text-(--el-text-secondary)';

const PLANNING_SOURCE_META: Record<WorkItemPlanningSourceDto, SourceMeta> = {
  native: { icon: Bot, labelKey: 'provenanceSourceNative', tintClass: 'bg-(--el-tint-lavender)' },
  mcp: { icon: Terminal, labelKey: 'provenanceSourceMcp', tintClass: 'bg-(--el-tint-sky)' },
  manual: {
    icon: User,
    labelKey: 'provenanceSourceManual',
    tintClass: NEUTRAL_CHIP,
    neutral: true,
  },
};

const IMPLEMENTATION_SOURCE_META: Record<WorkItemImplementationSourceDto, SourceMeta> = {
  hosted: { icon: Server, labelKey: 'provenanceSourceHosted', tintClass: 'bg-(--el-tint-peach)' },
  byok: { icon: Key, labelKey: 'provenanceSourceByok', tintClass: 'bg-(--el-tint-mint)' },
  manual: {
    icon: User,
    labelKey: 'provenanceSourceManual',
    tintClass: NEUTRAL_CHIP,
    neutral: true,
  },
};

/** The tinted source chip — hue in the tint BACKGROUND with --el-text-strong text;
 *  the neutral "manual" chip already carries its own text colour in NEUTRAL_CHIP. */
function SourceChip({
  icon: Icon,
  label,
  tintClass,
  neutral,
}: {
  icon: LucideIcon;
  label: string;
  tintClass: string;
  neutral?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 self-start rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold',
        neutral ? tintClass : cn(tintClass, 'text-(--el-text-strong)'),
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}

/** One provenance triple (Planning or Implementation) as a read-only FieldCard.
 *  Renders "—" when there is no source (the unknown state). The model line is
 *  omitted when absent — so a native item (model stripped by the DTO) shows only
 *  the chip + harness. */
function TripleCard({
  label,
  source,
  harness,
  model,
}: {
  label: string;
  source: { icon: LucideIcon; label: string; tintClass: string; neutral?: boolean } | null;
  harness: string | null;
  model: string | null;
}) {
  return (
    <FieldCard label={label} editable={false}>
      {source ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <SourceChip
            icon={source.icon}
            label={source.label}
            tintClass={source.tintClass}
            neutral={source.neutral}
          />
          {harness || model ? (
            <div className="flex min-w-0 flex-col">
              {harness ? (
                <span className="truncate text-sm text-(--el-text)">{harness}</span>
              ) : null}
              {model ? (
                <span className="truncate font-mono text-xs text-(--el-text-muted)">{model}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <span className="text-(--el-text-muted)">—</span>
      )}
    </FieldCard>
  );
}

export function ProvenanceSection({ item }: { item: WorkItemDto }) {
  const t = useTranslations('issueViews');
  const [open, setOpen] = useState(false);

  const planningSourceMeta = item.planningSource ? PLANNING_SOURCE_META[item.planningSource] : null;
  const implementationSourceMeta = item.implementationSource
    ? IMPLEMENTATION_SOURCE_META[item.implementationSource]
    : null;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left font-sans text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
        {t('provenance')}
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-3">
          <TripleCard
            label={t('provenancePlanning')}
            source={
              planningSourceMeta
                ? {
                    icon: planningSourceMeta.icon,
                    label: t(planningSourceMeta.labelKey),
                    tintClass: planningSourceMeta.tintClass,
                    neutral: planningSourceMeta.neutral,
                  }
                : null
            }
            harness={item.planningHarness}
            model={item.planningModel}
          />
          <TripleCard
            label={t('provenanceImplementation')}
            source={
              implementationSourceMeta
                ? {
                    icon: implementationSourceMeta.icon,
                    label: t(implementationSourceMeta.labelKey),
                    tintClass: implementationSourceMeta.tintClass,
                    neutral: implementationSourceMeta.neutral,
                  }
                : null
            }
            harness={item.implementationHarness}
            model={item.implementationModel}
          />
        </div>
      ) : null}
    </div>
  );
}
