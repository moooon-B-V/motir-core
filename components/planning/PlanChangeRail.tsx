'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { AiPaywall } from '@/components/ai/AiPaywall';
import { PlanChangeComposer } from '@/components/planning/PlanChangeComposer';
import { PlanningTargetKeyChip } from '@/components/planning/PlanningTargetChip';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';
import type { PlanningLaunch, PlanningMode } from '@/lib/planning/launcher';
import type { PlanningTarget } from '@/lib/planning/planningTargets';

// The planning workspace's CHAT RAIL on an established project (Subtask
// MOTIR-1730; design `plan-change-conversation.mock.html` panels 3 + 6). Changing
// a plan is a CONVERSATION: each turn appends to the persisted, project-scoped
// thread (MOTIR-1728), submitting sends the ACCUMULATED intent, the run narrates
// itself into a polite live region, and the run's PROPOSALS are reviewed ON THE
// CANVAS — not in a corner dock. (What feeds that review is the run's Plan, read
// back through the plans API — MOTIR-1746; the rail's shape is unchanged.)
//
// It COMPOSES the shipped rail language from `DiscoveryChatRail` (the
// `--el-success` status dot + mono header, the avatar/bubble pair, the drafting
// spinner row, the composer) plus the shipped `AiPaywall` for the metered
// refusal. It is a SECOND consumer of that language, not a second chat widget:
// the onboarding rail drives the conductor loop and this one drives the plan-edit
// job, so the two share vocabulary, not state.
//
// Purely presentational + local draft state: every action is forwarded to the
// host, which owns `usePlanChangeConversation` (so the CANVAS can render the same
// proposal the rail is talking about).

const MODE_LABEL_KEY: Record<PlanningMode, string> = {
  project: 'mode.project',
  generation: 'mode.generation',
  replan: 'mode.replan',
  contextual: 'mode.contextual',
  roadmap: 'mode.roadmap',
};

const MODE_LEAD_KEY: Record<PlanningMode, string> = {
  project: 'lead.project',
  generation: 'lead.generation',
  replan: 'lead.replan',
  contextual: 'lead.contextual',
  roadmap: 'lead.roadmap',
};

/** The originating DETAIL wins over the mode's generic line when one was carried
 *  (a work item, a repo) — both resolve to the `contextual` mode. */
function leadKey(launch: PlanningLaunch): string {
  if (launch.itemKey) return 'lead.contextualItem';
  if (launch.repoKey) return 'lead.conventionRefine';
  return MODE_LEAD_KEY[launch.mode];
}

/** The three outcome-phrased starter chips (design panel 6, "empty"). They are
 *  hints that PREFILL the composer, not a mode menu — the user still edits and
 *  sends, so nothing is submitted behind their back. */
const STARTERS = ['addWork', 'resequence', 'drop'] as const;

export interface PlanChangeRailProps {
  launch: PlanningLaunch;
  projectName: string;
  state: PlanChangeConversationState;
  /** The indexed proposal — the rail MIRRORS the canvas bar's counts. */
  index: PlanChangeDiffIndex;
  /** The turn's TARGET SET (MOTIR-1491). Owned by the host, because the canvas
   *  highlights the same set the composer collects. */
  targets: readonly PlanningTarget[];
  onAddTarget: (target: PlanningTarget) => void;
  onRemoveTarget: (identifier: string) => void;
  onSend: (text: string) => void;
  onRetry: () => void;
  onApprove: () => void;
  onDiscard: () => void;
}

export function PlanChangeRail({
  launch,
  projectName,
  state,
  index,
  targets,
  onAddTarget,
  onRemoveTarget,
  onSend,
  onRetry,
  onApprove,
  onDiscard,
}: PlanChangeRailProps) {
  const t = useTranslations('planningWorkspace');
  const tc = useTranslations('planningWorkspace.conversation');
  const [draft, setDraft] = useState('');

  const busy = state.phase === 'streaming' || state.phase === 'deciding';
  const userTurns = (state.session?.turns ?? []).filter((turn) => turn.role === 'user');
  const showStarters = userTurns.length === 0 && !busy && state.phase !== 'loading';
  // An ITEM re-plan opens by ASKING (MOTIR-910 / design panels 2 + 4 + 5): the
  // composer is pre-focused and prompts for what's wrong, and what the user types
  // is the FIRST CHAT TURN — the reason itself, which MOTIR-908 classifies. There
  // is no pre-workspace form and no separate reason field. Plan mode has no such
  // prompt (the item's own description is the scope), and neither does a
  // PROJECT-level re-plan, whose opener + starter chips already frame the ask
  // (MOTIR-1730's shipped copy, deliberately untouched). Once the conversation
  // has started the composer returns to its ordinary placeholder.
  const askingForReason =
    launch.mode === 'replan' && launch.itemKey !== null && userTurns.length === 0;
  // The re-plan ASK wins over every other placeholder: it is a one-time prompt
  // for the reason, and it stops the moment the conversation starts. Only then
  // does the targeted variant apply (MOTIR-1491).
  const composerPlaceholder = askingForReason
    ? tc('composerPlaceholderReplan')
    : targets.length > 0
      ? tc('composerPlaceholderTargets')
      : tc('composerPlaceholder');

  // What the THREAD is anchored at, per the server (`PlanChangeSessionDto`) —
  // not the local tray. A sent turn is scoped by the session it landed in, so
  // the chips on the turn come from the record, not from what is picked now.
  const turnTargetKeys = state.session?.targetKeys ?? [];

  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l border-(--el-border) bg-(--el-surface)"
      aria-label={t('railLabel')}
    >
      <div className="flex items-center gap-2 border-b border-(--el-border-soft) px-4 py-3">
        <span className="size-2 rounded-full bg-(--el-success)" aria-hidden="true" />
        <span className="font-mono text-xs font-semibold tracking-wide text-(--el-text-secondary) uppercase">
          {t('railLabel')}
        </span>
        <Pill tone="neutral" className="ml-auto" data-testid="planning-mode-chip">
          {t(MODE_LABEL_KEY[launch.mode])}
        </Pill>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" role="log">
        {/* The opener — the canvas already shows the plan, so "empty" is never a
            blank screen; only the conversation is empty (design panel 6). */}
        <Bubble role="assistant">
          <span>
            {t(leadKey(launch), {
              project: projectName,
              item: launch.itemKey ?? '',
              repo: launch.repoKey ?? '',
            })}
          </span>{' '}
          <span>{tc('opener')}</span>
        </Bubble>

        {/* The starter hints sit WITH the opener (design panel 6's `emptyhint`),
            not docked above the composer — they are a continuation of the
            opening line, and they PREFILL the composer rather than sending. */}
        {showStarters ? (
          <div className="flex flex-wrap gap-1.5 pl-9">
            {STARTERS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setDraft(tc(`starters.${key}`))}
                className="inline-flex items-center gap-1 rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-xs font-medium text-(--el-text-secondary) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <Sparkles className="size-3" aria-hidden="true" />
                {tc(`starters.${key}`)}
              </button>
            ))}
          </div>
        ) : null}

        {(state.session?.turns ?? []).map((turn) => (
          <Turn key={turn.id} turn={turn} userTurns={userTurns} targetKeys={turnTargetKeys} />
        ))}

        {/* The proposal, said in words — the rail mirrors the canvas bar's counts
            so the numbers are readable without hunting the board. */}
        {state.review && !index.isEmpty ? (
          <>
            <Bubble role="assistant">
              {tc('summary', {
                added: index.counts.added,
                changed: index.counts.changed,
                removed: index.counts.removed,
              })}
            </Bubble>
            <Bubble role="assistant">{tc('lockedNote')}</Bubble>
            <div
              data-testid="plan-change-review"
              className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-accent) px-3 py-2"
            >
              <span className="text-xs font-semibold text-(--el-text-strong)">
                {tc('nothingSavedYet')}
              </span>
              {/* The gate itself lives on the canvas bar; this MIRRORS it so the
                  decision is reachable from wherever the reader is looking. */}
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
                  {tc('discard')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Check className="size-4" aria-hidden="true" />}
                  onClick={onApprove}
                  disabled={busy}
                >
                  {tc('approve')}
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {/* After an approve the thread CONTINUES — a plan change is rarely one
            change (design panel 6, "after approve"). */}
        {state.approved && !state.review ? (
          <Bubble role="assistant">
            {tc('approved', {
              created: state.approved.created.length,
              updated: state.approved.updated.length,
              removed: state.approved.removed.length,
            })}
          </Bubble>
        ) : null}

        {/* The RUN, narrated: the shipped drafting row + a polite live region fed
            by the job's real progress frames. */}
        <div aria-live="polite" data-testid="plan-change-progress">
          {state.progress ? (
            <div className="flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-2 text-sm text-(--el-text-muted)">
              <Spinner size="sm" aria-hidden="true" />
              {tc(`progress.${state.progress.kind}`, {
                count: state.progress.kind === 'proposed' ? state.progress.count : 0,
              })}
            </div>
          ) : null}
        </div>

        {state.errorCode ? (
          <div className="flex flex-col items-start gap-2">
            <p
              role="alert"
              className="rounded-(--radius-card) bg-(--el-tint-rose) px-3 py-2 text-sm text-(--el-text-strong)"
            >
              {tc(errorKey(state.errorCode))}
            </p>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw className="size-4" aria-hidden="true" />}
              onClick={onRetry}
              disabled={busy || userTurns.length === 0}
            >
              {tc('retry')}
            </Button>
          </div>
        ) : null}

        {/* Out of credits is NOT an error: nothing failed, the capability is
            cloud-gated. The shipped paywall carries the owner/member face. */}
        {state.outOfCredits ? <AiPaywall triggeredOutOfCredits /> : null}
      </div>

      {/* The composer carries the `@` TARGET picker + the tray (MOTIR-1491) — the
          message field and the target set are one control, because the targets
          scope the turn the field sends. */}
      <PlanChangeComposer
        draft={draft}
        onDraftChange={setDraft}
        targets={targets}
        onAddTarget={onAddTarget}
        onRemoveTarget={onRemoveTarget}
        onSubmit={onSend}
        placeholder={composerPlaceholder}
        autoFocus={askingForReason}
        disabled={busy || state.phase === 'loading'}
      />
    </aside>
  );
}

/** `FAILED` / `EMPTY` / `immutable` / `SESSION_UNAVAILABLE` / any typed code →
 *  the copy that explains it. Anything unrecognized falls back to the generic,
 *  recoverable failure line — never a raw code on screen. */
function errorKey(code: string): string {
  switch (code) {
    case 'EMPTY':
      return 'error.empty';
    case 'immutable':
      return 'error.immutable';
    // Someone (or another tab) already approved or declined this plan — there is
    // nothing left to confirm, and nothing was written twice.
    case 'decided':
      return 'error.decided';
    case 'discard':
      return 'error.discard';
    case 'SESSION_UNAVAILABLE':
      return 'error.session';
    default:
      return 'error.body';
  }
}

/** One persisted turn. A `user` turn is a bubble numbered in the thread (the
 *  second and later ones are REFINEMENTS, which is the whole point); a `system`
 *  turn is the submission MARKER — its body is the accumulated intent that went
 *  out, which is provenance, not conversation, so it renders as a quiet divider. */
function Turn({
  turn,
  userTurns,
  targetKeys,
}: {
  turn: PlanChangeTurnDto;
  userTurns: PlanChangeTurnDto[];
  /** The thread's anchor set — rendered on a user turn so the reader SEES what
   *  the planner was pointed at (design panel 3). Empty on the project thread. */
  targetKeys: readonly string[];
}) {
  const tc = useTranslations('planningWorkspace.conversation');
  const tt = useTranslations('planningWorkspace.targets');

  if (turn.role === 'system') {
    return (
      <p className="text-center text-xs text-(--el-text-faint)" data-testid="plan-change-marker">
        {tc('submitted')}
      </p>
    );
  }

  const n = userTurns.findIndex((u) => u.id === turn.id) + 1;
  return (
    <Bubble role="user" label={n > 1 ? tc('turnRefine', { n }) : tc('turn', { n })}>
      {targetKeys.length > 0 ? (
        <span className="mb-1 flex flex-wrap items-center gap-1">
          <span className="text-[10px] font-semibold tracking-wide uppercase opacity-80">
            {tt('turnLabel', { count: targetKeys.length })}
          </span>
          {targetKeys.map((key) => (
            <PlanningTargetKeyChip key={key} identifier={key} tone="on-accent" />
          ))}
        </span>
      ) : null}
      {turn.body}
    </Bubble>
  );
}

function Bubble({
  role,
  label,
  children,
}: {
  role: 'user' | 'assistant';
  label?: string;
  children: React.ReactNode;
}) {
  const isUser = role === 'user';
  return (
    <div className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <span
        aria-hidden="true"
        className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          isUser
            ? 'bg-(--el-muted) text-(--el-text-secondary)'
            : 'bg-(--el-accent) text-(--el-accent-text)'
        }`}
      >
        {isUser ? '·' : 'M'}
      </span>
      <div
        className={
          isUser
            ? 'rounded-(--radius-card) bg-(--el-chat-bubble-user) px-3 py-2 text-sm text-(--el-accent-text)'
            : 'rounded-(--radius-card) bg-(--el-chat-bubble-ai) px-3 py-2 text-sm text-(--el-text)'
        }
      >
        {label ? (
          <span className="mb-0.5 block font-mono text-[10px] tracking-wide uppercase opacity-80">
            {label}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}
