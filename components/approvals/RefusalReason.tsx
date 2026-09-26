'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  ApprovalGateDecisionSourceDTO,
  ApprovalGateRefusalVerdictDTO,
} from '@/lib/dto/approvalGate';
import type { GateVerb } from './ApprovalGateControl';

// A REFUSAL SAYS WHY (Story MOTIR-6067 · Subtask MOTIR-6075; ADR `approval-gates.md`
// §10a–§10b; design `approval-control--refusal-reason.mock.html`).
//
// Two halves, one file, so every frame asks the same way and every record reads back
// the same way:
//   · `useRefusalVerb` — *Request changes* as a CONFIRMING `note` verb: the SHIPPED
//     Overturn band (MOTIR-5960), given the refusal's own words. The frame refuses an
//     empty press in place; the door refuses it again (`request_changes_needs_a_note`).
//   · `RefusalReasonQuote` — the reason on a decided `changes_requested` record, quoted
//     exactly as the overturned record quotes its note (Panel 4).
//
// A DESIGN SENT BACK IS A VERDICT (Story MOTIR-6070 · Subtask MOTIR-6427;
// `docs/decisions/design-refusal-verdict.md`; design
// `approval-control--design-verdict.mock.html`). The `design` subject is the `version`
// band plus a REQUIRED second input — Revise or Re-plan — in the slot MOTIR-6073 reserved
// under the reason. It is its OWN subject because `version` is shared with
// `acceptance_result`, which keeps the shipped *Leave {key} where it is* line: on a design
// that line is false (either verdict sends the card back to To do), so it is dropped and
// each tile's consequence line says where the card goes instead.

/** What the refusal sends back — the one thing its consequence lines differ by. */
export type RefusalSubject = 'version' | 'commits' | 'decision' | 'design';

/**
 * What the `design` subject's band needs beyond the card's key (MOTIR-6427).
 *
 *  - `replanKey` — where a Re-plan opens the planner: the design card's PARENT (§10h's
 *    anchor, `refusalSeedAnchorsOnParent`), or the card itself when it has none.
 *  - `returnStatusLabel` — the label of the project's initial To-do status, the status
 *    either verdict writes. Null when the project has none: nothing moves then, so the
 *    band keeps the shipped *Leave {key} where it is* line and the tiles name no status.
 */
export interface DesignRefusalFacts {
  replanKey: string;
  returnStatusLabel: string | null;
}

/** The verdict a design refusal requires, as the frame draws it (MOTIR-6427). */
export interface RefusalVerdictField {
  legend: string;
  required: string;
  options: {
    value: ApprovalGateRefusalVerdictDTO;
    label: string;
    hint: string;
    /** Where the card goes — null when the project has no To-do status to name. */
    consequence: string | null;
  }[];
}

/** Past this, the quote clamps to three lines and offers *Show all* (Panel 4b). */
export const REASON_CLAMP_CHARS = 280;

/**
 * A BUILDER for *Request changes* as a confirming `note` verb. The hook is called at the
 * top of a component; the builder it returns may be called anywhere, including inside
 * the branch that knows which subject is being refused.
 */
export function useRefusalVerb(): (
  subject: RefusalSubject,
  identifier: string,
  extra?: Partial<GateVerb>,
  /** The `design` subject's facts — ignored by every other subject. */
  design?: DesignRefusalFacts,
) => GateVerb {
  const t = useTranslations('approvalGate.reason');
  const tGate = useTranslations('approvalGate');
  return (subject, identifier, extra = {}, design) => {
    const status = subject === 'design' ? (design?.returnStatusLabel ?? null) : null;
    const consequences =
      subject === 'version'
        ? [t('consequence.versionBack'), t('consequence.stays', { key: identifier })]
        : subject === 'commits'
          ? [t('consequence.commitsBack'), t('consequence.mergeNothing')]
          : subject === 'decision'
            ? [t('consequence.decisionBack'), t('consequence.docStays')]
            : // A DESIGN: the tiles say where the card goes, so the band's list keeps only
              // the record line — unless the project has no To-do status, when nothing
              // moves and the shipped *stays* line is true again (design § *The status*).
              status === null
              ? [t('consequence.versionBack'), t('consequence.stays', { key: identifier })]
              : [t('consequence.versionBack')];
    const verdict: RefusalVerdictField | undefined =
      subject === 'design'
        ? {
            legend: t('verdict.legend'),
            required: t('verdict.required'),
            options: [
              {
                value: 'revise',
                label: t('verdict.revise.label'),
                hint: t('verdict.revise.hint'),
                consequence:
                  status === null
                    ? null
                    : t('verdict.revise.consequence', { key: identifier, status }),
              },
              {
                value: 're_plan',
                label: t('verdict.replan.label'),
                hint: t('verdict.replan.hint'),
                consequence:
                  status === null
                    ? null
                    : t('verdict.replan.consequence', {
                        key: identifier,
                        status,
                        parent: design?.replanKey ?? identifier,
                      }),
              },
            ],
          }
        : undefined;
    return {
      decision: 'request_changes',
      label: tGate('verb.requestChanges'),
      variant: 'secondary',
      confirms: true,
      note: { label: t('label'), helper: t('helper'), required: t('required') },
      ...(verdict ? { verdict } : {}),
      confirm: { title: t('title'), consequences, proceedLabel: t('proceed') },
      ...extra,
    };
  };
}

/**
 * THE VERDICT GROUP (design panels 1–2) — two tiles, NOTHING pre-selected, side by side
 * from `sm` and stacked below it. Each tile is `ChoiceGate`'s `OptionRow` in `pick` mode,
 * class for class: the whole tile is the hit target, the radio face is drawn, the input is
 * `sr-only`. A press with no verdict is refused IN PLACE exactly as the reason is: the group
 * goes `aria-invalid`, each tile's border `--el-danger`, and `FormField`'s box error sits
 * under the group. Picking a tile clears it.
 */
export function RefusalVerdictGroup({
  field,
  groupId,
  value,
  refused,
  onChange,
}: {
  field: RefusalVerdictField;
  groupId: string;
  value: ApprovalGateRefusalVerdictDTO | null;
  refused: boolean;
  onChange: (value: ApprovalGateRefusalVerdictDTO) => void;
}) {
  const legendId = `${groupId}-legend`;
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <p id={legendId} className="font-sans text-sm font-medium text-(--el-text)">
        {field.legend}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={legendId}
        aria-required="true"
        aria-invalid={refused || undefined}
        className="grid gap-2 sm:grid-cols-2"
        data-testid="refusal-verdict-group"
      >
        {field.options.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={`flex cursor-pointer gap-3 rounded-(--radius-card) border px-3 py-2.5 hover:bg-(--el-surface) ${
                selected
                  ? 'border-(--el-accent) bg-(--el-surface-soft)'
                  : refused
                    ? 'border-(--el-danger) bg-(--el-page-bg)'
                    : 'border-(--el-border) bg-(--el-page-bg)'
              }`}
              data-verdict={option.value}
            >
              <input
                type="radio"
                name={groupId}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border bg-(--el-page-bg) ${
                  selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
                }`}
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-(--el-accent)" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-(--el-text)">{option.label}</span>
                </span>
                <span className="mt-0.5 block text-[13px] leading-snug text-(--el-text-secondary)">
                  {option.hint}
                </span>
                {option.consequence ? (
                  <span className="mt-1 block text-xs leading-snug text-(--el-text-secondary)">
                    {option.consequence}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {refused ? (
        // `FormField`'s `errorVariant="box"` alert, byte for byte (design panel 2).
        <p
          role="alert"
          className="rounded-(--radius-control) bg-(--el-danger-surface) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs text-(--el-danger-surface-text)"
        >
          {field.required}
        </p>
      ) : null}
    </div>
  );
}

/**
 * THE VERDICT ON THE RECORD (design panel 4) — *Sent back to revise* / *Sent back to
 * re-plan*, in the record strip's *Files kept* chip shape with the NEUTRAL `--el-muted`
 * fill: a verdict is a fact, not a warning. Nothing for a refusal with no verdict — a
 * GitHub-synced one, or one recorded before the verdict existed (panel 4d).
 */
export function RefusalVerdictChip({ verdict }: { verdict: ApprovalGateRefusalVerdictDTO | null }) {
  const t = useTranslations('approvalGate.reason.record.verdict');
  if (!verdict) return null;
  return (
    <span
      className="inline-flex items-center rounded-(--radius-badge) bg-(--el-muted) px-2 py-0.5 font-semibold text-(--el-text-strong)"
      data-testid="refusal-verdict"
    >
      {t(verdict === 'revise' ? 'revise' : 'replan')}
    </span>
  );
}

/** *None of these* on a choice — the same band, the choice's words (Panel 3). */
export function useNoneOfTheseVerb(): (identifier: string) => GateVerb {
  const t = useTranslations('approvalGate.reason.choice');
  const tChoice = useTranslations('approvalGate.choice');
  return (identifier) => ({
    decision: 'request_changes',
    label: tChoice('verb.noneOfThese'),
    variant: 'secondary',
    confirms: true,
    note: { label: t('label'), helper: t('helper'), required: t('required') },
    confirm: {
      title: t('title'),
      consequences: [t('record'), t('waits', { key: identifier })],
      proceedLabel: t('proceed'),
    },
  });
}

/**
 * The reason on a DECIDED `changes_requested` record. Renders nothing for a refusal
 * pressed before the reason was required (a legacy row with no note): there is no
 * absence to report, only a record that predates the question.
 */
export function RefusalReasonQuote({
  noteMd,
  decisionSource,
}: {
  noteMd: string | null;
  decisionSource: ApprovalGateDecisionSourceDTO | null;
}) {
  const t = useTranslations('approvalGate.reason.record');
  const [open, setOpen] = useState(false);
  const reason = noteMd?.trim() ?? '';

  if (!reason) {
    // ⚠️ SAID IN WORDS, secondary ink — never a blank and never faint (Panel 4d): a GitHub
    // reviewer who wrote nothing is information, and it sits on a surface.
    return decisionSource === 'github' ? (
      <span className="basis-full text-(--el-text-secondary)">{t('noneOnGithub')}</span>
    ) : null;
  }

  const long = reason.length > REASON_CLAMP_CHARS || reason.split('\n').length > 3;
  if (!long) {
    return <span className="basis-full text-(--el-text)">&ldquo;{reason}&rdquo;</span>;
  }
  return (
    <span className="flex basis-full flex-col items-start gap-1">
      <span className={`whitespace-pre-line text-(--el-text) ${open ? '' : 'line-clamp-3'}`}>
        &ldquo;{reason}&rdquo;
      </span>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-xs font-medium text-(--el-link) underline hover:text-(--el-link-pressed)"
      >
        {open ? t('showLess') : t('showAll')}
      </button>
    </span>
  );
}

/** The decided ROW's details cell: the reason's FIRST line (Panel 1 of the row delta). */
export function RefusalReasonCell({
  reason,
  version,
  verdict = null,
}: {
  reason: string | null;
  version: string | null;
  /** A design sent back leads its cell with the verdict (MOTIR-6427; design panel 4e/4f). */
  verdict?: ApprovalGateRefusalVerdictDTO | null;
}) {
  const t = useTranslations('approvalGate.reason.row');
  const tVerdict = useTranslations('approvalGate.reason.verdict');
  const trimmed = reason?.trim() ?? '';
  const first = trimmed.split('\n')[0] ?? '';
  const verdictLabel = verdict
    ? tVerdict(verdict === 'revise' ? 'revise.label' : 'replan.label')
    : null;
  const title = [
    verdictLabel,
    version ? t('on', { version: version.slice(0, 8) }) : null,
    trimmed || null,
  ]
    .filter(Boolean)
    .join(' — ');
  const quote = first ? `“${first}”` : t('noneOnGithub');
  return (
    <span
      className="truncate text-xs text-(--el-text-secondary)"
      title={title || undefined}
      data-testid="refusal-reason-cell"
    >
      {verdictLabel ? (
        <>
          <span className="font-medium text-(--el-text)">{verdictLabel}</span> · {quote}
        </>
      ) : (
        quote
      )}
    </span>
  );
}

/**
 * Whether a decided row shows the reason cell at all: a `changes_requested` row with a
 * reason, or a GitHub one without. A refusal recorded before the reason was required keeps
 * the row's shipped details — there is nothing to quote and no absence to report.
 */
export function showsRefusalReason(
  state: string,
  reason: string | null,
  decisionSource: ApprovalGateDecisionSourceDTO | null,
): boolean {
  // A DECLINED plan (MOTIR-6037) quotes its reason when one was given — it is optional
  // there (ADR §11.4), and its absence has its own line on the plan row.
  if (state === 'declined') return Boolean(reason?.trim());
  return state === 'changes_requested' && (Boolean(reason?.trim()) || decisionSource === 'github');
}
