import {
  deriveTemporaryList,
  GUIDE_SKIP_LINKED_PULL_REQUEST,
  temporaryAddedStepId,
  type GuideAction,
  type GuideActionOutcome,
  type GuideTurnRecord,
} from '@/lib/ai/guideWorkItem';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { ExecutorDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// THE GUIDE MODE'S VIEW (Story MOTIR-7459 · MOTIR-7466) — the pure derivation the
// overlay's two panes draw, from the two things they have: the guide
// conversation's turns (each assistant turn carries its landed record, MOTIR-7470)
// and the card's own rows as last read.
//
// One function for both panes, so the canvas and the rail cannot disagree about
// which list is on screen, which step is current, or what the last turn did. It
// is framework-free, so every rule here is unit-tested without a render.
//
// ⚠️ THE LIST IS THE CARD'S OR THE CONVERSATION'S, NEVER A MIX (A2.2). A card
// with rows walks its rows. A card with none walks the conversation's TEMPORARY
// list, derived from the recorded `propose_todos` and every recorded action after
// it (`deriveTemporaryList`, the same reader the landing uses) — so a reload
// draws exactly the list the next turn will be sent.

/** A row as the guide canvas draws it. */
export interface GuideRow {
  id: string;
  text: string;
  notesMd: string | null;
  commandText: string | null;
  executor: ExecutorDto | null;
  done: boolean;
  doneBy?: { id: string; name: string } | null;
}

/** A tag the LATEST turn put on a row — gone when the next turn settles. */
export type GuideRowTag = 'added' | 'changed' | 'moved' | 'cannot';

/**
 * Which list is on the canvas:
 *  * `loading` — the card's rows have not been read yet;
 *  * `empty` — the card has no rows and nothing was proposed (yet);
 *  * `proposed` — a list Motir AI proposed and the person has not chosen on;
 *  * `temporary` — the person chose to walk it without saving;
 *  * `saved` — the card's own rows.
 */
export type GuideListKind = 'loading' | 'empty' | 'proposed' | 'temporary' | 'saved';

/** A reply-row button (design panels 3, 7–11, 16, 21). */
export type GuideReply = 'save' | 'walk' | 'undo' | 'closeYes' | 'closeNo' | 'reload';

export interface GuideView {
  kind: GuideListKind;
  rows: GuideRow[];
  /** The step the walk is on, or null when every step is done (or none exist). */
  currentId: string | null;
  /** 1-based position of {@link currentId}. */
  currentStep: number | null;
  done: number;
  total: number;
  tags: Record<string, GuideRowTag>;
  /** The guided card's title after the latest landed `edit_item` that set one. */
  editedTitle: string | null;
  /** Whether that title was set by the LATEST turn (it is marked until the next). */
  titleEditedNow: boolean;
  /** The reply row under the latest assistant turn. */
  replies: GuideReply[];
  /** The latest turn's `edit_item` was refused: the card changed under it. */
  stale: boolean;
}

interface AssistantRecord {
  seq: number;
  record: GuideTurnRecord | null;
}

const CORRECTIONS = new Set<GuideAction['type']>([
  'add_step',
  'revise_step',
  'remove_step',
  'move_step',
]);

function took(outcome: GuideActionOutcome | undefined): boolean {
  return outcome?.outcome === 'landed' || outcome?.outcome === 'recorded';
}

function assistantRecords(turns: readonly PlanChangeTurnDto[]): AssistantRecord[] {
  return turns
    .filter((t) => t.role === 'assistant')
    .map((t) => ({ seq: t.seq, record: t.guide ?? null }));
}

/** The latest assistant turn, and whether a `user` turn has been sent after it. */
function latestAssistant(turns: readonly PlanChangeTurnDto[]): {
  turn: PlanChangeTurnDto | null;
  answered: boolean;
} {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    if (t.role === 'assistant') {
      return { turn: t, answered: turns.slice(i + 1).some((u) => u.role === 'user') };
    }
  }
  return { turn: null, answered: false };
}

/** The tags the latest turn's corrections put on rows. */
function tagsOf(
  turn: PlanChangeTurnDto | null,
  temporary: boolean,
  currentAtTurn: string | null,
): Record<string, GuideRowTag> {
  const tags: Record<string, GuideRowTag> = {};
  const record = turn?.guide;
  if (!turn || !record) return tags;
  record.actions.forEach((action, i) => {
    const outcome = record.outcomes[i];
    if (!took(outcome)) return;
    switch (action.type) {
      case 'add_step': {
        const id = temporary ? temporaryAddedStepId(turn.seq, i) : outcome?.todoId;
        if (id) tags[id] = 'added';
        return;
      }
      case 'revise_step':
        tags[outcome?.todoId ?? action.rowId] = 'changed';
        return;
      case 'move_step':
        tags[outcome?.todoId ?? action.rowId] = 'moved';
        return;
      case 'cannot_do':
        if (currentAtTurn) tags[currentAtTurn] = 'cannot';
        return;
      default:
        return;
    }
  });
  return tags;
}

/** The latest `current_step` any turn recorded, newest first. */
function namedCurrent(turns: readonly PlanChangeTurnDto[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const record = turns[i]!.guide;
    if (!record) continue;
    for (let j = record.actions.length - 1; j >= 0; j -= 1) {
      const action = record.actions[j]!;
      if (action.type === 'current_step' && took(record.outcomes[j])) return action.rowId;
    }
  }
  return null;
}

/** The title the latest landed `edit_item` gave the card, and the turn it was on. */
function editedTitleOf(turns: readonly PlanChangeTurnDto[]): { title: string; seq: number } | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    const record = t.guide;
    if (!record) continue;
    for (let j = record.actions.length - 1; j >= 0; j -= 1) {
      const action = record.actions[j]!;
      if (
        action.type === 'edit_item' &&
        action.title !== undefined &&
        record.outcomes[j]?.outcome === 'landed'
      ) {
        return { title: action.title, seq: t.seq };
      }
    }
  }
  return null;
}

/** The reply row a settled turn earns (design notes § What guide mode changes, 5). */
function repliesOf(turn: PlanChangeTurnDto, kind: GuideListKind): GuideReply[] {
  const record = turn.guide;
  if (!record) return [];
  const out: GuideReply[] = [];
  const has = (type: GuideAction['type'], pred = took) =>
    record.actions.some((a, i) => a.type === type && pred(record.outcomes[i]));
  if (kind === 'proposed' && has('propose_todos')) out.push('save', 'walk');
  if (has('offer_close')) out.push('closeYes', 'closeNo');
  const undoable = record.actions.some(
    (a, i) =>
      (CORRECTIONS.has(a.type) || a.type === 'edit_item') &&
      (a.type === 'edit_item'
        ? record.outcomes[i]?.outcome === 'landed'
        : took(record.outcomes[i])),
  );
  if (undoable) out.push('undo');
  if (has('edit_item', (o) => o?.outcome === 'skipped')) out.push('reload');
  return out;
}

/**
 * The view, from the conversation and the card's rows. `cardRows` is null until
 * the first read lands. `idle` is false while a turn runs: the reply row is
 * drawn only under a settled turn nobody has answered yet.
 */
export function deriveGuideView(
  turns: readonly PlanChangeTurnDto[],
  cardRows: readonly WorkItemTodoDto[] | null,
  opts: { idle: boolean },
): GuideView {
  const { turn: latest, answered } = latestAssistant(turns);
  const edited = editedTitleOf(turns);
  const base = {
    editedTitle: edited?.title ?? null,
    titleEditedNow: edited !== null && latest !== null && edited.seq === latest.seq,
  };

  let kind: GuideListKind;
  let rows: GuideRow[];
  if (cardRows === null) {
    kind = 'loading';
    rows = [];
  } else if (cardRows.length > 0) {
    kind = 'saved';
    rows = cardRows.map((r) => ({
      id: r.id,
      text: r.text,
      notesMd: r.notesMd,
      commandText: r.commandText,
      executor: r.executor,
      done: r.done,
      doneBy: r.doneBy ?? null,
    }));
  } else {
    const temp = deriveTemporaryList(assistantRecords(turns));
    rows = temp.map((r) => ({
      id: r.id,
      text: r.text,
      notesMd: r.notesMd,
      commandText: r.commandText,
      executor: r.executor === 'coding_agent' || r.executor === 'human' ? r.executor : null,
      done: r.done,
    }));
    // PROPOSED while the latest turn is the proposal itself — the person has not
    // chosen yet. Every later turn walks it (A2.2: a walk is chosen in words).
    const proposedNow =
      latest?.guide?.actions.some(
        (a, i) => a.type === 'propose_todos' && latest.guide!.outcomes[i]?.outcome === 'recorded',
      ) ?? false;
    kind = rows.length === 0 ? 'empty' : proposedNow ? 'proposed' : 'temporary';
  }

  // The current step: the one the conversation named, while it is on the list
  // and not done; else the first step not done (a person ticked ahead, or no
  // turn has named one yet). A proposed list has no current step: nothing is
  // being walked.
  let currentId: string | null = null;
  if (kind === 'saved' || kind === 'temporary') {
    const named = namedCurrent(turns);
    const namedRow = named ? rows.find((r) => r.id === named && !r.done) : undefined;
    currentId = namedRow?.id ?? rows.find((r) => !r.done)?.id ?? null;
  }
  const currentIndex = currentId ? rows.findIndex((r) => r.id === currentId) : -1;

  return {
    ...base,
    kind,
    rows,
    currentId,
    currentStep: currentIndex >= 0 ? currentIndex + 1 : null,
    done: rows.filter((r) => r.done).length,
    total: rows.length,
    tags: kind === 'loading' ? {} : tagsOf(latest, kind === 'temporary', currentId),
    replies: latest && opts.idle && !answered ? repliesOf(latest, kind) : [],
    stale:
      latest?.guide?.actions.some(
        (a, i) => a.type === 'edit_item' && latest.guide!.outcomes[i]?.outcome === 'skipped',
      ) ?? false,
  };
}

/** One line of a turn's OUTCOME foot — built from what LANDED, never from prose. */
export type GuideOutcomeLine =
  | { kind: 'ticked'; step: number | null; temporary: boolean; noStatus: boolean }
  | { kind: 'unticked'; step: number | null; temporary: boolean }
  | { kind: 'saved'; count: number; done: number }
  | {
      kind: 'added' | 'changed' | 'removed' | 'moved';
      step: number | null;
      temporary: boolean;
    }
  | { kind: 'edited'; fields: Array<'title' | 'description' | 'explanation'> }
  | { kind: 'commented'; reason: string }
  | { kind: 'closed' };

/**
 * The outcome lines of one assistant turn (design panels 2–18). `rows` is the
 * list as it NOW stands, which is where a step number is read from; a step that
 * has since left the list reads without one rather than with a wrong one.
 */
export function guideOutcomeLines(
  record: GuideTurnRecord | null | undefined,
  rows: readonly GuideRow[],
  seq: number,
): GuideOutcomeLine[] {
  if (!record) return [];
  const stepOf = (id: string | undefined): number | null => {
    if (!id) return null;
    const at = rows.findIndex((r) => r.id === id);
    return at >= 0 ? at + 1 : null;
  };
  const prLeftOpen = record.actions.some(
    (a, i) =>
      a.type === 'close' &&
      record.outcomes[i]?.outcome === 'skipped' &&
      record.outcomes[i]?.reason === GUIDE_SKIP_LINKED_PULL_REQUEST,
  );
  const lines: GuideOutcomeLine[] = [];
  record.actions.forEach((action, i) => {
    const outcome = record.outcomes[i];
    if (!took(outcome)) return;
    // A temporary walk's recorded acts say so; a saved list's say where they landed.
    const onWalk = outcome?.outcome === 'recorded';
    switch (action.type) {
      case 'tick':
        lines.push({
          kind: 'ticked',
          step: stepOf(outcome?.todoId ?? action.rowId),
          temporary: onWalk,
          noStatus: prLeftOpen,
        });
        return;
      case 'untick':
        lines.push({
          kind: 'unticked',
          step: stepOf(outcome?.todoId ?? action.rowId),
          temporary: onWalk,
        });
        return;
      case 'write_todos':
        if (outcome?.outcome !== 'landed') return;
        lines.push({
          kind: 'saved',
          count: action.rows.length,
          done: action.rows.filter((r) => r.done).length,
        });
        return;
      case 'add_step':
        lines.push({
          kind: 'added',
          step: stepOf(onWalk ? temporaryAddedStepId(seq, i) : outcome?.todoId),
          temporary: onWalk,
        });
        return;
      case 'revise_step':
      case 'move_step':
        lines.push({
          kind: action.type === 'revise_step' ? 'changed' : 'moved',
          step: stepOf(outcome?.todoId ?? action.rowId),
          temporary: onWalk,
        });
        return;
      case 'remove_step':
        lines.push({ kind: 'removed', step: null, temporary: onWalk });
        return;
      case 'edit_item': {
        if (outcome?.outcome !== 'landed') return;
        const fields: Array<'title' | 'description' | 'explanation'> = [];
        if (action.title !== undefined) fields.push('title');
        if (action.descriptionMd !== undefined) fields.push('description');
        if (action.explanationMd !== undefined) fields.push('explanation');
        lines.push({ kind: 'edited', fields });
        return;
      }
      case 'cannot_do':
      // A re-plan is landed as a comment too (`guide-turn-files.md` A3.9 (b);
      // design MOTIR-7482 panel 13): the same line, the comment glyph, no tag.
      case 'needs_replan':
        if (outcome?.outcome === 'landed') lines.push({ kind: 'commented', reason: action.reason });
        return;
      case 'close':
        if (outcome?.outcome === 'landed') lines.push({ kind: 'closed' });
        return;
      default:
        return;
    }
  });
  return lines;
}
