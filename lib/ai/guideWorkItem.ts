// The guide turn's WIRE, both directions (Story MOTIR-7459 · MOTIR-7464) — what
// core SENDS a `guide_work_item` job (`buildGuideContext`) and what it ACCEPTS back
// (`parseGuideTurn`). The mirror of motir-ai's `src/jobs/handlers/guideWorkItem.ts`
// (`GuideInput` / `GuideTurnResult`), against `docs/decisions/conversation-turn-intent.md`
// AMENDMENT 2 · A2.3.
//
// The same posture as `debugBug.ts`: the result is model output from a separately
// deployed service, and every action of it becomes a write on somebody's card. So
// this PARSES; it never casts. One malformed field refuses the WHOLE turn with
// `InvalidGuideTurnError` naming it — a half-read turn is worse than none, because
// its surviving half would land as if it were the whole of what Motir said.
//
// It is total over A2.3's CLOSED action set: an action whose `type` is outside it
// is a refusal, never an ignored row. motir-ai already drops what its input does not
// support; this side refuses what its OWN contract does not name.

/** motir-core's own caps (`lib/workItemTodos/limits.ts` and the card form). */
import {
  TODO_COMMAND_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_TEXT_MAX_LENGTH,
} from '@/lib/workItemTodos/limits';
import type { GuideContextFile, GuideContextFileNote } from '@/lib/ai/guideFiles';

/** The reason a `close` is skipped on a card a linked pull request will close
 *  (A2.6). Shared so the rail can say *No status changed* from the record rather
 *  than from the prose (design MOTIR-7462 panel 18). */
export const GUIDE_SKIP_LINKED_PULL_REQUEST =
  'a linked pull request closes this card when it merges';

/** A bound on the rail message, applied on READ (motir-ai caps it at 4 000). */
export const GUIDE_MESSAGE_MAX = 4_000;
/** A bound on a correction's / edit's / cannot-do's reason (motir-ai: 500). */
export const GUIDE_REASON_MAX = 500;
/** The guided card's field caps for `edit_item` — motir-ai's, which are no looser
 *  than the card form's. */
export const GUIDE_TITLE_MAX = 200;
export const GUIDE_DESCRIPTION_MAX = 20_000;
export const GUIDE_EXPLANATION_MAX = 8_000;
/** The most actions one turn may carry — far above anything the handler emits. */
export const GUIDE_ACTIONS_MAX = 64;
/** The most rows a list may carry on the wire. */
export const GUIDE_ROWS_MAX = 100;
/** How many turns the context carries — the latest ones. */
export const GUIDE_CONTEXT_TURNS_MAX = 40;
/** The longest prompt for the person's LOCAL agent (motir-ai: 2 000; A3.9 (a)). */
export const GUIDE_AGENT_PROMPT_MAX = 2_000;

// ── Out: the context core sends ────────────────────────────────────────────────

export type GuideExecutor = 'coding_agent' | 'human';

export interface GuideContextRow {
  id: string;
  text: string;
  notesMd: string | null;
  commandText: string | null;
  executor: GuideExecutor | null;
  done: boolean;
}

export interface GuideContextTurn {
  role: 'user' | 'assistant';
  body: string;
  /** On an assistant turn, the actions it returned — how a later turn undoes one. */
  actions?: unknown[];
  /** On a `user` turn that carried files, one note per file (A3.4). Content is
   *  never re-sent: only the CURRENT turn's files ride, in {@link GuideContext.files}. */
  files?: GuideContextFileNote[];
}

/** `context.guideContext` on a `guide_work_item` job (A2.3's input table). */
export interface GuideContext {
  card: {
    key: string;
    title: string;
    type: string | null;
    executor: string | null;
    status: string | null;
    descriptionMd: string;
    explanationMd: string;
    pullRequests: Array<{ url: string | null; state: string | null }>;
  };
  todos: { temporary: boolean; rows: GuideContextRow[] };
  turns: GuideContextTurn[];
  /** The CURRENT (latest `user`) turn's files, resolved (`guide-turn-files.md`
   *  A3.4). Absent when the turn carried none. */
  files?: GuideContextFile[];
}

/** What {@link buildGuideContext} reads off the card. */
export interface GuideCardInput {
  identifier: string;
  title: string;
  type: string | null;
  executor: string | null;
  statusKey: string | null;
  descriptionMd: string | null;
  explanationMd: string | null;
  pullRequests: ReadonlyArray<{ url: string | null; state: string | null }>;
}

export interface GuideRowInput {
  id: string;
  text: string;
  notesMd: string | null;
  commandText: string | null;
  executor: string | null;
  done: boolean;
}

/**
 * The job's input, in A2.3's shape. `rows` are taken IN THE ORDER GIVEN — the
 * caller passes the list in list order, which is the order the walk follows.
 * `temporary` marks a proposed list that lives on the conversation, not the card.
 * Only the latest {@link GUIDE_CONTEXT_TURNS_MAX} turns ride.
 */
export function buildGuideContext(
  card: GuideCardInput,
  rows: readonly GuideRowInput[],
  turns: readonly GuideContextTurn[],
  opts: { temporary?: boolean; files?: readonly GuideContextFile[] } = {},
): GuideContext {
  return {
    card: {
      key: card.identifier,
      title: card.title,
      type: card.type,
      executor: card.executor,
      status: card.statusKey,
      descriptionMd: card.descriptionMd ?? '',
      explanationMd: card.explanationMd ?? '',
      pullRequests: card.pullRequests.map((pr) => ({ url: pr.url, state: pr.state })),
    },
    todos: {
      temporary: opts.temporary === true && rows.length > 0,
      rows: rows.slice(0, GUIDE_ROWS_MAX).map((r) => ({
        id: r.id,
        text: r.text,
        notesMd: r.notesMd,
        commandText: r.commandText,
        executor: r.executor === 'coding_agent' || r.executor === 'human' ? r.executor : null,
        done: r.done,
      })),
    },
    turns: turns.slice(-GUIDE_CONTEXT_TURNS_MAX).map((t) => ({
      role: t.role,
      body: t.body,
      ...(t.role === 'assistant' && t.actions && t.actions.length > 0
        ? { actions: t.actions }
        : {}),
      ...(t.role === 'user' && t.files && t.files.length > 0 ? { files: t.files } : {}),
    })),
    ...(opts.files && opts.files.length > 0 ? { files: [...opts.files] } : {}),
  };
}

// ── In: the turn core accepts ──────────────────────────────────────────────────

export interface GuideStep {
  text: string;
  notesMd: string | null;
  commandText: string | null;
  executor: GuideExecutor | null;
}

export type GuideAction =
  | { type: 'propose_todos'; rows: Array<GuideStep & { id: string }> }
  | { type: 'write_todos'; rows: Array<GuideStep & { fromId: string; done: boolean }> }
  | { type: 'tick'; rowId: string }
  | { type: 'untick'; rowId: string }
  | ({ type: 'add_step'; afterRowId: string | null; reason: string } & GuideStep)
  | {
      type: 'revise_step';
      rowId: string;
      reason: string;
      text?: string;
      notesMd?: string | null;
      commandText?: string | null;
      executor?: GuideExecutor | null;
    }
  | { type: 'remove_step'; rowId: string; reason: string }
  | { type: 'move_step'; rowId: string; afterRowId: string | null; reason: string }
  | { type: 'current_step'; rowId: string }
  | { type: 'offer_close' }
  | { type: 'close' }
  | {
      type: 'edit_item';
      reason: string;
      title?: string;
      descriptionMd?: string;
      explanationMd?: string;
      previous: { title?: string; descriptionMd?: string; explanationMd?: string };
    }
  | { type: 'cannot_do'; reason: string }
  // A3.9 (a): a prompt for the person's LOCAL coding agent to run an agent step.
  // Writes nothing to the card; recorded on the conversation, like `current_step`.
  | { type: 'local_agent_prompt'; rowId: string; prompt: string }
  // A3.9 (b): the change asked for would alter the card's TARGET. Edits nothing;
  // landed like `cannot_do`, as a comment on the guided card.
  | { type: 'needs_replan'; reason: string };

export type GuideActionType = GuideAction['type'];

/** A2.3's closed set — the ONLY action types core will land. */
export const GUIDE_ACTION_TYPES = [
  'propose_todos',
  'write_todos',
  'tick',
  'untick',
  'add_step',
  'revise_step',
  'remove_step',
  'move_step',
  'current_step',
  'offer_close',
  'close',
  'edit_item',
  'cannot_do',
  'local_agent_prompt',
  'needs_replan',
] as const satisfies readonly GuideActionType[];

export interface GuideTurn {
  messageMd: string;
  actions: GuideAction[];
  /** What motir-ai refused, and why — informational; the message already says it. */
  dropped: Array<{ type: string; reason: string }>;
}

/** A `guideTurn` that does not satisfy the contract — `field` names where. */
export class InvalidGuideTurnError extends Error {
  readonly code = 'INVALID_GUIDE_TURN';
  constructor(
    readonly field: string,
    readonly problem: string,
  ) {
    super(`guideTurn.${field} ${problem}`);
    this.name = 'InvalidGuideTurnError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(raw: Record<string, unknown>, key: string, max: number, where: string): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new InvalidGuideTurnError(`${where}.${key}`, 'must be a non-empty string');
  }
  const t = v.trim();
  if (t.length > max)
    throw new InvalidGuideTurnError(`${where}.${key}`, `exceeds ${max} characters`);
  return t;
}

function optText(
  raw: Record<string, unknown>,
  key: string,
  max: number,
  where: string,
): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string')
    throw new InvalidGuideTurnError(`${where}.${key}`, 'must be a string or null');
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max)
    throw new InvalidGuideTurnError(`${where}.${key}`, `exceeds ${max} characters`);
  return t;
}

function nullableAfter(raw: Record<string, unknown>, where: string): string | null {
  const v = raw['afterRowId'];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || v.length === 0) {
    throw new InvalidGuideTurnError(`${where}.afterRowId`, 'must be a row id or null');
  }
  return v;
}

function executor(v: unknown, where: string): GuideExecutor | null {
  if (v === undefined || v === null) return null;
  if (v === 'coding_agent' || v === 'human') return v;
  throw new InvalidGuideTurnError(`${where}.executor`, 'must be coding_agent, human or null');
}

function step(raw: Record<string, unknown>, where: string): GuideStep {
  const t = text(raw, 'text', TODO_TEXT_MAX_LENGTH, where);
  if (/\n/.test(t)) throw new InvalidGuideTurnError(`${where}.text`, 'must be one line');
  return {
    text: t,
    notesMd: optText(raw, 'notesMd', TODO_NOTES_MAX_LENGTH, where),
    commandText: optText(raw, 'commandText', TODO_COMMAND_MAX_LENGTH, where),
    executor: executor(raw['executor'], where),
  };
}

function rowsOf(raw: Record<string, unknown>, where: string): Record<string, unknown>[] {
  const rows = raw['rows'];
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > GUIDE_ROWS_MAX) {
    throw new InvalidGuideTurnError(`${where}.rows`, `must hold 1–${GUIDE_ROWS_MAX} rows`);
  }
  return rows.map((r, i) => {
    if (!isRecord(r)) throw new InvalidGuideTurnError(`${where}.rows[${i}]`, 'must be an object');
    return r;
  });
}

function parseAction(raw: unknown, i: number): GuideAction {
  const where = `actions[${i}]`;
  if (!isRecord(raw)) throw new InvalidGuideTurnError(where, 'must be an object');
  const type = raw['type'];
  const id = (key: string) => text(raw, key, 200, where);
  const reason = () => text(raw, 'reason', GUIDE_REASON_MAX, where);
  switch (type) {
    case 'propose_todos':
      return {
        type,
        rows: rowsOf(raw, where).map((r, j) => ({
          id: text(r, 'id', 200, `${where}.rows[${j}]`),
          ...step(r, `${where}.rows[${j}]`),
        })),
      };
    case 'write_todos':
      return {
        type,
        rows: rowsOf(raw, where).map((r, j) => {
          const w = `${where}.rows[${j}]`;
          if (typeof r['done'] !== 'boolean') {
            throw new InvalidGuideTurnError(`${w}.done`, 'must be a boolean');
          }
          return { fromId: text(r, 'fromId', 200, w), done: r['done'], ...step(r, w) };
        }),
      };
    case 'tick':
    case 'untick':
    case 'current_step':
      return { type, rowId: id('rowId') };
    case 'add_step':
      return { type, afterRowId: nullableAfter(raw, where), reason: reason(), ...step(raw, where) };
    case 'revise_step': {
      const out: Extract<GuideAction, { type: 'revise_step' }> = {
        type,
        rowId: id('rowId'),
        reason: reason(),
      };
      if ('text' in raw) {
        const t = text(raw, 'text', TODO_TEXT_MAX_LENGTH, where);
        if (/\n/.test(t)) throw new InvalidGuideTurnError(`${where}.text`, 'must be one line');
        out.text = t;
      }
      if ('notesMd' in raw) out.notesMd = optText(raw, 'notesMd', TODO_NOTES_MAX_LENGTH, where);
      if ('commandText' in raw) {
        out.commandText = optText(raw, 'commandText', TODO_COMMAND_MAX_LENGTH, where);
      }
      if ('executor' in raw) out.executor = executor(raw['executor'], where);
      if (Object.keys(out).length === 3) {
        throw new InvalidGuideTurnError(where, 'revise_step must change at least one field');
      }
      return out;
    }
    case 'remove_step':
      return { type, rowId: id('rowId'), reason: reason() };
    case 'move_step':
      return { type, rowId: id('rowId'), afterRowId: nullableAfter(raw, where), reason: reason() };
    case 'offer_close':
    case 'close':
      return { type };
    case 'edit_item': {
      const allowed = new Set([
        'type',
        'reason',
        'title',
        'descriptionMd',
        'explanationMd',
        'previous',
      ]);
      const extra = Object.keys(raw).filter((k) => !allowed.has(k));
      if (extra.length > 0) {
        throw new InvalidGuideTurnError(where, `edit_item may not name ${extra.join(', ')}`);
      }
      const out: Extract<GuideAction, { type: 'edit_item' }> = {
        type,
        reason: reason(),
        previous: {},
      };
      if ('title' in raw) {
        const t = text(raw, 'title', GUIDE_TITLE_MAX, where);
        if (/\n/.test(t)) throw new InvalidGuideTurnError(`${where}.title`, 'must be one line');
        out.title = t;
      }
      for (const [key, max] of [
        ['descriptionMd', GUIDE_DESCRIPTION_MAX],
        ['explanationMd', GUIDE_EXPLANATION_MAX],
      ] as const) {
        if (!(key in raw)) continue;
        const v = raw[key];
        if (typeof v !== 'string')
          throw new InvalidGuideTurnError(`${where}.${key}`, 'must be a string');
        if (v.length > max)
          throw new InvalidGuideTurnError(`${where}.${key}`, `exceeds ${max} characters`);
        out[key] = v.trim();
      }
      if (
        out.title === undefined &&
        out.descriptionMd === undefined &&
        out.explanationMd === undefined
      ) {
        throw new InvalidGuideTurnError(where, 'edit_item must change at least one field');
      }
      const prev = raw['previous'];
      if (isRecord(prev)) {
        for (const key of ['title', 'descriptionMd', 'explanationMd'] as const) {
          if (typeof prev[key] === 'string') out.previous[key] = prev[key];
        }
      }
      return out;
    }
    case 'cannot_do':
    case 'needs_replan':
      return { type, reason: reason() };
    case 'local_agent_prompt': {
      const v = raw['prompt'];
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new InvalidGuideTurnError(`${where}.prompt`, 'must be a non-empty string');
      }
      const prompt = v.trim();
      if (prompt.length > GUIDE_AGENT_PROMPT_MAX) {
        throw new InvalidGuideTurnError(
          `${where}.prompt`,
          `exceeds ${GUIDE_AGENT_PROMPT_MAX} characters`,
        );
      }
      return { type, rowId: id('rowId'), prompt };
    }
    default:
      throw new InvalidGuideTurnError(
        `${where}.type`,
        `${JSON.stringify(type)} is not one of ${GUIDE_ACTION_TYPES.join(' | ')}`,
      );
  }
}

/**
 * A `guide_work_item` result's `guideTurn`, VALIDATED. Throws
 * {@link InvalidGuideTurnError} on the first field outside the contract —
 * including any action outside A2.3's closed set — so nothing of a malformed turn
 * is landed.
 */
export function parseGuideTurn(raw: unknown): GuideTurn {
  if (!isRecord(raw)) throw new InvalidGuideTurnError('(root)', 'must be an object');
  const messageMd = text(raw, 'messageMd', GUIDE_MESSAGE_MAX, '(root)');
  const actionsRaw = raw['actions'] ?? [];
  if (!Array.isArray(actionsRaw) || actionsRaw.length > GUIDE_ACTIONS_MAX) {
    throw new InvalidGuideTurnError('actions', `must be an array of at most ${GUIDE_ACTIONS_MAX}`);
  }
  const actions = actionsRaw.map(parseAction);
  const droppedRaw = Array.isArray(raw['dropped']) ? raw['dropped'] : [];
  const dropped = droppedRaw.filter(isRecord).map((d) => ({
    type: typeof d['type'] === 'string' ? d['type'] : 'unknown',
    reason: typeof d['reason'] === 'string' ? d['reason'].slice(0, GUIDE_REASON_MAX) : '',
  }));
  return { messageMd, actions, dropped };
}

// ── The record: what a settled guide turn did (MOTIR-7470) ───────────────────

/**
 * What ONE action of a settled guide turn did (A2.4):
 *  * `landed` — written to the card through the service that owns the write;
 *  * `recorded` — kept on the conversation only (a temporary walk's tick, a
 *    proposal, the current step, the close offer);
 *  * `skipped` — refused by its guard, with the reason the turn states. A
 *    skipped action never fails the turn: the others still land.
 */
export interface GuideActionOutcome {
  type: GuideActionType;
  outcome: 'landed' | 'recorded' | 'skipped';
  /** Why it was skipped, in words the rail can show. */
  reason?: string;
  /** The to-do row it touched on the CARD, when it landed on one. */
  todoId?: string;
}

/** The `guide_turn` column on an assistant turn: the validated actions, each
 *  one's outcome (same order), and whether the walk was on a temporary list. */
export interface GuideTurnRecord {
  actions: GuideAction[];
  outcomes: GuideActionOutcome[];
  temporary: boolean;
}

/**
 * The persisted `guide_turn` JSON → its record, or null. Written only by the
 * landing, so this is a NARROWING: the actions are re-run through the same
 * parser that admitted them, and a record that no longer parses reads as null
 * rather than as a guess.
 */
export function readGuideTurnRecord(value: unknown): GuideTurnRecord | null {
  if (!isRecord(value) || !Array.isArray(value['actions'])) return null;
  let actions: GuideAction[];
  try {
    actions = parseGuideTurn({ messageMd: '-', actions: value['actions'] }).actions;
  } catch {
    return null;
  }
  const rawOutcomes = Array.isArray(value['outcomes']) ? value['outcomes'] : [];
  const outcomes: GuideActionOutcome[] = actions.map((a, i) => {
    const o = rawOutcomes[i];
    const kind = isRecord(o) ? o['outcome'] : undefined;
    return {
      type: a.type,
      outcome: kind === 'landed' || kind === 'recorded' ? kind : 'skipped',
      ...(isRecord(o) && typeof o['reason'] === 'string' ? { reason: o['reason'] } : {}),
      ...(isRecord(o) && typeof o['todoId'] === 'string' ? { todoId: o['todoId'] } : {}),
    };
  });
  return { actions, outcomes, temporary: value['temporary'] === true };
}

/** The id a temporary walk gives a step an `add_step` added — derived from where
 *  the action sits, so every reader of the thread derives the same one. */
export function temporaryAddedStepId(turnSeq: number, actionIndex: number): string {
  return `tmp-t${turnSeq}-a${actionIndex}`;
}

/**
 * The TEMPORARY list as the conversation now stands (A2.2 / A2.3): the latest
 * `propose_todos`, with every action the conversation RECORDED since applied in
 * order — ticks, unticks and corrections. A `write_todos` that landed ends it:
 * the list is the card's from then on, so the result is empty.
 *
 * Pure, and derived only from the assistant turns' records, so an unsaved walk
 * lives on the conversation and is discarded with it.
 */
export function deriveTemporaryList(
  turns: ReadonlyArray<{ seq: number; record: GuideTurnRecord | null }>,
): GuideRowInput[] {
  let rows: GuideRowInput[] = [];
  const indexOf = (id: string) => rows.findIndex((r) => r.id === id);
  // `null` puts the row first; an anchor that is no longer on the list puts it last.
  const insertAfter = (afterRowId: string | null, row: GuideRowInput) => {
    if (afterRowId === null) return void rows.splice(0, 0, row);
    const anchor = indexOf(afterRowId);
    rows.splice(anchor < 0 ? rows.length : anchor + 1, 0, row);
  };
  for (const { seq, record } of turns) {
    if (!record) continue;
    record.actions.forEach((action, i) => {
      const outcome = record.outcomes[i]?.outcome;
      if (action.type === 'write_todos' && outcome === 'landed') {
        rows = [];
        return;
      }
      if (outcome !== 'recorded') return;
      switch (action.type) {
        case 'propose_todos':
          rows = action.rows.map((r) => ({
            id: r.id,
            text: r.text,
            notesMd: r.notesMd,
            commandText: r.commandText,
            executor: r.executor,
            done: false,
          }));
          return;
        case 'tick':
        case 'untick': {
          const at = indexOf(action.rowId);
          if (at >= 0) rows[at] = { ...rows[at]!, done: action.type === 'tick' };
          return;
        }
        case 'add_step':
          insertAfter(action.afterRowId, {
            id: temporaryAddedStepId(seq, i),
            text: action.text,
            notesMd: action.notesMd,
            commandText: action.commandText,
            executor: action.executor,
            done: false,
          });
          return;
        case 'revise_step': {
          const at = indexOf(action.rowId);
          if (at < 0) return;
          const cur = rows[at]!;
          rows[at] = {
            ...cur,
            ...(action.text !== undefined ? { text: action.text } : {}),
            ...(action.notesMd !== undefined ? { notesMd: action.notesMd } : {}),
            ...(action.commandText !== undefined ? { commandText: action.commandText } : {}),
            ...(action.executor !== undefined ? { executor: action.executor } : {}),
          };
          return;
        }
        case 'remove_step': {
          const at = indexOf(action.rowId);
          if (at >= 0) rows.splice(at, 1);
          return;
        }
        case 'move_step': {
          const at = indexOf(action.rowId);
          if (at < 0) return;
          const [moved] = rows.splice(at, 1);
          insertAfter(action.afterRowId, moved!);
          return;
        }
        default:
          return;
      }
    });
  }
  return rows;
}
