'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ApprovalGateDecisionSourceDTO } from '@/lib/dto/approvalGate';
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

/** What the refusal sends back — the one thing its consequence lines differ by. */
export type RefusalSubject = 'version' | 'commits' | 'decision';

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
) => GateVerb {
  const t = useTranslations('approvalGate.reason');
  const tGate = useTranslations('approvalGate');
  return (subject, identifier, extra = {}) => {
    const consequences =
      subject === 'version'
        ? [t('consequence.versionBack'), t('consequence.stays', { key: identifier })]
        : subject === 'commits'
          ? [t('consequence.commitsBack'), t('consequence.mergeNothing')]
          : [t('consequence.decisionBack'), t('consequence.docStays')];
    return {
      decision: 'request_changes',
      label: tGate('verb.requestChanges'),
      variant: 'secondary',
      confirms: true,
      note: { label: t('label'), helper: t('helper'), required: t('required') },
      confirm: { title: t('title'), consequences, proceedLabel: t('proceed') },
      ...extra,
    };
  };
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
}: {
  reason: string | null;
  version: string | null;
}) {
  const t = useTranslations('approvalGate.reason.row');
  const trimmed = reason?.trim() ?? '';
  const first = trimmed.split('\n')[0] ?? '';
  const title = [version ? t('on', { version: version.slice(0, 8) }) : null, trimmed || null]
    .filter(Boolean)
    .join(' — ');
  return (
    <span
      className="truncate text-xs text-(--el-text-secondary)"
      title={title || undefined}
      data-testid="refusal-reason-cell"
    >
      {first ? `“${first}”` : t('noneOnGithub')}
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
