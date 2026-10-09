import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';

/**
 * THE PER-CALL LINE, as data (Story MOTIR-7974 · MOTIR-7979).
 *
 * Everything here is pure: which catalogue line a `call` act reads as, how its
 * object is shortened, which step it nests under, which steps are open, what the
 * running bar repeats and what the one live region announces. `PlanChangeRail`
 * renders from it. The authority for every rule is
 * `design/ai-chat/design-notes.md` § "⭐ The per-call line on the planning rail"
 * and its delta mock `plan-change-run-live--per-call.mock.html` (MOTIR-7975).
 *
 * ⚠️ THE RECORD STAYS FLAT. `acts` is the hook's append-only list and
 * `applyPlanFrame` owns it; the grouping below is a VIEW derived at render time,
 * so nothing is merged, re-ordered or dropped by it.
 */

export type CallAct = Extract<PlanChangeProgress, { kind: 'call' }>;

/** The placeholder a tool's template fills. `symbol` is a code-graph node
 *  (`object.kind: 'query'`), `title` an item named by its new title. */
export type CallPlaceholder = 'path' | 'query' | 'symbol' | 'item' | 'parent' | 'title';

/**
 * The design's copy table, keyed by tool: the placeholder its catalogue line
 * (`act.call.tool.<tool>`) fills, or `null` for a line that takes no object.
 *
 * Enumerated at motir-ai `97e73fb` (the design notes give the commands): the 18
 * retrieval tools over six families and the walk's 22 session tools. A tool not
 * listed here reads as its FAMILY's generic line.
 */
export const CALL_TOOL_PLACEHOLDER: Readonly<Record<string, CallPlaceholder | null>> = {
  skeleton: null,
  search_work_items: 'query',
  search_work_items_semantic: 'query',
  get_item: 'item',
  get_subtree: 'item',
  walk_blocking: 'item',
  code_search: 'query',
  code_explore: 'query',
  code_callers: 'symbol',
  code_callees: 'symbol',
  code_impact: 'symbol',
  code_node: 'symbol',
  get_coding_convention: null,
  get_code_health: null,
  read_file: 'path',
  list_changed_files: null,
  web_search: 'query',
  search_lessons: 'query',
  lay: 'parent',
  drill_into: 'parent',
  propose_node: 'title',
  complete_level: null,
  target_already_covered: null,
  author: 'item',
  deepen_node: 'item',
  raise_gap: null,
  add_item: 'title',
  update_item: 'item',
  remove_item: 'item',
  log_bug: 'title',
  validate_plan: null,
  settle_conversation: 'parent',
  ask_user: null,
  clear_plan: null,
  search_planning_rules: 'query',
  report_findings: null,
  log_planning_mistake: null,
  log_planning_bug: null,
  classify_revision: null,
  return_to_conversation: null,
};

/** The catalogue key and the one value a call's line is formatted with. */
export interface CallLineSpec {
  key: string;
  placeholder: CallPlaceholder | null;
  value: string | null;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Which line a call reads as — TOTAL over any act. A known tool whose template
 * needs an object it does not have, an unknown tool, or a malformed frame reads
 * as its family's generic line, and a missing family as the bare one. The verb
 * never chooses the words (it chooses the glyph), so an unknown verb changes
 * nothing here.
 */
export function callLineSpec(act: CallAct): CallLineSpec {
  if (act.tool !== null && hasOwn(CALL_TOOL_PLACEHOLDER, act.tool)) {
    const placeholder = CALL_TOOL_PLACEHOLDER[act.tool]!;
    const key = `act.call.tool.${act.tool}`;
    if (placeholder === null) return { key, placeholder: null, value: null };
    if (act.object !== null) return { key, placeholder, value: act.object.value };
  }
  return {
    key: act.family !== null ? `act.call.family.${act.family}` : 'act.call.family.none',
    placeholder: null,
    value: null,
  };
}

// ── Truncation ────────────────────────────────────────────────────────────────

/** The visible cap on a call's OBJECT, in columns (a CJK character is two). */
export const CALL_OBJECT_CAP = 32;

const ELLIPSIS = '…';

/** A key the design never shortens. */
const ITEM_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** East Asian wide and fullwidth ranges — the characters a monospace grid draws
 *  two columns wide. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function width(ch: string): number {
  return isWide(ch.codePointAt(0)!) ? 2 : 1;
}

/** How many columns `text` takes. */
export function columns(text: string): number {
  let total = 0;
  for (const ch of text) total += width(ch);
  return total;
}

/** The start of `text`, then `…`, within `cap` columns. */
function keepStart(text: string, cap: number): string {
  let out = '';
  let used = columns(ELLIPSIS);
  for (const ch of text) {
    if (used + width(ch) > cap) break;
    out += ch;
    used += width(ch);
  }
  return `${out}${ELLIPSIS}`;
}

/** `…`, then the end of `text`, within `cap` columns. */
function keepEnd(text: string, cap: number): string {
  const chars = Array.from(text);
  let out = '';
  let used = columns(ELLIPSIS);
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i]!;
    if (used + width(ch) > cap) break;
    out = ch + out;
    used += width(ch);
  }
  return `${ELLIPSIS}${out}`;
}

function shortenPath(value: string, cap: number): string {
  const segments = value.split('/');
  const file = segments[segments.length - 1] ?? value;
  if (segments.length >= 3) {
    const middle = `${segments[0]}/${ELLIPSIS}/${file}`;
    if (columns(middle) <= cap) return middle;
  }
  const tail = `${ELLIPSIS}/${file}`;
  if (segments.length >= 2 && columns(tail) <= cap) return tail;
  return keepEnd(file, cap);
}

/**
 * A call's object as the line shows it, per the design's rule for its kind:
 * a path keeps its first segment and file name, a query and a title keep their
 * start, a code-graph name keeps its end (the member name is the end), and a key
 * is never shortened.
 */
export function shortenCallObject(
  placeholder: CallPlaceholder,
  value: string,
  cap: number = CALL_OBJECT_CAP,
): { text: string; shortened: boolean } {
  if (columns(value) <= cap) return { text: value, shortened: false };
  if ((placeholder === 'item' || placeholder === 'parent') && ITEM_KEY.test(value)) {
    return { text: value, shortened: false };
  }
  const text =
    placeholder === 'path'
      ? shortenPath(value, cap)
      : placeholder === 'symbol'
        ? keepEnd(value, cap)
        : keepStart(value, cap);
  return { text, shortened: true };
}

/** Is the object drawn in mono? A path, a code-graph name and a key are; a
 *  query and a title read as prose. */
export function isMonoObject(placeholder: CallPlaceholder, value: string): boolean {
  if (placeholder === 'path' || placeholder === 'symbol') return true;
  return (placeholder === 'item' || placeholder === 'parent') && ITEM_KEY.test(value);
}

/** The accessible name's catalogue key for a shortened object. */
export function fullValueKey(placeholder: CallPlaceholder): string {
  if (placeholder === 'path') return 'act.call.full.path';
  if (placeholder === 'query') return 'act.call.full.query';
  if (placeholder === 'symbol') return 'act.call.full.symbol';
  return 'act.call.full.title';
}

// ── Grouping (derived at render time) ──────────────────────────────────────────

/** The act rows a call can nest under. The others (`submitted`, `retrieval`,
 *  `note`, `proposed`, `unknown`, and the debug turn's two) never take calls. */
const STEP_KINDS: ReadonlySet<PlanChangeProgress['kind']> = new Set([
  'reading',
  'redirected',
  'searching',
  'drilling',
  'laying',
  'authoring',
  'validating',
]);

export function isStep(act: PlanChangeProgress): boolean {
  return STEP_KINDS.has(act.kind);
}

/** One row of the record as the rail draws it: an act row (with the calls that
 *  nest under it when it is a step), or a call with no step before it. */
export type RecordEntry =
  | { type: 'act'; index: number; calls: number[] }
  | { type: 'call'; index: number };

function sameRef(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Nest each call under its step, in arrival order:
 *
 *  1. a call with an `itemRef` joins the most recent `authoring` step before it
 *     whose title equals that ref (the author session's own ref);
 *  2. any other call joins the most recent step row before it;
 *  3. a call with no step before it is its own top-level row — never dropped.
 *
 * Every call act lands in exactly one place, so the number of call lines the
 * rail can show equals the number of `call` acts.
 */
export function groupActs(acts: readonly PlanChangeProgress[]): RecordEntry[] {
  const entries: RecordEntry[] = [];
  const steps: Extract<RecordEntry, { type: 'act' }>[] = [];
  acts.forEach((act, index) => {
    if (act.kind !== 'call') {
      const entry = { type: 'act' as const, index, calls: [] as number[] };
      entries.push(entry);
      if (isStep(act)) steps.push(entry);
      return;
    }
    let home: Extract<RecordEntry, { type: 'act' }> | undefined;
    if (act.itemRef !== null) {
      for (let i = steps.length - 1; i >= 0; i -= 1) {
        const step = acts[steps[i]!.index]!;
        if (step.kind === 'authoring' && step.title !== null && sameRef(step.title, act.itemRef)) {
          home = steps[i];
          break;
        }
      }
    }
    home ??= steps[steps.length - 1];
    if (home) home.calls.push(index);
    else entries.push({ type: 'call', index });
  });
  return entries;
}

/**
 * The OPEN steps (by act index) while the run streams: the most recent step,
 * and — when it is `authoring` — every `authoring` step back to the previous
 * step of another kind (the parallel level). Every other step is finished and
 * folds; once the run ends, every step folds.
 */
export function openSteps(
  acts: readonly PlanChangeProgress[],
  entries: readonly RecordEntry[],
  streaming: boolean,
): Set<number> {
  const open = new Set<number>();
  if (!streaming) return open;
  const steps = entries.filter(
    (e): e is Extract<RecordEntry, { type: 'act' }> => e.type === 'act' && isStep(acts[e.index]!),
  );
  const last = steps[steps.length - 1];
  if (!last) return open;
  open.add(last.index);
  if (acts[last.index]!.kind !== 'authoring') return open;
  for (let i = steps.length - 2; i >= 0; i -= 1) {
    if (acts[steps[i]!.index]!.kind !== 'authoring') break;
    open.add(steps[i]!.index);
  }
  return open;
}

/** How many of these calls failed or were refused — the count a folded step's
 *  disclosure must carry, because folding never hides a failure. */
export function failedCount(acts: readonly PlanChangeProgress[], calls: readonly number[]): number {
  return calls.filter((i) => {
    const act = acts[i]!;
    return act.kind === 'call' && (act.outcome === 'failed' || act.outcome === 'refused');
  }).length;
}

/** The newest calls an open step shows; the rest sit behind its earlier-calls row. */
export const OPEN_STEP_WINDOW = 2;

// ── The running bar ───────────────────────────────────────────────────────────

/**
 * What the pinned running bar repeats:
 *
 *  - the newest act, when it is not a step or a call (a note, a proposal, an
 *    older producer's lookup row) — the shipped behaviour;
 *  - with two or more open `authoring` steps, the most recently started call
 *    among them, with its step (the bar reads `{line} · {title}`);
 *  - with one open step, its newest call, or the step's own line before it has
 *    one;
 *  - otherwise the newest act.
 */
export type BarTarget =
  | { type: 'act'; index: number }
  | { type: 'call'; index: number; step: number | null };

export function barTarget(
  acts: readonly PlanChangeProgress[],
  entries: readonly RecordEntry[],
  open: ReadonlySet<number>,
): BarTarget | null {
  if (acts.length === 0) return null;
  const lastIndex = acts.length - 1;
  const last = acts[lastIndex]!;
  if (last.kind !== 'call' && !isStep(last)) return { type: 'act', index: lastIndex };
  const openEntries = entries.filter(
    (e): e is Extract<RecordEntry, { type: 'act' }> => e.type === 'act' && open.has(e.index),
  );
  const authoring = openEntries.filter((e) => acts[e.index]!.kind === 'authoring');
  if (authoring.length >= 2) {
    let newest: { call: number; step: number } | null = null;
    for (const entry of authoring) {
      const call = entry.calls[entry.calls.length - 1];
      if (call !== undefined && (newest === null || call > newest.call)) {
        newest = { call, step: entry.index };
      }
    }
    if (newest) return { type: 'call', index: newest.call, step: newest.step };
    return { type: 'act', index: lastIndex };
  }
  const step = openEntries[openEntries.length - 1];
  if (step) {
    const call = step.calls[step.calls.length - 1];
    return call !== undefined
      ? { type: 'call', index: call, step: null }
      : { type: 'act', index: step.index };
  }
  return last.kind === 'call'
    ? { type: 'call', index: lastIndex, step: null }
    : { type: 'act', index: lastIndex };
}

// ── The announcer ─────────────────────────────────────────────────────────────

/** What the one polite live region says: an act row, or a call's mark. */
export interface Announcement {
  index: number;
  mark: 'failed' | 'refused' | null;
}

/** The newest act that is not a call — what the region holds on mount. */
export function latestRowAnnouncement(acts: readonly PlanChangeProgress[]): Announcement | null {
  for (let i = acts.length - 1; i >= 0; i -= 1) {
    if (acts[i]!.kind !== 'call') return { index: i, mark: null };
  }
  return null;
}

/**
 * The announcement a change of record makes, or null to keep the current one.
 * A row appended (every act that is not a call) replaces it, and so does a call
 * newly marked failed or refused. Calls themselves are never announced: one per
 * call would have a screen reader read the log aloud. A record that is not a
 * continuation of the previous one (a new run) is announced afresh.
 */
export function nextAnnouncement(
  prev: readonly PlanChangeProgress[],
  next: readonly PlanChangeProgress[],
): Announcement | null {
  const continues =
    prev.length <= next.length && prev.every((act, i) => act.kind === next[i]!.kind);
  if (!continues) return latestRowAnnouncement(next);
  for (let i = next.length - 1; i >= prev.length; i -= 1) {
    if (next[i]!.kind !== 'call') return { index: i, mark: null };
  }
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const before = prev[i]!;
    const after = next[i]!;
    if (before.kind !== 'call' || after.kind !== 'call' || before.outcome !== 'running') continue;
    if (after.outcome === 'failed' || after.outcome === 'refused') {
      return { index: i, mark: after.outcome };
    }
  }
  return null;
}
