// The pre-plan discovery loop — the pure state machine behind the authed
// onboarding chat (Subtask 7.3.5 / MOTIR-833). This is the FORWARD gated review
// loop: the conductor (motir-ai, 7.3.67 / MOTIR-1099) drafts a tier → the user
// reviews it READ-ONLY → presses Continue → the conductor narrates the handoff →
// the next tier drafts. Conversation is the only input; nothing is locked until
// epic generation.
//
// Kept PURE (no React, no fetch, no DOM) so the whole loop is unit-testable: the
// `useDiscoveryChat` hook owns the I/O (POST /api/ai/chat, the SSE stream, the
// /api/ai/pre-plan body read) and feeds frames + fetched docs in here as actions.
//
// The SSE frames mirror what the motir-ai `discovery` job emits
// (`src/jobs/handlers/discovery.ts`) and `/api/ai/chat/[jobId]/stream` relays
// VERBATIM. motir-core does not own those shapes — so we type only the fields the
// UI consumes and tolerate extras. The revise/diff/cascade-back half (the
// `revisions` cascade routing, per-doc diffs, the forward revision log) is
// explicitly OUT of this card → Subtask 7.3.71 / MOTIR-1179; here a `revisions`
// frame only marks the affected tiers stale so their read-only body re-fetches.

import { type DirectionDocKind, type DirectionDocView, DIRECTION_DOC_ORDER } from './directionDoc';

// ── The conductor SSE frames (relayed verbatim from motir-ai) ────────────────

/** The session fields a `state` frame can carry (motir-ai sends a subset each turn). */
export interface DiscoveryStatePatch {
  classification?: string | null;
  platform?: string | null;
  validationTiming?: string | null;
  currentGate?: string | null;
  status?: string;
}

/** One produced/saved tier doc, as announced by a `docs` frame (no body — that
 *  arrives separately from the /api/ai/pre-plan read). */
export interface DiscoveryDocRef {
  id: string;
  kind: DirectionDocKind;
  version: number;
}

export type DiscoveryFrame =
  | { event: 'assistant'; data: { text: string } }
  | { event: 'status'; data: { phase: 'grounding' | 'drafting'; tier: DirectionDocKind | null } }
  | { event: 'state'; data: DiscoveryStatePatch }
  | { event: 'docs'; data: { docs: DiscoveryDocRef[] } }
  | { event: 'validate_early_ask'; data: { recommendation: string; defaultTiming: string } }
  | { event: 'revisions'; data: { revisions: { tier: DirectionDocKind; reason: string }[] } }
  | { event: 'error'; data: { code: string; message: string | null } };

const TIER_SET = new Set<string>(DIRECTION_DOC_ORDER);

function asTier(value: unknown): DirectionDocKind | null {
  return typeof value === 'string' && TIER_SET.has(value) ? (value as DirectionDocKind) : null;
}

/**
 * Narrow a raw `{ event, data }` SSE frame (parsed JSON, `data` is `unknown`)
 * into a typed `DiscoveryFrame`, or `null` for an event the loop ignores
 * (`status: grounding` with no tier still maps; an unknown event drops). Kept
 * defensive: motir-ai owns the wire shape, so a malformed/partial frame must
 * never throw — it is simply skipped.
 */
export function normalizeFrame(event: string, data: unknown): DiscoveryFrame | null {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case 'assistant': {
      const text = typeof d.text === 'string' ? d.text : '';
      return text ? { event: 'assistant', data: { text } } : null;
    }
    case 'status': {
      const phase =
        d.phase === 'drafting' ? 'drafting' : d.phase === 'grounding' ? 'grounding' : null;
      if (!phase) return null;
      return { event: 'status', data: { phase, tier: asTier(d.tier) } };
    }
    case 'state':
      return {
        event: 'state',
        data: {
          ...(typeof d.classification === 'string' || d.classification === null
            ? { classification: d.classification as string | null }
            : {}),
          ...(typeof d.platform === 'string' || d.platform === null
            ? { platform: d.platform as string | null }
            : {}),
          ...(typeof d.validationTiming === 'string' || d.validationTiming === null
            ? { validationTiming: d.validationTiming as string | null }
            : {}),
          ...(typeof d.currentGate === 'string' || d.currentGate === null
            ? { currentGate: d.currentGate as string | null }
            : {}),
          ...(typeof d.status === 'string' ? { status: d.status } : {}),
        },
      };
    case 'docs': {
      const raw = Array.isArray(d.docs) ? d.docs : [];
      const docs = raw
        .map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          const kind = asTier(o.kind);
          if (!kind) return null;
          return {
            id: typeof o.id === 'string' ? o.id : '',
            kind,
            version: typeof o.version === 'number' ? o.version : 0,
          };
        })
        .filter((x): x is DiscoveryDocRef => x !== null);
      return docs.length ? { event: 'docs', data: { docs } } : null;
    }
    case 'validate_early_ask':
      return {
        event: 'validate_early_ask',
        data: {
          recommendation: typeof d.recommendation === 'string' ? d.recommendation : '',
          defaultTiming: typeof d.defaultTiming === 'string' ? d.defaultTiming : 'standard',
        },
      };
    case 'revisions': {
      const raw = Array.isArray(d.revisions) ? d.revisions : [];
      const revisions = raw
        .map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          const tier = asTier(o.tier);
          return tier ? { tier, reason: typeof o.reason === 'string' ? o.reason : '' } : null;
        })
        .filter((x): x is { tier: DirectionDocKind; reason: string } => x !== null);
      return revisions.length ? { event: 'revisions', data: { revisions } } : null;
    }
    case 'error':
      return {
        event: 'error',
        data: {
          code: typeof d.code === 'string' ? d.code : 'MOTIR_AI_UNAVAILABLE',
          message: typeof d.message === 'string' ? d.message : null,
        },
      };
    default:
      return null;
  }
}

// ── Loop state ───────────────────────────────────────────────────────────────

export interface ChatTurn {
  id: string;
  role: 'assistant' | 'user';
  text: string;
}

/** The conductor is mid-turn — either grounding/thinking or drafting a tier. */
export interface WorkingState {
  phase: 'grounding' | 'drafting';
  tier: DirectionDocKind | null;
}

export interface DiscoverySession {
  classification: string | null;
  platform: string | null;
  validationTiming: string | null;
  currentGate: string | null;
  status: string;
}

/** The blocking validate-demand-first ask (the one place the loop waits on a
 *  genuine strategic call — MOTIR-1064). `recommendation` is the streamed
 *  rationale (empty on resume, where only the gate is known). */
export interface ValidateEarlyAsk {
  recommendation: string;
}

// 'design' is the web-only full-page design step (Subtask 7.3.27 / MOTIR-1040) —
// reached from the hub, styling its WHOLE self via the shipped three-axis runtime.
export type DiscoveryView = 'hub' | 'review' | 'design';

export interface DiscoveryState {
  turns: ChatTurn[];
  /** A user turn is in flight (POST sent, stream open) — disables the composer. */
  isStreaming: boolean;
  working: WorkingState | null;
  session: DiscoverySession;
  /** Tiers that have a saved doc, in journey order. */
  producedKinds: DirectionDocKind[];
  /** The read-only bodies, by kind (fetched from /api/ai/pre-plan). */
  docs: Record<string, DirectionDocView>;
  /** The tier currently up for review (drives the full-screen gate). */
  activeKind: DirectionDocKind | null;
  view: DiscoveryView;
  pendingAsk: ValidateEarlyAsk | null;
  /** Kinds whose body needs a (re)fetch — set by `docs` / `revisions` frames. */
  staleKinds: DirectionDocKind[];
  error: { code: string; message: string | null } | null;
  /** Monotonic id source for chat turns (keeps the reducer deterministic). */
  seq: number;
}

const EMPTY_SESSION: DiscoverySession = {
  classification: null,
  platform: null,
  validationTiming: null,
  currentGate: null,
  status: 'active',
};

export function initialDiscoveryState(): DiscoveryState {
  return {
    turns: [],
    isStreaming: false,
    working: null,
    session: { ...EMPTY_SESSION },
    producedKinds: [],
    docs: {},
    activeKind: null,
    view: 'hub',
    pendingAsk: null,
    staleKinds: [],
    error: null,
    seq: 0,
  };
}

/** The persisted session a resume hydrates from (the /api/ai/pre-plan DTO subset). */
export interface HydrateSession {
  classification: string | null;
  platform: string | null;
  validationTiming: string | null;
  currentGate: string | null;
  status: string;
}

export type DiscoveryAction =
  | { type: 'reset' }
  | { type: 'hydrate'; session: HydrateSession | null; docs: DirectionDocView[] }
  | { type: 'userTurn'; text: string }
  | { type: 'frame'; frame: DiscoveryFrame }
  | { type: 'docsLoaded'; docs: DirectionDocView[] }
  | { type: 'streamEnd' }
  | { type: 'streamError'; code: string; message?: string }
  | { type: 'openReview'; kind: DirectionDocKind }
  | { type: 'openDesign' }
  | { type: 'backToHub' }
  | { type: 'dismissError' };

function withProduced(order: DirectionDocKind[], kind: DirectionDocKind): DirectionDocKind[] {
  if (order.includes(kind)) return order;
  // Keep journey order regardless of arrival order.
  return DIRECTION_DOC_ORDER.filter((k) => k === kind || order.includes(k));
}

function addStale(stale: DirectionDocKind[], kinds: DirectionDocKind[]): DirectionDocKind[] {
  const next = new Set(stale);
  for (const k of kinds) next.add(k);
  return DIRECTION_DOC_ORDER.filter((k) => next.has(k));
}

/** Resume to the tier the persisted `currentGate` points at — the validate-early
 *  gate parks on the validation doc; a terminal `tiers_complete` returns to the
 *  hub. */
function gateToActive(
  currentGate: string | null,
  produced: DirectionDocKind[],
): DirectionDocKind | null {
  if (currentGate === 'validate_early')
    return produced.includes('validation') ? 'validation' : null;
  const tier = asTier(currentGate);
  return tier && produced.includes(tier) ? tier : null;
}

export function reduceDiscovery(state: DiscoveryState, action: DiscoveryAction): DiscoveryState {
  switch (action.type) {
    case 'reset':
      return initialDiscoveryState();

    case 'hydrate': {
      const docs: Record<string, DirectionDocView> = {};
      for (const d of action.docs) docs[d.kind] = d;
      const produced = DIRECTION_DOC_ORDER.filter((k) => k in docs);
      const session: DiscoverySession = action.session
        ? {
            classification: action.session.classification,
            platform: action.session.platform,
            validationTiming: action.session.validationTiming,
            currentGate: action.session.currentGate,
            status: action.session.status,
          }
        : { ...EMPTY_SESSION };
      const active = gateToActive(session.currentGate, produced);
      const atValidateEarly =
        session.currentGate === 'validate_early' && session.status !== 'tiers_complete';
      return {
        ...initialDiscoveryState(),
        session,
        docs,
        producedKinds: produced,
        activeKind: active ?? (produced.length ? produced[produced.length - 1]! : null),
        // Resume INTO the review gate when the session parks at a tier; otherwise
        // the hub (a fresh or completed session).
        view: active ? 'review' : 'hub',
        pendingAsk: atValidateEarly ? { recommendation: '' } : null,
      };
    }

    case 'userTurn':
      return {
        ...state,
        turns: [...state.turns, { id: `t${state.seq}`, role: 'user', text: action.text }],
        seq: state.seq + 1,
        isStreaming: true,
        error: null,
      };

    case 'frame':
      return reduceFrame(state, action.frame);

    case 'docsLoaded': {
      const docs = { ...state.docs };
      for (const d of action.docs) docs[d.kind] = d;
      const loaded = new Set(action.docs.map((d) => d.kind));
      return {
        ...state,
        docs,
        staleKinds: state.staleKinds.filter((k) => !loaded.has(k)),
      };
    }

    case 'streamEnd':
      return { ...state, isStreaming: false, working: null };

    case 'streamError':
      return {
        ...state,
        isStreaming: false,
        working: null,
        error: { code: action.code, message: action.message ?? null },
      };

    case 'openReview':
      if (!(action.kind in state.docs)) return state;
      return { ...state, activeKind: action.kind, view: 'review' };

    case 'openDesign':
      return { ...state, view: 'design' };

    case 'backToHub':
      return { ...state, view: 'hub' };

    case 'dismissError':
      return { ...state, error: null };

    default:
      return state;
  }
}

function reduceFrame(state: DiscoveryState, frame: DiscoveryFrame): DiscoveryState {
  switch (frame.event) {
    case 'assistant':
      return {
        ...state,
        turns: [...state.turns, { id: `t${state.seq}`, role: 'assistant', text: frame.data.text }],
        seq: state.seq + 1,
        working: null,
      };

    case 'status':
      return { ...state, working: { phase: frame.data.phase, tier: frame.data.tier } };

    case 'state': {
      const p = frame.data;
      const session: DiscoverySession = {
        classification:
          p.classification !== undefined ? p.classification : state.session.classification,
        platform: p.platform !== undefined ? p.platform : state.session.platform,
        validationTiming:
          p.validationTiming !== undefined ? p.validationTiming : state.session.validationTiming,
        currentGate: p.currentGate !== undefined ? p.currentGate : state.session.currentGate,
        status: p.status !== undefined ? p.status : state.session.status,
      };
      // A terminal completion clears any parked ask.
      const pendingAsk = session.status === 'tiers_complete' ? null : state.pendingAsk;
      return { ...state, session, pendingAsk };
    }

    case 'docs': {
      let produced = state.producedKinds;
      for (const ref of frame.data.docs) produced = withProduced(produced, ref.kind);
      return {
        ...state,
        producedKinds: produced,
        staleKinds: addStale(
          state.staleKinds,
          frame.data.docs.map((d) => d.kind),
        ),
        working: null,
      };
    }

    case 'validate_early_ask':
      return { ...state, pendingAsk: { recommendation: frame.data.recommendation }, working: null };

    case 'revisions':
      // Forward-only here: a coordinated revision marks the affected tiers' bodies
      // stale so the read re-fetches them; the cascade-BACK routing + per-doc diffs
      // are Subtask 7.3.71 / MOTIR-1179, deliberately not built in this card.
      return {
        ...state,
        staleKinds: addStale(
          state.staleKinds,
          frame.data.revisions.map((r) => r.tier),
        ),
        working: null,
      };

    case 'error':
      return {
        ...state,
        isStreaming: false,
        working: null,
        error: { code: frame.data.code, message: frame.data.message },
      };

    default:
      return state;
  }
}

// ── Selectors the view layer reads ───────────────────────────────────────────

/** All tiers complete + nothing parked — the loop has reached the plan handoff
 *  (the "Go to plan phase" exit is Subtask 7.3.28 / MOTIR-1041, not this card). */
export function isTiersComplete(state: DiscoveryState): boolean {
  return state.session.status === 'tiers_complete';
}

/** The doc currently under review, if any. */
export function activeDoc(state: DiscoveryState): DirectionDocView | null {
  return state.activeKind ? (state.docs[state.activeKind] ?? null) : null;
}
