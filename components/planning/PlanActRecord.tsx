'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Ban,
  BookOpenText,
  CircleQuestionMark,
  CornerDownRight,
  FilePenLine,
  ListTree,
  MessageSquareText,
  PenLine,
  ScanSearch,
  Search,
  SearchCheck,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';
import {
  continuesRecord,
  isSessionStep,
  isStep,
  latestRowAnnouncement,
  nextAnnouncement,
  openSteps,
  withoutCalls,
} from '@/components/planning/planCallLines';
import { nextHeadAnnouncement, type NarrationHeadLine } from '@/components/planning/planNarration';

type Tc = ReturnType<typeof useTranslations>;

/** One glyph per act kind — the second, non-textual skim cue (sheet 3).
 *  Keyed on the KIND so the map is exhaustive by type: a new `PlanChangeProgress`
 *  member without a glyph does not compile, which is the same discipline the
 *  frame dispositions use one layer down. A `call` act is never drawn
 *  (MOTIR-8064); its entry is here only because the map is exhaustive. */
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

function ActGlyph({ act }: { act: PlanChangeProgress }) {
  // The BLOCKED lookup is the one act whose glyph is decided by its payload, not
  // its kind: sheet 3 gives "out of lookups" the `ban` glyph so the moment the
  // run stopped being able to read is visible at a skim.
  const Icon = act.kind === 'retrieval' && act.blocked ? Ban : ACT_GLYPH[act.kind];
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

/** The mono LABEL column's catalog key. */
function actLabelKey(act: PlanChangeProgress): string {
  return `act.${act.kind}`;
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
    default:
      return tc(`progress.${act.kind}`, { count: 0 });
  }
}

/** The text the running bar repeats while a run streams: the newest act the
 *  record draws, or null when there is none. A call is never repeated
 *  (MOTIR-8064), so the bar keeps its shipped one-line form. */
export function runningBarLine(acts: readonly PlanChangeProgress[], tc: Tc): string | null {
  const rows = withoutCalls(acts);
  const last = rows[rows.length - 1];
  return last ? actLine(last, tc) : null;
}

/**
 * THE ACT RECORD (MOTIR-4069, amended by MOTIR-7975 and by MOTIR-8064) — an
 * accumulating record, not a replacing line. Three columns per act row: glyph ·
 * mono act label · the line (`design/ai-chat/plan-change-run-live.mock.html`
 * sheet 3).
 *
 * ⚠️ THE SKIM AXIS IS THE MIDDLE COLUMN, NOT COLOUR. Every act line is the same
 * ink; what a reader runs their eye down is a fixed-width column of short mono
 * words, with the glyph as a second, non-textual cue.
 *
 * ⚠️ NO TOOL-CALL LINES. `design/ai-chat/design-notes.md` § "⭐ Planner narration
 * in the chat panel" (MOTIR-8061) amends MOTIR-7975's § "The per-call line on the
 * planning rail": the `CallLine` rows, the step disclosure that folded them and
 * the open step's earlier-calls row are gone for both planners, and a failed or
 * refused call's mark is dropped. The run rows a stream still produces stay. When
 * the plan's narration names its sessions (`sessionHeads`), the stream's `laying`
 * / `authoring` rows are not drawn either: the session heads replace them, from
 * the store.
 *
 * The one `aria-live="polite"` region (`plan-change-progress`) holds only an
 * `sr-only` announcer: replaced when a row is appended, and — from the narration's
 * group heads (`heads`) — when a session's group first appears, its step words
 * change, or it ends. A narration sentence is never announced. The record `<ol>`
 * is its next sibling, ordinary content of the transcript's `role="log"`.
 */
export function PlanActRecord({
  acts: allActs,
  streaming,
  sessionHeads = false,
  heads = NO_HEADS,
}: {
  acts: readonly PlanChangeProgress[];
  streaming: boolean;
  /** The narration's session heads stand in for the stream's step rows. */
  sessionHeads?: boolean;
  /** The narration's group heads, in words, for the announcer. */
  heads?: readonly NarrationHeadLine[];
}) {
  const tc = useTranslations('planningWorkspace.conversation');
  const said = useAnnouncer(withoutCalls(allActs), heads, tc);
  const acts = withoutCalls(allActs);
  const open = openSteps(acts, streaming);
  const lastIndex = acts.length - 1;
  // The newest act that is not a step (a note, a lookup row, a debug turn's
  // act): an open step BEFORE it no longer carries the spinner.
  let lastPlainRow = -1;
  acts.forEach((act, i) => {
    if (!isStep(act)) lastPlainRow = i;
  });
  const drawn = acts.flatMap((act, index) =>
    sessionHeads && isSessionStep(act) ? [] : [{ act, index }],
  );

  return (
    <>
      <div aria-live="polite" data-testid="plan-change-progress">
        <p className="sr-only" data-testid="plan-change-announcer">
          {said}
        </p>
      </div>
      {drawn.length > 0 ? (
        <ol
          data-testid="plan-change-acts"
          className="flex flex-col gap-1.5 rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-2"
        >
          {drawn.map(({ act, index }) => {
            // The newest act is live while the run streams; an open step carries
            // the spinner on its own row until a row that is not a step follows it.
            const live =
              streaming &&
              (isStep(act) ? open.has(index) && index > lastPlainRow : index === lastIndex);
            return <ActRow key={`${act.kind}-${index}`} act={act} live={live} tc={tc} />;
          })}
        </ol>
      ) : null}
    </>
  );
}

const NO_HEADS: readonly NarrationHeadLine[] = [];

function ActRow({ act, live, tc }: { act: PlanChangeProgress; live: boolean; tc: Tc }) {
  return (
    <li
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

/**
 * What the live region says, carried across renders: replaced only when a row is
 * appended or a head changes, never on an unrelated re-render. Compared by
 * content, not identity: a host that hands the record as `[progress]` builds a
 * new array on every render, and that is not a change.
 */
function useAnnouncer(
  acts: readonly PlanChangeProgress[],
  heads: readonly NarrationHeadLine[],
  tc: Tc,
): string {
  const [said, setSaid] = useState(() => {
    const index = latestRowAnnouncement(acts);
    return { acts, heads, text: index === null ? '' : actLine(acts[index]!, tc) };
  });
  const actsChanged =
    said.acts.length !== acts.length || said.acts.some((act, i) => act !== acts[i]);
  const headsChanged =
    said.heads.length !== heads.length ||
    said.heads.some((h, i) => h.line !== heads[i]!.line || h.live !== heads[i]!.live);
  if (actsChanged || headsChanged) {
    const row = actsChanged ? nextAnnouncement(said.acts, acts) : null;
    const head = headsChanged ? nextHeadAnnouncement(said.heads, heads) : null;
    let text = continuesRecord(said.acts, acts) ? said.text : '';
    if (row !== null) text = actLine(acts[row]!, tc);
    if (head !== null) {
      text = head.finished ? tc('narration.groupFinished', { step: head.line }) : head.line;
    }
    setSaid({ acts, heads, text });
  }
  return said.text;
}
