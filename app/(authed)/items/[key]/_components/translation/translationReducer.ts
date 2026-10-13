import type { TranslationOfferDTO } from '@/lib/dto/workItemTranslation';

// THE TRANSLATION STATE MACHINE of one item view (Story MOTIR-7735 · Subtask
// MOTIR-8122; design MOTIR-8112 § *States*). Pure — no React, no fetch — so the
// transitions are tested without a renderer.
//
// One entry per field the offer says NEEDS translating; every other field is
// absent and therefore never marked, never swapped. The view mode is held here
// and nowhere else: nothing is stored, so a reload opens on the original (D2).

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
}

export type TranslationView = 'original' | 'translated';

export interface TranslationState {
  fields: Record<string, FieldEntry>;
  view: TranslationView;
  /** A request is in flight. */
  busy: boolean;
}

/** Whatever the server sent for one field, before it is trusted. */
export interface RawFieldResult {
  fieldRef?: unknown;
  status?: unknown;
  text?: unknown;
}

export type TranslationAction =
  | { type: 'start'; only?: readonly string[] }
  | { type: 'apply'; results: readonly RawFieldResult[] }
  | { type: 'requestFailed' }
  | { type: 'setView'; view: TranslationView };

/** The state an offer opens on: every differing field idle, the original shown. */
export function initialTranslationState(offer: TranslationOfferDTO): TranslationState {
  const fields: Record<string, FieldEntry> = {};
  for (const [ref, f] of Object.entries(offer.fields)) {
    if (f.needsTranslation) fields[ref] = { state: 'idle', text: null };
  }
  return { fields, view: 'translated', busy: false };
}

/** A press: the named fields (default: every field not already translated) go pending. */
function start(state: TranslationState, only?: readonly string[]): TranslationState {
  const fields = { ...state.fields };
  for (const [ref, entry] of Object.entries(fields)) {
    const wanted = only ? only.includes(ref) : entry.state !== 'ready';
    if (wanted) fields[ref] = { ...entry, state: 'pending' };
  }
  return { ...state, fields, busy: true };
}

const FAILURE_STATES = new Set(['failed', 'no_credit', 'timeout']);

/** One server result → the field's next entry. An unknown status is `failed`. */
function nextEntry(entry: FieldEntry, raw: RawFieldResult): FieldEntry {
  if (raw.status === 'ready' && typeof raw.text === 'string' && raw.text.trim() !== '') {
    return { state: 'ready', text: raw.text };
  }
  // A field that already succeeded STAYS translated when a later answer for it
  // is a failure (a retry of another field cannot take a translation away).
  if (entry.state === 'ready') return entry;
  const status =
    typeof raw.status === 'string' && FAILURE_STATES.has(raw.status) ? raw.status : 'failed';
  return { ...entry, state: status as FieldTranslationState };
}

/** Apply a response. A pending field the response does not name returns to idle. */
function apply(state: TranslationState, results: readonly RawFieldResult[]): TranslationState {
  const fields = { ...state.fields };
  const answered = new Set<string>();
  for (const raw of results) {
    if (typeof raw.fieldRef !== 'string' || !(raw.fieldRef in fields)) continue;
    answered.add(raw.fieldRef);
    fields[raw.fieldRef] = nextEntry(fields[raw.fieldRef]!, raw);
  }
  for (const [ref, entry] of Object.entries(fields)) {
    if (entry.state === 'pending' && !answered.has(ref)) fields[ref] = { ...entry, state: 'idle' };
  }
  return { ...state, fields, busy: false, view: 'translated' };
}

/** The request itself failed (network, a non-200): every pending field failed. */
function requestFailed(state: TranslationState): TranslationState {
  const fields = { ...state.fields };
  for (const [ref, entry] of Object.entries(fields)) {
    if (entry.state === 'pending') fields[ref] = { ...entry, state: 'failed' };
  }
  return { ...state, fields, busy: false };
}

export function translationReducer(
  state: TranslationState,
  action: TranslationAction,
): TranslationState {
  switch (action.type) {
    case 'start':
      return start(state, action.only);
    case 'apply':
      return apply(state, action.results);
    case 'requestFailed':
      return requestFailed(state);
    case 'setView':
      return { ...state, view: action.view };
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
