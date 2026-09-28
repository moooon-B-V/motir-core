'use client';

import { useCallback, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CircleX, Copy, Undo2 } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';

// THE FIX LINE — line 2 of a To fix row (Story MOTIR-6588 · MOTIR-6605), built to
// `design/workbench/design-notes.md` § 30, Panel 2 (and Panel 3 for a HELD row).
//
// LEFT, WHY: one glyph and one sentence, read from `fixReason` + `fixDetail`. RIGHT,
// WHAT REPAIRS IT: the command chip and an always-visible copy button.
//
// ⚠️ THE COMMAND COMES FROM `fixDetail.repair`, NEVER FROM THE REASON. A reviewer's
// Request changes on the approve-to-merge gate is `run`, and a story's acceptance video
// sent back with Re-run is stored as the SAME reason and is `fix` — because `motir fix`
// claims it. Deriving the verb from the reason would print the wrong command on exactly
// that row.
//
// ⚠️ THE REASON LINE IS NOT THE CI BADGE. The badge on line 1 is a glyph about the
// checks; this is a sentence about why the card is stuck. A conflicted, queue-failed
// or sent-back card usually has green checks and no badge — which is why this line
// never rests on colour: every reason is words.

/** The repair command a row offers — the only place the verb is decided. */
export function fixCommandOf(detail: FixDetailDto, key: string): string {
  return `motir ${detail.repair} ${key}`;
}

type Translate = ReturnType<typeof useTranslations<'workbench'>>;

const mono = (chunks: ReactNode) => (
  <b className="font-mono font-semibold whitespace-nowrap">{chunks}</b>
);
const plainBold = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;

/** The queue reasons § 30 humanises; any other falls to the bare sentence. */
const HUMANISED_QUEUE_REASONS = new Set([
  'CI_FAILURE',
  'CI_TIMEOUT',
  'MERGE_CONFLICT',
  'INVALID_MERGE_COMMIT',
]);

/**
 * The sentence for each reason — a TOTAL map over `WorkItemFixReasonDto` with no
 * default branch, so a fifth reason (the dead-run story adds one) is a type error
 * here until somebody draws it.
 */
const REASON_SENTENCE: Readonly<
  Record<WorkItemFixReasonDto, (t: Translate, d: FixDetailDto) => ReactNode>
> = {
  // `check` → the humanised `queueReason` → the bare sentence (§ 30's fallback order).
  queue_failed: (t, d) => {
    if (d.check) return t.rich('toFix.reason.queueFailed', { detail: d.check, d: mono });
    if (d.queueReason && HUMANISED_QUEUE_REASONS.has(d.queueReason)) {
      return t.rich('toFix.reason.queueFailed', {
        detail: t(`toFix.queueReason.${d.queueReason}` as 'toFix.queueReason.CI_FAILURE'),
        d: plainBold,
      });
    }
    return t('toFix.reason.queueFailedBare');
  },
  conflicted: (t, d) =>
    d.base
      ? t.rich('toFix.reason.conflicted', { base: d.base, d: mono })
      : t('toFix.reason.conflictedNoBase'),
  ci_failed: (t, d) =>
    d.check
      ? t.rich('toFix.reason.ciFailed', { check: d.check, d: mono })
      : t('toFix.reason.ciFailedBare'),
  changes_requested: (t, d) => {
    if (!d.reviewerName) return t('toFix.reason.changesRequestedAnon');
    return d.notePreview
      ? t.rich('toFix.reason.changesRequested', {
          name: d.reviewerName,
          note: d.notePreview,
          b: plainBold,
        })
      : t.rich('toFix.reason.changesRequestedNoNote', { name: d.reviewerName, b: plainBold });
  },
};

/** The glyph each reason wears — `RepairFixPart`'s pairing: a failure is `CircleX` in
 *  danger-on-surface, a refusal is `Undo2`, muted, because a refusal is not a failure. */
function ReasonGlyph({ reason }: { reason: WorkItemFixReasonDto }) {
  return reason === 'changes_requested' ? (
    <Undo2 className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
  ) : (
    <CircleX className="h-3.5 w-3.5 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
  );
}

/** The copy button — `ReadyList`'s icon-button, ALWAYS visible here (§ 30: the command
 *  is the answer the row exists to give, and a touch screen cannot hover). Raised above
 *  the row's stretched link, so pressing it copies and does not open the card. */
function CopyFixCommand({ command, itemKey }: { command: string; itemKey: string }) {
  const t = useTranslations('workbench');
  const { toast } = useToast();
  const copy = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      await navigator.clipboard.writeText(command);
      toast({
        variant: 'success',
        title: t('toFix.toast.title'),
        description: t('toFix.toast.body', { command }),
      });
    },
    [command, t, toast],
  );
  return (
    <Tooltip
      content={t.rich('toFix.copyTooltip', {
        command,
        cmd: (chunks) => <code className="font-mono">{chunks}</code>,
      })}
    >
      <button
        type="button"
        onClick={copy}
        aria-label={t('toFix.copyAria', { key: itemKey })}
        data-testid={`workbench-fix-copy-${itemKey}`}
        className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-secondary) transition-colors hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <Copy className="h-4 w-4" aria-hidden />
      </button>
    </Tooltip>
  );
}

export function WorkbenchFixLine({
  itemKey,
  reason,
  detail,
  held,
}: {
  itemKey: string;
  reason: WorkItemFixReasonDto;
  detail: FixDetailDto;
  /** The card left the To fix set while the reader looked (§ 30 Panel 3). */
  held: boolean;
}) {
  const t = useTranslations('workbench');
  const command = fixCommandOf(detail, itemKey);
  return (
    <div
      data-testid={`workbench-fix-${itemKey}`}
      data-fix-reason={reason}
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-6 text-xs"
    >
      <p
        className={cn(
          'flex min-w-0 items-center gap-1.5',
          held ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
        )}
      >
        {/* A held row drops its glyph (§ 30 Panel 3): it is a receipt, not a failure. */}
        {held ? null : <ReasonGlyph reason={reason} />}
        <span className="min-w-0 truncate">{REASON_SENTENCE[reason](t, detail)}</span>
        {/* The affected clause — only for a card delivering more than one pull request. */}
        {detail.total > 1 ? (
          <span className="shrink-0 text-(--el-text-secondary)">
            {' · '}
            {t('toFix.affected', { affected: detail.affected, total: detail.total })}
          </span>
        ) : null}
      </p>
      {held ? (
        /* HELD (§ 26 as widened by § 30): the command is replaced by the colourless
           chip. *Cleared*, not *Repaired* — the nudge says the card LEFT the set, not
           why, and an archive clears it too. The row still opens. */
        <Pill tone="neutral">{t('live.cleared')}</Pill>
      ) : (
        <span className="relative z-10 flex shrink-0 items-center gap-1">
          <code className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-(--el-code-text)">
            {command}
          </code>
          <CopyFixCommand command={command} itemKey={itemKey} />
        </span>
      )}
    </div>
  );
}
