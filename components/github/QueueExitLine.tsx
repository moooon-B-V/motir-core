'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CircleMinus, CircleX, ExternalLink } from 'lucide-react';
import { QUEUE_EXIT_REASONS } from '@/lib/mergeQueue/queueExit';
import type { PullRequestQueueExitDTO } from '@/lib/dto/approvalGate';

// ONE MERGE-QUEUE EXIT, IN WORDS (Story MOTIR-5461 · MOTIR-5635;
// `design/github/design-notes.md` § 22, `approve-and-merge--ejected.mock.html` E1–E7).
//
// The reason is the host's raw string, WORDED here from the one reason table the
// ejection arm classifies with (`QUEUE_EXIT_REASONS`). ⚠️ THE RAW STRING NEVER REACHES
// THE DOM: a reason nobody has mapped yet reads *GitHub did not say why*, the same
// neutral answer the arm gives it. The failing check is a link to its own page when
// the exit knows it (MOTIR-5633); when it does not — a conflict, a neutral removal, a
// check nobody could tie back — the reason stands alone and nothing is invented (E6).

type KnownReason = keyof typeof QUEUE_EXIT_REASONS;
/** The reasons a removal can be WORDED with — the table's non-landed rows. A landed
 *  removal writes no exit, so it is never drawn. */
type WordedReason = Exclude<KnownReason, 'MERGE' | 'ALREADY_MERGED'>;
const WORDED: ReadonlySet<string> = new Set<WordedReason>([
  'CI_FAILURE',
  'CI_TIMEOUT',
  'MERGE_CONFLICT',
  'INVALID_MERGE_COMMIT',
  'GIT_TREE_INVALID',
  'BRANCH_PROTECTIONS',
  'MANUAL',
  'QUEUE_CLEARED',
  'ROLL_BACK',
]);

export function reasonKey(rawReason: string): WordedReason | 'unknown' {
  return WORDED.has(rawReason) ? (rawReason as WordedReason) : 'unknown';
}

export function QueueExitLine({
  name,
  exit,
  sub,
}: {
  /** The pull request as its row names it — `owner/name · #n`. */
  name: string;
  exit: PullRequestQueueExitDTO;
  /** The follow-on sentence, under the check line. */
  sub?: ReactNode;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval.exit');
  const bold = (chunks: ReactNode) => (
    <b className="font-semibold whitespace-nowrap text-(--el-text)">{chunks}</b>
  );
  const failure = exit.disposition === 'failure';
  const reason = t(`reason.${reasonKey(exit.rawReason)}`);
  const Glyph = failure ? CircleX : CircleMinus;
  return (
    <span className="flex w-full min-w-0 basis-full flex-col gap-1" data-queue-exit>
      <span className="flex items-start gap-2 leading-snug">
        <Glyph
          className={`mt-0.5 h-3.5 w-3.5 flex-none ${
            failure ? 'text-(--el-danger-on-surface)' : 'text-(--el-icon-muted)'
          }`}
          aria-hidden
        />
        <span>{t.rich(failure ? 'left' : 'removed', { pr: name, reason, b: bold })}</span>
      </span>
      {exit.failingCheckName && exit.failingCheckUrl ? (
        <span className="ml-5.5 text-(--el-text-secondary)">
          {t.rich('failingCheck', {
            check: exit.failingCheckName,
            link: (chunks) => (
              <a
                href={exit.failingCheckUrl!}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('openCheck', { check: exit.failingCheckName! })}
                className="inline-flex items-center gap-1 text-(--el-link) underline underline-offset-2 hover:text-(--el-link-pressed)"
              >
                {chunks}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ),
          })}
        </span>
      ) : null}
      {sub ? <span className="ml-5.5 text-(--el-text-secondary)">{sub}</span> : null}
    </span>
  );
}
