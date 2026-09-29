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

/**
 * THE HELD-FAILURE SENTENCE (§4 FIFTH AMENDMENT; MOTIR-6596, design § 31 panel 1): the
 * failed CHECK named in the sentence itself, per reason. `null` falls back to § 22's
 * `left` + reason — a check the queue attempt never recorded is not invented.
 */
function heldSentenceKey(
  exit: PullRequestQueueExitDTO,
): 'checks' | 'timedOut' | 'mergeCommit' | null {
  switch (exit.rawReason) {
    case 'CI_FAILURE':
      return exit.failingCheckName ? 'checks' : null;
    case 'CI_TIMEOUT':
      return exit.failingCheckName ? 'timedOut' : null;
    case 'INVALID_MERGE_COMMIT':
    case 'GIT_TREE_INVALID':
      return 'mergeCommit';
    default:
      return null;
  }
}

/**
 * A QUEUE EXIT WHOSE CHECK HUNG (§4 SIXTH AMENDMENT; MOTIR-6849, design § 32): a
 * `CI_FAILURE` / `CI_TIMEOUT` the server stored NEUTRAL because its check was cancelled
 * or timed out (or the queue timed out with no check named). Read from the stored
 * disposition, never re-derived from the reason, and worded without "failed".
 */
export function hungCheckSentenceKey(
  exit: Pick<PullRequestQueueExitDTO, 'rawReason' | 'disposition' | 'failingCheckName'> & {
    failingCheckConclusion?: string | null;
  },
): 'cancelled' | 'timedOut' | 'noCheck' | null {
  if (exit.disposition !== 'neutral') return null;
  if (exit.rawReason !== 'CI_FAILURE' && exit.rawReason !== 'CI_TIMEOUT') return null;
  if (!exit.failingCheckName) return 'noCheck';
  if (exit.failingCheckConclusion === 'cancelled') return 'cancelled';
  if (exit.failingCheckConclusion === 'timed_out') return 'timedOut';
  return 'noCheck';
}

export function QueueExitLine({
  name,
  exit,
  sub,
  held = false,
}: {
  /** The pull request as its row names it — `owner/name · #n`. */
  name: string;
  exit: PullRequestQueueExitDTO;
  /** The follow-on sentence, under the check line. */
  sub?: ReactNode;
  /** A queue FAILURE held at Implemented (§ 31): the sentence names the failed check. */
  held?: boolean;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval.exit');
  const bold = (chunks: ReactNode) => (
    <b className="font-semibold whitespace-nowrap text-(--el-text)">{chunks}</b>
  );
  const failure = exit.disposition === 'failure';
  const reason = t(`reason.${reasonKey(exit.rawReason)}`);
  const Glyph = failure ? CircleX : CircleMinus;
  const heldKey = held ? heldSentenceKey(exit) : null;
  const hungKey = hungCheckSentenceKey(exit);
  const checkLabel = hungKey ? 'stoppedCheck' : 'failingCheck';
  const openLabel = hungKey ? 'openStoppedCheck' : 'openCheck';
  return (
    <span className="flex w-full min-w-0 basis-full flex-col gap-1" data-queue-exit>
      <span className="flex items-start gap-2 leading-snug">
        <Glyph
          className={`mt-0.5 h-3.5 w-3.5 flex-none ${
            failure ? 'text-(--el-danger-on-surface)' : 'text-(--el-icon-muted)'
          }`}
          aria-hidden
        />
        <span>
          {hungKey
            ? t.rich(`hung.${hungKey}`, {
                pr: name,
                check: exit.failingCheckName ?? '',
                b: bold,
              })
            : heldKey
              ? t.rich(`failed.${heldKey}`, {
                  pr: name,
                  check: exit.failingCheckName ?? '',
                  b: bold,
                })
              : t.rich(failure ? 'left' : 'removed', { pr: name, reason, b: bold })}
        </span>
      </span>
      {exit.failingCheckName && exit.failingCheckUrl && hungKey !== 'noCheck' ? (
        <span className="ml-5.5 text-(--el-text-secondary)">
          {t.rich(checkLabel, {
            check: exit.failingCheckName,
            link: (chunks) => (
              <a
                href={exit.failingCheckUrl!}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t(openLabel, { check: exit.failingCheckName! })}
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
