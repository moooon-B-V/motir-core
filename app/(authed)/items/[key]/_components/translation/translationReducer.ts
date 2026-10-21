import type { TranslationOfferDTO } from '@/lib/dto/workItemTranslation';

// THE TRANSLATION STATE MACHINE of one item view (Story MOTIR-7735 · Subtask
// MOTIR-8122; design MOTIR-8112 § *States*). Pure — no React, no fetch — so the
// transitions are tested without a renderer.
//
// One entry per field the offer says NEEDS translating; every other field is
// absent and therefore never marked, never swapped. The view mode is held here
// and nowhere else: nothing is stored, so a reload opens on the original (D2).
//
// THE STALE STATE (MOTIR-8123). Each entry carries the offer REVISION it
// describes — `hashFieldText` of the field's text, the store's own key. A new
// offer (`applyOffer`) whose revision for a field differs means the field was
// edited: its held translation is dropped AT ONCE, so an old translation is
// never shown for new text, and in the translated view the field is queued for
// ONE quiet re-request. A response is applied to a field only while the field
// is still at the revision the request was sent for, so a late answer for an
// older text is discarded.

/** One field's state. `idle` is "offered, not pressed yet". */
export type FieldTranslationState =
  | 'idle'
  | 'pending'
  | 'ready'
  | 'failed'
  | 'no_credit'
  | 'timeout';

export interface FieldEntry {
  state: FieldTranslationState;
  /** The translation, once one has arrived. Kept across a later failure. */
  text: string | null;
  /** The offer revision of the text this entry describes (MOTIR-8123). */
  revision: string;
  /** Re-translating because an edit reached the open translated view. */
  edited: boolean;
}

export type TranslationView = 'original' | 'translated';

export interface TranslationState {
  fields: Record<string, FieldEntry>;
  view: TranslationView;
  /** A PRESS is in flight (a quiet re-request after an edit is not a press). */
  busy: boolean;
  /** The reader has pressed Translate in this page load. */
  pressed: boolean;
  /** Fields an edit made stale in the translated view, waiting to be re-requested. */
  queue: string[];
}

/** Whatever the server sent for one field, before it is trusted. */
export interface RawFieldResult {
  fieldRef?: unknown;
  status?: unknown;
  text?: unknown;
}

/** The revision each field was at when a request for it was sent. */
export type SentRevisions = Readonly<Record<string, string>>;

export type TranslationAction =
  | { type: 'start'; sent: SentRevisions; quiet?: boolean }
  | { type: 'apply'; results: readonly RawFieldResult[]; sent: SentRevisions; quiet?: boolean }
  | { type: 'requestFailed'; sent: SentRevisions; quiet?: boolean }
  | { type: 'setView'; view: TranslationView }
  | { type: 'offer'; offer: TranslationOfferDTO }
  | { type: 'dequeue'; refs: readonly string[] };

/**
 * How a host that AUTO-translates (Story MOTIR-7738 · MOTIR-8832; design
 * MOTIR-8823 A1/A4) opens. `start`: the press, entered at mount — every
 * differing field pending and the bar busy, so no first frame can wear the
 * offered face. `no_credit`: the organisation cannot pay, so the state opens in
 * the no-credit phase and NO request is made. Absent: the on-demand host.
 */
export type AutoEntry = 'start' | 'no_credit';

/**
 * The state an offer opens on. On demand: every differing field idle, the
 * original shown until a press. Auto: see {@link AutoEntry}; the view is the
 * translated one, `pressed` is set (the staleness queue is live from mount) and
 * no transition below changes.
 */
export function initialTranslationState(
  offer: TranslationOfferDTO,
  auto?: AutoEntry | null,
): TranslationState {
  const fields: Record<string, FieldEntry> = {};
  for (const [ref, f] of Object.entries(offer.fields)) {
    if (!f.needsTranslation) continue;
    fields[ref] =
      auto === 'start'
        ? { state: 'pending', text: null, revision: f.revision, edited: false }
        : auto === 'no_credit'
          ? { state: 'no_credit', text: null, revision: f.revision, edited: false }
          : idleEntry(f.revision);
  }
  const starting = auto === 'start';
  return { fields, view: 'translated', busy: starting, pressed: starting, queue: [] };
}

function idleEntry(revision: string): FieldEntry {
  return { state: 'idle', text: null, revision, edited: false };
}

/**
 * The fields a request is for, at their current revisions: the named ones, or
 * (a press) every field not already translated. The caller sends this with the
 * request and hands it back with the answer.
 */
export function revisionsToSend(
  state: TranslationState,
  only?: readonly string[],
): Record<string, string> {
  const sent: Record<string, string> = {};
  for (const [ref, entry] of Object.entries(state.fields)) {
    if (only ? only.includes(ref) : entry.state !== 'ready') sent[ref] = entry.revision;
  }
  return sent;
}

/** Whether `ref` is still at the revision a request for it was sent with. */
function current(state: TranslationState, sent: SentRevisions, ref: string): boolean {
  return ref in sent && state.fields[ref]?.revision === sent[ref];
}

/** A request goes out: its fields go pending. A press also marks the bar busy. */
function start(state: TranslationState, sent: SentRevisions, quiet?: boolean): TranslationState {
  const fields = { ...state.fields };
  for (const ref of Object.keys(sent)) {
    if (current(state, sent, ref)) fields[ref] = { ...fields[ref]!, state: 'pending' };
  }
  return quiet ? { ...state, fields } : { ...state, fields, busy: true, pressed: true };
}

const FAILURE_STATES = new Set(['failed', 'no_credit', 'timeout']);

/** One server result → the field's next entry. An unknown status is `failed`. */
function nextEntry(entry: FieldEntry, raw: RawFieldResult): FieldEntry {
  if (raw.status === 'ready' && typeof raw.text === 'string' && raw.text.trim() !== '') {
    return { ...entry, state: 'ready', text: raw.text, edited: false };
  }
  // A field that already succeeded STAYS translated when a later answer for it
  // is a failure (a retry of another field cannot take a translation away).
  if (entry.state === 'ready') return entry;
  const status =
    typeof raw.status === 'string' && FAILURE_STATES.has(raw.status) ? raw.status : 'failed';
  return { ...entry, state: status as FieldTranslationState };
}

/**
 * Apply a response to the fields it was SENT for and that are still at that
 * revision; anything else it names is ignored. A sent field it does not name
 * returns to idle.
 */
function apply(
  state: TranslationState,
  results: readonly RawFieldResult[],
  sent: SentRevisions,
  quiet?: boolean,
): TranslationState {
  const fields = { ...state.fields };
  const answered = new Set<string>();
  for (const raw of results) {
    if (typeof raw.fieldRef !== 'string' || !current(state, sent, raw.fieldRef)) continue;
    answered.add(raw.fieldRef);
    fields[raw.fieldRef] = nextEntry(fields[raw.fieldRef]!, raw);
  }
  for (const ref of Object.keys(sent)) {
    const entry = fields[ref];
    if (current(state, sent, ref) && entry!.state === 'pending' && !answered.has(ref)) {
      fields[ref] = { ...entry!, state: 'idle', edited: false };
    }
  }
  return quiet ? { ...state, fields } : { ...state, fields, busy: false, view: 'translated' };
}

/** The request itself failed (network, a non-200): every field it was for failed. */
function requestFailed(
  state: TranslationState,
  sent: SentRevisions,
  quiet?: boolean,
): TranslationState {
  const fields = { ...state.fields };
  for (const ref of Object.keys(sent)) {
    if (current(state, sent, ref) && fields[ref]!.state === 'pending') {
      fields[ref] = { ...fields[ref]!, state: 'failed', edited: false };
    }
  }
  return quiet ? { ...state, fields } : { ...state, fields, busy: false };
}

/**
 * A new offer reached the view (MOTIR-8123). A field at an unchanged revision
 * keeps its entry untouched. A field whose revision changed — or a new field —
 * drops any translation: in the translated view it goes pending and is queued
 * for one re-request; otherwise it is idle until the next press. A field that no
 * longer needs translating, or no longer exists, leaves the state.
 */
export function applyOffer(state: TranslationState, offer: TranslationOfferDTO): TranslationState {
  const live = state.pressed && state.view === 'translated';
  const fields: Record<string, FieldEntry> = {};
  const queue = [...state.queue];
  let changed = false;
  for (const [ref, f] of Object.entries(offer.fields)) {
    if (!f.needsTranslation) continue;
    const prev = state.fields[ref];
    if (prev && prev.revision === f.revision) {
      fields[ref] = prev;
      continue;
    }
    changed = true;
    if (!live) {
      fields[ref] = idleEntry(f.revision);
      continue;
    }
    fields[ref] = { state: 'pending', text: null, revision: f.revision, edited: !!prev };
    if (!queue.includes(ref)) queue.push(ref);
  }
  const removed = Object.keys(state.fields).some((ref) => !(ref in fields));
  if (!changed && !removed) return state;
  return { ...state, fields, queue: queue.filter((ref) => ref in fields) };
}

export function translationReducer(
  state: TranslationState,
  action: TranslationAction,
): TranslationState {
  switch (action.type) {
    case 'start':
      return start(state, action.sent, action.quiet);
    case 'apply':
      return apply(state, action.results, action.sent, action.quiet);
    case 'requestFailed':
      return requestFailed(state, action.sent, action.quiet);
    case 'setView':
      return { ...state, view: action.view };
    case 'offer':
      return applyOffer(state, action.offer);
    case 'dequeue':
      return { ...state, queue: state.queue.filter((ref) => !action.refs.includes(ref)) };
  }
}

// ── What the bar shows (design § States — item scope) ──────────────────────────

export type BarPhase =
  | { kind: 'offered' }
  | { kind: 'busy' }
  | { kind: 'translated'; failedCount: number }
  | { kind: 'failed' }
  | { kind: 'no_credit' };

/**
 * The bar's state from the fields in `scope` (the host's fields: every field on
 * the page, the title and description in the quick view). No credit wins — the
 * button is removed until reload (D6); then busy; then any translation shown.
 */
export function barPhase(state: TranslationState, scope: readonly string[]): BarPhase {
  const entries = scope.map((ref) => state.fields[ref]).filter((e): e is FieldEntry => !!e);
  if (entries.some((e) => e.state === 'no_credit')) return { kind: 'no_credit' };
  if (state.busy) return { kind: 'busy' };
  const failedCount = entries.filter((e) => e.state === 'failed' || e.state === 'timeout').length;
  if (entries.some((e) => e.state === 'ready')) return { kind: 'translated', failedCount };
  return failedCount > 0 ? { kind: 'failed' } : { kind: 'offered' };
}
