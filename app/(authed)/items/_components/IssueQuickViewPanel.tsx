'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  Calendar,
  ChevronRight,
  Clock,
  Component as ComponentIcon,
  Gauge,
  Goal,
  SearchX,
  User,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { DevelopmentSection } from '@/components/github/DevelopmentSection';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { WorkItemTitle } from '@/components/markdown/WorkItemTitle';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { ValueChip } from '@/components/ui/MultiSelectPicker';
import { Avatar, AssigneeValue, PriorityValue, StatusValue } from './issueCellPrimitives';
import { QuickViewCloseButton } from './QuickViewCloseButton';
import { WORK_ITEM_TYPE_META } from '@/lib/issues/workItemTypeMeta';
import { isTypeableKind } from '@/lib/issues/executorDefaults';
import { labelTint } from '@/lib/labels/labelTint';
import { formatDate } from '@/lib/utils/datetime';
import type { ExecutorDto } from '@/lib/dto/workItems';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { Locale } from '@/lib/i18n/locales';
import type { QuickViewData } from '@/lib/dto/quickView';

// The bot/person glyph for the Executor rail row (mirrors the detail rail's
// ExecutorIndicator, condensed) — a faint value glyph, not a coloured chip.
const EXECUTOR_GLYPH: Record<ExecutorDto, typeof Bot> = { coding_agent: Bot, human: User };

// The presentational quick-view PANEL (Subtask 2.5.19) — the modal body the
// IssueQuickView frame wraps, per design/work-items/quick-view.mock.html. Pure
// view: it takes already-shaped, serializable data (the QuickViewData the
// /api/work-items/peek route returns and IssueQuickViewController fetches) and
// renders one of three states — `loading` (the skeleton shown while the item
// fetches, panel 3), `notfound` (a stale / cross-workspace / deleted key, panel
// 4), or `ready` (the populated peek, panel 2). A large two-column body:
// scrollable main (title + FULL description) + a condensed core-fields rail.
// Read-only — editing lives on the full page.
//
// Composes ONLY shipped primitives — Modal (the frame), IssueTypeIcon (type
// hue), Pill via StatusValue / PriorityValue, the row Avatar, MarkdownView — so
// no new visual primitive is invented (AC). Colour via --el-* only; shape via
// the element-semantic tokens.

// Re-exported for existing consumers (the component test) that import the peek
// payload type from the panel; the canonical definition lives in the DTO.
export type { QuickViewData };

// `onClose` (MOTIR-1352) is the OPTIONAL non-URL close — supplied by the
// roadmap-canvas quick-view, which drives the peek from local state. Omitted on
// /items · /ready · /boards, where the close clears `?peek` via the shipped
// URL-driven default (see QuickViewCloseButton).
type IssueQuickViewPanelProps = { onClose?: () => void } & (
  | { state: 'loading'; peekKey: string }
  | { state: 'notfound'; peekKey: string }
  | { state: 'ready'; data: QuickViewData }
);

/** "Open full page →" — a Next Link styled as the primary Button (size sm). */
function OpenFullPageLink({ identifier }: { identifier: string }) {
  const t = useTranslations('issueViews');
  return (
    <Link
      href={`/items/${identifier}`}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="quick-view-open-full"
      className="inline-flex h-(--height-btn-sm) shrink-0 items-center justify-center gap-1.5 rounded-(--radius-btn) bg-(--el-accent) px-3 font-sans text-xs font-medium text-(--el-accent-text) transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {t('openFullPage')}
      <ArrowRight className="h-[15px] w-[15px]" aria-hidden />
    </Link>
  );
}

/** A rail field — uppercase caption over its value. */
function RailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
        {label}
      </dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 text-sm text-(--el-text-secondary)">
        {children}
      </dd>
    </div>
  );
}

/** A pulsing skeleton bar (the loading state's placeholders). */
function Sk({ className }: { className?: string }) {
  return (
    <span
      className={`block animate-pulse rounded-(--radius-control) bg-(--el-muted) ${className ?? ''}`}
    />
  );
}

export function IssueQuickViewPanel(props: IssueQuickViewPanelProps) {
  const t = useTranslations('issueViews');
  const tl = useTranslations('labels');
  const locale = useLocale() as Locale;
  // The expanded rail's empty custom fields hide behind a read-only "Show more
  // fields (N)" disclosure (8.8.8, mirroring the detail rail 5.3.7).
  const [showAllCustom, setShowAllCustom] = useState(false);
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }),
    [locale],
  );
  const mutedNone = <span className="text-(--el-text-muted)">{t('none')}</span>;

  // Read-only custom-field value (8.8.8) — the detail rail's per-type value
  // grammar (CustomFieldsSection.renderValue, 5.3.7), condensed and WITHOUT any
  // editor (the peek has one write path: Open full page). `user`/`option`/`date`
  // arrive resolved from the server, so this never re-derives a label from an id.
  const renderCustomValue = (field: CustomFieldWithValueDto): ReactNode => {
    const v = field.value;
    if (!v) return mutedNone;
    switch (field.fieldType) {
      case 'text':
        return (
          <span className="truncate" title={v.text ?? undefined}>
            {v.text}
          </span>
        );
      case 'number':
        return v.number != null ? numberFormat.format(v.number) : mutedNone;
      case 'date':
        return v.date ? (
          <>
            <Calendar className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
            <span className="truncate">{formatDate(v.date, locale)}</span>
          </>
        ) : (
          mutedNone
        );
      case 'select':
        return v.option ? (
          <span className="truncate">
            {v.option.label}
            {v.option.archived ? (
              <span className="text-(--el-text-secondary) italic">
                {' '}
                {t('customFields.archivedMark')}
              </span>
            ) : null}
          </span>
        ) : (
          mutedNone
        );
      case 'user':
        return v.user ? (
          <>
            <Avatar name={v.user.name} />
            <span className="truncate">{v.user.name}</span>
          </>
        ) : (
          mutedNone
        );
    }
  };

  // ── NOT FOUND / NO ACCESS (panel 4) ──────────────────────────────────────
  if (props.state === 'notfound') {
    return (
      <>
        <header className="flex flex-none items-center gap-2.5 border-b border-(--el-border) py-3.5 pr-4 pl-5">
          <span className="flex-1" />
          <QuickViewCloseButton variant="icon" onClose={props.onClose} />
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <span className="mb-1.5 inline-flex h-14 w-14 items-center justify-center rounded-full bg-(--el-muted) text-(--el-text-muted)">
            <SearchX className="h-7 w-7" aria-hidden />
          </span>
          <h2 className="font-serif text-lg font-semibold text-(--el-text)">
            {t('quickViewUnavailableTitle')}
          </h2>
          <p className="max-w-[24rem] text-sm leading-relaxed text-(--el-text-secondary)">
            {t('quickViewUnavailableDescription', { key: props.peekKey })}
          </p>
          <div className="mt-3">
            <QuickViewCloseButton variant="button" onClose={props.onClose} />
          </div>
        </div>
      </>
    );
  }

  // ── LOADING (panel 3) — fields fetch while the modal is already open ──────
  if (props.state === 'loading') {
    return (
      <>
        <header className="flex flex-none items-center gap-2.5 border-b border-(--el-border) py-3.5 pr-4 pl-5">
          <Sk className="h-[18px] w-[18px] rounded-(--radius-control)" />
          <Sk className="h-3.5 w-16" />
          <Sk className="h-5 w-20 rounded-(--radius-badge)" />
          <span className="flex-1" />
          <OpenFullPageLink identifier={props.peekKey} />
          <QuickViewCloseButton variant="icon" onClose={props.onClose} />
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 overflow-y-auto px-7 pt-6 pb-7" role="status" aria-live="polite">
            <span className="sr-only">{t('quickViewLoadingAria')}</span>
            <Sk className="mb-6 h-7 w-2/3" />
            <Sk className="mb-3 h-2.5 w-24" />
            <Sk className="mb-2.5 h-3.5 w-full" />
            <Sk className="mb-2.5 h-3.5 w-[97%]" />
            <Sk className="mb-2.5 h-3.5 w-[92%]" />
            <Sk className="mb-6 h-3.5 w-3/5" />
            <Sk className="mb-2.5 h-3.5 w-full" />
            <Sk className="h-3.5 w-4/5" />
          </div>
          {/* The skeleton holds the EXPANDED rail's height (8.8.8) so the modal
              doesn't resize when the full field set lands. */}
          <dl className="flex min-w-0 flex-col gap-5 overflow-y-auto border-l border-(--el-border) bg-(--el-surface-soft) px-5 py-6">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Sk className="h-2.5 w-14" />
                <Sk className="h-5 w-28 rounded-(--radius-badge)" />
              </div>
            ))}
          </dl>
        </div>
      </>
    );
  }

  // ── READY (panel 2) — the populated peek ──────────────────────────────────
  const { data } = props;
  // Custom fields split the detail-rail way (5.3.7): the VALUED ones render as
  // rows, the empty ones hide behind the read-only "Show more fields (N)".
  const valuedCustom = data.customFields.filter((f) => f.value !== null);
  const emptyCustom = data.customFields.filter((f) => f.value === null);
  // Type/Executor are leaf-only (epic/story have no work type — mirror the
  // detail rail). Sprint is omitted for epics (they span sprints, Jira-faithful);
  // its empty label is status-aware (a done/cancelled item is excluded from the
  // backlog → "None", otherwise "Backlog"), matching CoreFieldsPanel.
  const showWorkType = isTypeableKind(data.kind);
  const TypeGlyph = data.type ? WORK_ITEM_TYPE_META[data.type].icon : null;
  const ExecutorGlyph = data.executor ? EXECUTOR_GLYPH[data.executor] : null;
  const sprintEmptyLabel = data.statusCategory === 'done' ? t('none') : t('backlog');
  return (
    <>
      <header className="flex flex-none items-center gap-2.5 border-b border-(--el-border) py-3.5 pr-4 pl-5">
        <IssueTypeIcon type={data.kind} className="h-[18px] w-[18px] shrink-0" />
        <Link
          href={`/items/${data.identifier}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[13px] font-medium text-(--el-link) hover:underline focus-visible:rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {data.identifier}
        </Link>
        <StatusValue category={data.statusCategory} label={data.statusLabel} />
        <span className="flex-1" />
        <OpenFullPageLink identifier={data.identifier} />
        <QuickViewCloseButton variant="icon" onClose={props.onClose} />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px]">
        {/* Main — title + the FULL description (scrollable). */}
        <div className="min-w-0 overflow-y-auto px-7 pt-6 pb-7">
          <h2 className="font-serif text-[27px] leading-tight font-semibold text-(--el-text)">
            <WorkItemTitle
              title={data.title}
              projectIdentifier={data.projectIdentifier}
              workItemRefs={data.workItemRefs}
            />
          </h2>
          {/* Readiness banner (2.5.21) — the shipped ReadinessBadge, top of the
              main column under the title, per quick-view.mock.html (2.5.20). Shown
              only for a TODO-category item that has blockers: no banner without
              blockers, and none once the item is in-progress / done ("can I start
              this?" is moot past todo). Each named blocker opens its DETAIL page in
              a NEW TAB (8.8.32 — overrides the 2.5.20 peek-swap), matching the
              new-tab treatment the other quick-view detail links got in 8.8.31. */}
          {data.readiness && data.statusCategory === 'todo' ? (
            <ReadinessBadge
              ready={data.readiness.ready}
              blockers={data.readiness.blockers.map((identifier) => ({
                identifier,
                href: `/items/${identifier}`,
              }))}
              blockedByAncestor={
                data.readiness.blockedByAncestor
                  ? {
                      identifier: data.readiness.blockedByAncestor.identifier,
                      title: data.readiness.blockedByAncestor.title,
                      href: `/items/${data.readiness.blockedByAncestor.identifier}`,
                    }
                  : null
              }
              blockerLinksNewTab
              className="mt-4"
            />
          ) : null}
          <span className="mt-6 mb-2 block text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
            {t('description')}
          </span>
          {data.descriptionMd ? (
            <MarkdownView
              value={data.descriptionMd}
              aria-label={t('issueDescriptionAria')}
              workItemRefs={data.workItemRefs}
            />
          ) : (
            <p className="text-sm text-(--el-text-secondary) italic">{t('noDescription')}</p>
          )}
          {/* Development — linked PRs + PR/CI state (Story 7.10 · MOTIR-1579,
              design/github Panels 3 + 4a). Display-only here (the peek's one
              write path stays "Open full page"); the explicit-link affordance
              lives on the detail page (MOTIR-1596, design Panel 5). */}
          <DevelopmentSection
            className="mt-6"
            pullRequests={data.pullRequests}
            itemIdentifier={data.identifier}
          />
          <p className="mt-6 flex items-center gap-1.5 border-t border-(--el-border-soft) pt-4 text-[13px] text-(--el-text-muted)">
            {t.rich('quickViewMore', {
              link: (chunks) => (
                <Link
                  href={`/items/${data.identifier}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-(--el-link) hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </div>

        {/* Rail — the detail page's FULL core-field set (8.8.8), condensed and
            read-only, in detail.png order. The rail scrolls independently inside
            the fixed-height modal; built-in fields always render (muted "None"
            when empty), custom fields split valued / "Show more". */}
        <dl className="flex min-w-0 flex-col gap-4 overflow-y-auto border-l border-(--el-border) bg-(--el-surface-soft) px-5 py-6">
          <RailField label={t('status')}>
            <StatusValue category={data.statusCategory} label={data.statusLabel} />
          </RailField>

          {/* Work Type + Executor — leaf-only (Story 2.7). The faint value glyph
              follows the Estimate/Due grammar (NOT the coloured type chip — the
              dense rail stays quiet, per the 8.8.4 design). The kind is already
              in the header (IssueTypeIcon), so the rail adds only the work type. */}
          {showWorkType ? (
            <>
              <RailField label={t('type')}>
                {data.type && TypeGlyph ? (
                  <>
                    <TypeGlyph
                      className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)"
                      aria-hidden
                    />
                    <span className="truncate">{tl(`workItemType.${data.type}`)}</span>
                  </>
                ) : (
                  <span className="text-(--el-text-muted)">{t('none')}</span>
                )}
              </RailField>
              <RailField label={t('executor')}>
                {data.executor && ExecutorGlyph ? (
                  <>
                    <ExecutorGlyph
                      className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)"
                      aria-hidden
                    />
                    <span className="truncate">{tl(`executor.${data.executor}`)}</span>
                  </>
                ) : (
                  <span className="text-(--el-text-muted)">{t('none')}</span>
                )}
              </RailField>
            </>
          ) : null}

          <RailField label={t('priority')}>
            <PriorityValue priority={data.priority} />
          </RailField>
          <RailField label={t('assignee')}>
            <AssigneeValue name={data.assigneeName} />
          </RailField>
          <RailField label={t('reporter')}>
            <Avatar name={data.reporterName} />
            <span className="truncate">{data.reporterName}</span>
          </RailField>
          <RailField label={t('parent')}>
            {data.parent ? (
              <Link
                href={`/items/${data.parent.identifier}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 items-center gap-1.5 text-(--el-link) hover:underline"
              >
                <IssueTypeIcon type={data.parent.kind} className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0 font-mono text-xs">{data.parent.identifier}</span>
                <span className="truncate text-(--el-text-secondary)">{data.parent.title}</span>
              </Link>
            ) : (
              <span className="text-(--el-text-muted)">{t('none')}</span>
            )}
          </RailField>

          {/* Labels — coloured chips. Reuses the SHIPPED ValueChip + name-hash
              labelTint (5.4.8), NOT a fixed lavender: the labelTint decision
              (product owner, 2026-06-10) guarantees a label renders the SAME
              colour on every surface, so the peek and the detail rail match. */}
          <RailField label={t('labelsField')}>
            {data.labels.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {data.labels.map((l) => (
                  <ValueChip
                    key={l.id}
                    option={{ id: l.id, label: l.name, tint: labelTint(l.name) }}
                  />
                ))}
              </div>
            ) : (
              <span className="text-(--el-text-muted)">{t('noLabels')}</span>
            )}
          </RailField>

          {/* Components — neutral chips with the component glyph (5.4.8). */}
          <RailField label={t('componentsField')}>
            {data.components.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {data.components.map((c) => (
                  <ValueChip
                    key={c.id}
                    option={{ id: c.id, label: c.name, glyph: ComponentIcon }}
                  />
                ))}
              </div>
            ) : (
              <span className="text-(--el-text-muted)">{t('noComponents')}</span>
            )}
          </RailField>

          <RailField label={t('dueDate')}>
            {data.dueLabel ? (
              <span className="truncate">{data.dueLabel}</span>
            ) : (
              <span className="text-(--el-text-muted)">{t('noDueDate')}</span>
            )}
          </RailField>

          {/* Sprint — omitted for epics (they span sprints). Goal glyph + name,
              or the status-aware empty label (Backlog / None). */}
          {data.kind !== 'epic' ? (
            <RailField label={t('sprint')}>
              {data.sprintName ? (
                <>
                  <Goal className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
                  <span className="truncate">{data.sprintName}</span>
                </>
              ) : (
                <span className="text-(--el-text-muted)">{sprintEmptyLabel}</span>
              )}
            </RailField>
          ) : null}

          {/* Story points — the agile estimate, distinct from the TIME estimate. */}
          <RailField label={t('storyPoints')}>
            {data.storyPoints != null ? (
              <>
                <Gauge className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
                <span className="truncate">{numberFormat.format(data.storyPoints)}</span>
              </>
            ) : (
              <span className="text-(--el-text-muted)">{t('none')}</span>
            )}
          </RailField>

          <RailField label={t('estimate')}>
            {data.estimateLabel ? (
              <>
                <Clock className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
                <span className="truncate">{data.estimateLabel}</span>
              </>
            ) : (
              <span className="text-(--el-text-muted)">{t('noEstimate')}</span>
            )}
          </RailField>

          {/* Custom fields (5.3.7) — valued rows, then the empty ones behind a
              read-only "Show more fields (N)" disclosure. A faint divider sets
              the cluster off from the built-ins. */}
          {data.customFields.length > 0 ? (
            <>
              <div className="-mx-1 my-1 h-px bg-(--el-border-soft)" />
              {valuedCustom.map((f) => (
                <RailField key={f.id} label={f.label}>
                  {renderCustomValue(f)}
                </RailField>
              ))}
              {emptyCustom.length > 0 ? (
                <>
                  <button
                    type="button"
                    aria-expanded={showAllCustom}
                    onClick={() => setShowAllCustom((s) => !s)}
                    className="flex items-center gap-1.5 self-start rounded-(--radius-control) px-1 py-1 font-sans text-xs font-medium text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                  >
                    <ChevronRight
                      className={`h-3.5 w-3.5 shrink-0 text-(--el-text-faint) transition-transform ${showAllCustom ? 'rotate-90' : ''}`}
                      aria-hidden
                    />
                    {showAllCustom
                      ? t('customFields.showFewer')
                      : t('customFields.showMore', { count: emptyCustom.length })}
                  </button>
                  {showAllCustom
                    ? emptyCustom.map((f) => (
                        <RailField key={f.id} label={f.label}>
                          {renderCustomValue(f)}
                        </RailField>
                      ))
                    : null}
                </>
              ) : null}
            </>
          ) : null}

          {/* Created / Updated — the quiet audit line at the foot. */}
          <div className="-mx-1 my-1 h-px bg-(--el-border-soft)" />
          <div className="flex flex-col gap-1 font-sans text-xs text-(--el-text-muted)">
            <span>
              {t('created')} {formatDate(data.createdAt, locale)}
            </span>
            <span>
              {t('updated')} {formatDate(data.updatedAt, locale)}
            </span>
          </div>
        </dl>
      </div>
    </>
  );
}
