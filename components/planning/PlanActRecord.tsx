'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Ban,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  CircleQuestionMark,
  CornerDownRight,
  FilePenLine,
  FileText,
  ListTree,
  MessageSquare,
  MessageSquareText,
  Minus,
  PenLine,
  Pencil,
  Plus,
  ScanEye,
  ScanSearch,
  Search,
  SearchCheck,
  Send,
  ShieldCheck,
  Sparkles,
  Waypoints,
  X,
} from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';
import type { ToolCallVerb } from '@/lib/planning/planChangeFrames';
import {
  OPEN_STEP_WINDOW,
  barTarget,
  callLineSpec,
  failedCount,
  fullValueKey,
  groupActs,
  isMonoObject,
  isStep,
  latestRowAnnouncement,
  nextAnnouncement,
  openSteps,
  shortenCallObject,
  type Announcement,
  type CallAct,
  type CallPlaceholder,
} from '@/components/planning/planCallLines';

type Tc = ReturnType<typeof useTranslations>;

/** One glyph per act kind — the second, non-textual skim cue (sheet 3).
 *  Keyed on the KIND so the map is exhaustive by type: a new `PlanChangeProgress`
 *  member without a glyph does not compile, which is the same discipline the
 *  frame dispositions use one layer down. A `call` act draws its glyph by VERB
 *  instead ({@link CALL_GLYPH}); its entry here is the unknown-verb glyph. */
const ACT_GLYPH: Record<PlanChangeProgress['kind'], typeof Send> = {
  submitted: Send,
  reading: ScanSearch,
  redirected: CornerDownRight,
  redirectedDebug: CornerDownRight,
  matching: SearchCheck,
  writing: FilePenLine,
  retrieval: BookOpenText,
  searching: Search,
  drilling: ListTree,
  laying: ListTree,
  authoring: PenLine,
  note: MessageSquareText,
  proposed: Sparkles,
  validating: ShieldCheck,
  call: BookOpenText,
  unknown: CircleQuestionMark,
};

/** A call's glyph by what it DOES (MOTIR-7975 § Primitives composed). */
const CALL_GLYPH: Record<ToolCallVerb, typeof Send> = {
  read: FileText,
  search: Search,
  explore: Waypoints,
  look_up: ScanEye,
  lay: ListTree,
  write: PenLine,
  add: Plus,
  update: Pencil,
  remove: Minus,
  validate: ShieldCheck,
  settle: MessageSquare,
};

function ActGlyph({ act }: { act: PlanChangeProgress }) {
  // The BLOCKED lookup is the one act whose glyph is decided by its payload, not
  // its kind: sheet 3 gives "out of lookups" the `ban` glyph so the moment the
  // run stopped being able to read is visible at a skim.
  const Icon = act.kind === 'retrieval' && act.blocked ? Ban : ACT_GLYPH[act.kind];
  return <Icon className="size-3.5" aria-hidden="true" />;
}

function CallGlyph({ act }: { act: CallAct }) {
  // The mark takes the glyph slot: `x` for a failure or a refusal, `ban` for a
  // lookup the budget skipped.
  const Icon =
    act.outcome === 'failed' || act.outcome === 'refused'
      ? X
      : act.outcome === 'skipped'
        ? Ban
        : act.verb !== null
          ? CALL_GLYPH[act.verb]
          : BookOpenText;
  return <Icon className="size-3.5" aria-hidden="true" />;
}

/** The five retrieval families the planner reads from (`motir-ai`
 *  `retrievalTools.ts`) plus `code_read`, each with a catalog label; anything
 *  else renders as the raw family name rather than as a hole. */
const RETRIEVAL_FAMILY_KEY: Record<string, string> = {
  plan_tree: 'act.family.planTree',
  code_graph: 'act.family.codeGraph',
  code_health: 'act.family.codeHealth',
  code_read: 'act.family.codeRead',
  web: 'act.family.web',
  lessons: 'act.family.lessons',
};

/** The mono LABEL column's catalog key. A call line has no label column (the
 *  column names steps), so a `call` act never reaches it. */
function actLabelKey(act: Exclude<PlanChangeProgress, CallAct>): string {
  return `act.${act.kind}`;
}

const MARK_KEY = {
  failed: 'act.call.mark.failed',
  refused: 'act.call.mark.refused',
  skipped: 'act.call.mark.skipped',
} as const;

/**
 * A call's line as plain text. `short` is what the running bar shows (the object
 * as the line draws it); `full` is what the announcer says.
 */
export function callLineText(act: CallAct, tc: Tc, form: 'short' | 'full'): string {
  const spec = callLineSpec(act);
  if (spec.placeholder === null || spec.value === null) return tc(spec.key);
  const value =
    form === 'short' ? shortenCallObject(spec.placeholder, spec.value).text : spec.value;
  return tc(spec.key, { [spec.placeholder]: value });
}

/** The line one act reads as. Every string is a catalog key; the only values
 *  interpolated are the frame's own data. */
export function actLine(act: PlanChangeProgress, tc: Tc): string {
  switch (act.kind) {
    case 'retrieval': {
      // The BLOCKED variant is a different sentence, not a suffix: the run has
      // stopped being able to look things up, which is worth saying plainly.
      if (act.blocked) return tc('act.retrievalBlockedLine');
      if (act.family === null) return tc('act.retrievalLineBare');
      const familyKey = RETRIEVAL_FAMILY_KEY[act.family];
      return tc('act.retrievalLine', { family: familyKey ? tc(familyKey) : act.family });
    }
    case 'laying':
      return tc('act.layingLine', { target: act.target ?? '' });
    case 'authoring':
      return tc('act.authoringLine', { title: act.title ?? '' });
    // ⚠️ THE PLANNER'S OWN WORDS, rendered verbatim rather than through a
    // catalog string — it is prose the model wrote about the act it just took,
    // and there is nothing to translate.
    case 'note':
      return act.text;
    case 'unknown':
      return tc('act.unknownLine', { frame: act.frame });
    case 'proposed':
      return tc('progress.proposed', { count: act.count });
    // The debug turn's two acts (MOTIR-7050; `debug-turn.mock.html` panel 1).
    case 'matching':
      return tc('act.matchingLine');
    case 'writing':
      return tc('act.writingLine', { key: act.key });
    // The per-call line (MOTIR-7979), drawn to MOTIR-7975's copy table.
    case 'call':
      return callLineText(act, tc, 'full');
    default:
      return tc(`progress.${act.kind}`, { count: 0 });
  }
}

/** The text the running bar repeats while a run streams (MOTIR-7975 § The pinned
 *  running bar), or null when there is no act to repeat. */
export function runningBarLine(
  acts: readonly PlanChangeProgress[],
  streaming: boolean,
  tc: Tc,
): string | null {
  const entries = groupActs(acts);
  const target = barTarget(acts, entries, openSteps(acts, entries, streaming));
  if (target === null) return null;
  const act = acts[target.index]!;
  if (target.type === 'act' || act.kind !== 'call') return actLine(act, tc);
  const line = callLineText(act, tc, 'short');
  const step = target.step === null ? null : acts[target.step]!;
  return step?.kind === 'authoring' && step.title !== null
    ? tc('act.call.barParallel', { line, title: step.title })
    : line;
}

function announcementText(
  acts: readonly PlanChangeProgress[],
  announcement: Announcement | null,
  tc: Tc,
): string {
  if (announcement === null) return '';
  const act = acts[announcement.index];
  if (!act) return '';
  const line = actLine(act, tc);
  if (announcement.mark === 'failed') return tc('act.call.announceFailed', { line });
  if (announcement.mark === 'refused') return tc('act.call.announceRefused', { line });
  return line;
}

/** A shortened object: the short form drawn, the full value reachable by
 *  pointer and keyboard (the shipped `Tooltip`, on hover AND focus) and in the
 *  accessible name (an `sr-only` span, read in reading order). */
function CallObject({
  placeholder,
  value,
  tc,
}: {
  placeholder: CallPlaceholder;
  value: string;
  tc: Tc;
}) {
  const { text, shortened } = shortenCallObject(placeholder, value);
  const mono = isMonoObject(placeholder, value);
  if (!shortened) {
    return mono ? <span className="font-mono text-[11px]">{value}</span> : <>{value}</>;
  }
  return (
    <Tooltip content={<span className="font-mono">{value}</span>}>
      <span
        tabIndex={0}
        data-testid="plan-change-call-object"
        className={`${mono ? 'font-mono text-[11px] ' : ''}rounded-(--radius-control) underline decoration-dotted underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`}
      >
        <span aria-hidden="true">{text}</span>
        <span className="sr-only">{tc(fullValueKey(placeholder), { value })}</span>
      </span>
    </Tooltip>
  );
}

/** A marker no catalogue line contains, used to split a formatted line around
 *  its object so the object can be an element. */
const OBJECT_SLOT = '\u0001';

function CallLineBody({ act, tc }: { act: CallAct; tc: Tc }) {
  const spec = callLineSpec(act);
  if (spec.placeholder === null || spec.value === null) return <>{tc(spec.key)}</>;
  const [before = '', after = ''] = tc(spec.key, { [spec.placeholder]: OBJECT_SLOT }).split(
    OBJECT_SLOT,
  );
  return (
    <>
      {before}
      <CallObject placeholder={spec.placeholder} value={spec.value} tc={tc} />
      {after}
    </>
  );
}

function CallLine({ act, live, tc }: { act: CallAct; live: boolean; tc: Tc }) {
  // A marked call is never live, even when it is the newest in its step.
  const spinning = live && act.outcome === 'running';
  return (
    <li
      data-testid="plan-change-call"
      data-outcome={act.outcome}
      className={`flex items-start gap-2 text-xs ${
        spinning ? 'text-(--el-text)' : 'text-(--el-text-secondary)'
      }`}
    >
      {spinning ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : (
        <span className="mt-px shrink-0 text-(--el-text-secondary)">
          <CallGlyph act={act} />
        </span>
      )}
      <span className="min-w-0 flex-1 wrap-anywhere">
        <CallLineBody act={act} tc={tc} />
        {act.outcome !== 'running' ? (
          <>
            {' '}
            <span
              data-testid="plan-change-call-mark"
              className="font-medium text-(--el-text-strong)"
            >
              {tc(MARK_KEY[act.outcome])}
            </span>
          </>
        ) : null}
      </span>
    </li>
  );
}

const DISCLOSURE_CLASS =
  'inline-flex shrink-0 items-center gap-0.5 rounded-(--radius-control) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-[11px] font-medium text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

/**
 * THE ACT RECORD (MOTIR-4069, amended by MOTIR-7975) — an accumulating record,
 * not a replacing line. Three columns per act row: glyph · mono act label · the
 * line (`design/ai-chat/plan-change-run-live.mock.html` sheet 3).
 *
 * ⚠️ THE SKIM AXIS IS THE MIDDLE COLUMN, NOT COLOUR. Every act line is the same
 * ink; what a reader runs their eye down is a fixed-width column of short mono
 * words, with the glyph as a second, non-textual cue.
 *
 * Per-call lines nest under their step (`plan-change-run-live--per-call.mock.html`
 * and its design-notes section): a finished step folds its calls behind a
 * disclosure that carries their count and how many failed, and an open step
 * shows its newest two with the rest behind an earlier-calls row. Folding is
 * presentation only; expanding shows every call in arrival order, and nothing
 * auto-folds a group the reader opened.
 *
 * The one `aria-live="polite"` region (`plan-change-progress`) now holds only an
 * `sr-only` announcer: replaced when a row is appended and when a call is marked
 * failed or refused. Calls are not announced — one per call would read the log
 * aloud. The record `<ol>` is its next sibling, ordinary content of the
 * transcript's `role="log"`.
 */
export function PlanActRecord({
  acts,
  streaming,
}: {
  acts: readonly PlanChangeProgress[];
  streaming: boolean;
}) {
  const tc = useTranslations('planningWorkspace.conversation');
  const baseId = useId();
  // A step the reader expanded stays expanded; so does an open step's earlier
  // calls. Keyed by the step's act index, which an append-only record keeps.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [earlierShown, setEarlierShown] = useState<ReadonlySet<number>>(() => new Set());
  // What the live region says, carried across renders: a change of record
  // replaces it only when a row is appended or a call is marked.
  const [said, setSaid] = useState<{
    acts: readonly PlanChangeProgress[];
    announcement: Announcement | null;
  }>(() => ({ acts, announcement: latestRowAnnouncement(acts) }));
  // By content, not identity: a host that hands the record as `[progress]`
  // builds a new array on every render, and that is not a change.
  const changed = said.acts.length !== acts.length || said.acts.some((act, i) => act !== acts[i]);
  if (changed) {
    const continues =
      said.acts.length <= acts.length && said.acts.every((a, i) => a.kind === acts[i]!.kind);
    const next = nextAnnouncement(said.acts, acts);
    setSaid({ acts, announcement: next ?? (continues ? said.announcement : null) });
    if (!continues) {
      // A new run: the old record's expansions belong to acts that are gone.
      if (expanded.size > 0) setExpanded(new Set());
      if (earlierShown.size > 0) setEarlierShown(new Set());
    }
  }

  const entries = groupActs(acts);
  const open = openSteps(acts, entries, streaming);
  const lastIndex = acts.length - 1;
  // The newest act that is neither a step nor a call (a note, a lookup row, a
  // debug turn's act): an open step BEFORE it no longer carries the spinner.
  let lastPlainRow = -1;
  acts.forEach((act, i) => {
    if (act.kind !== 'call' && !isStep(act)) lastPlainRow = i;
  });
  const toggle = (set: ReadonlySet<number>, index: number) => {
    const next = new Set(set);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return next;
  };

  return (
    <>
      <div aria-live="polite" data-testid="plan-change-progress">
        <p className="sr-only" data-testid="plan-change-announcer">
          {announcementText(acts, said.announcement, tc)}
        </p>
      </div>
      {acts.length > 0 ? (
        <ol
          data-testid="plan-change-acts"
          className="flex flex-col gap-1.5 rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-2"
        >
          {entries.map((entry) => {
            const act = acts[entry.index]!;
            if (entry.type === 'call' || act.kind === 'call') {
              return (
                <CallLine
                  key={`call-${entry.index}`}
                  act={act as CallAct}
                  live={streaming && entry.index === lastIndex}
                  tc={tc}
                />
              );
            }
            const calls = entry.type === 'act' ? entry.calls : [];
            const step = isStep(act);
            const isOpen = open.has(entry.index);
            // A zero-call row is the shipped row: the newest act is live while
            // the run streams, and an open step with no call yet carries the
            // spinner on its own row — until a row that is not a call follows it
            // (a debug turn's acts after its `reading`, a note), which is then
            // the live one.
            if (calls.length === 0) {
              const live =
                streaming &&
                (step ? isOpen && entry.index > lastPlainRow : entry.index === lastIndex);
              return (
                <li
                  key={`${act.kind}-${entry.index}`}
                  data-testid={`plan-change-act-${act.kind}`}
                  className={`flex items-start gap-2 text-xs ${
                    live ? 'text-(--el-text)' : 'text-(--el-text-secondary)'
                  }`}
                >
                  {live ? (
                    <Spinner size="sm" aria-hidden="true" />
                  ) : (
                    <span className="mt-px shrink-0 text-(--el-text-secondary)">
                      <ActGlyph act={act} />
                    </span>
                  )}
                  <span className="mt-px w-16 shrink-0 font-mono text-[10px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                    {tc(actLabelKey(act))}
                  </span>
                  <span className="min-w-0 flex-1">{actLine(act, tc)}</span>
                </li>
              );
            }
            const listId = `${baseId}-calls-${entry.index}`;
            const reader = expanded.has(entry.index);
            const folded = !isOpen && !reader;
            const earlierCount = Math.max(0, calls.length - OPEN_STEP_WINDOW);
            const showEarlier = !isOpen || earlierShown.has(entry.index);
            const visible = isOpen && !showEarlier ? calls.slice(-OPEN_STEP_WINDOW) : calls;
            const failed = failedCount(acts, calls);
            const newestCall = calls[calls.length - 1]!;
            return (
              <li
                key={`${act.kind}-${entry.index}`}
                data-testid={`plan-change-act-${act.kind}`}
                data-step={isOpen ? 'open' : folded ? 'folded' : 'expanded'}
                className={`flex flex-col gap-1 text-xs ${
                  isOpen ? 'text-(--el-text)' : 'text-(--el-text-secondary)'
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-px shrink-0 text-(--el-text-secondary)">
                    <ActGlyph act={act} />
                  </span>
                  <span className="mt-px w-16 shrink-0 font-mono text-[10px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                    {tc(actLabelKey(act))}
                  </span>
                  <span className="min-w-0 flex-1">{actLine(act, tc)}</span>
                  {isOpen ? null : (
                    <button
                      type="button"
                      aria-expanded={!folded}
                      aria-controls={listId}
                      data-testid="plan-change-calls-toggle"
                      onClick={() => setExpanded((set) => toggle(set, entry.index))}
                      className={`-my-px ml-auto ${DISCLOSURE_CLASS}`}
                    >
                      {folded ? (
                        <ChevronRight className="size-3" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="size-3" aria-hidden="true" />
                      )}
                      {failed > 0
                        ? tc('act.call.countFailed', { count: calls.length, failed })
                        : tc('act.call.count', { count: calls.length })}
                    </button>
                  )}
                </div>
                <ol
                  id={listId}
                  hidden={folded}
                  data-testid="plan-change-calls"
                  className="ml-5.5 flex flex-col gap-1 border-l border-(--el-border-strong) pl-2.5"
                >
                  {isOpen && earlierCount > 0 ? (
                    <li>
                      <button
                        type="button"
                        aria-expanded={showEarlier}
                        aria-controls={listId}
                        data-testid="plan-change-calls-earlier"
                        onClick={() => setEarlierShown((set) => toggle(set, entry.index))}
                        className={`-ml-1 ${DISCLOSURE_CLASS}`}
                      >
                        {showEarlier ? (
                          <ChevronDown className="size-3" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="size-3" aria-hidden="true" />
                        )}
                        {tc('act.call.earlier', { count: earlierCount })}
                      </button>
                    </li>
                  ) : null}
                  {visible.map((index) => (
                    <CallLine
                      key={`call-${index}`}
                      act={acts[index] as CallAct}
                      live={streaming && isOpen && index === newestCall}
                      tc={tc}
                    />
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      ) : null}
    </>
  );
}
