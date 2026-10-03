'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { TodoProgressDto, WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import { PlanEditsClientError, streamAskJob } from '@/lib/planning/planEditsClient';
import {
  openGuideConversation,
  resubmitGuideTurn,
  sendGuideTurn,
  settleGuideJob,
  type GuideTurnResponse,
} from '@/lib/planning/guideClient';

// The client state behind the overlay's GUIDE mode (Story MOTIR-7459 ·
// MOTIR-7466). It follows `usePlanChangeConversation`'s APPEND-THEN-RUN shape on
// the guide door, and is much smaller, because a guide turn has one intent, one
// job kind and no plan to review:
//
//   mount   → POST /api/ai/guide { itemKey }            (resume, or start + run)
//   a turn  → POST /api/ai/guide { sessionId, text }    (append + run)
//   running → GET  /api/ai/ask/[jobId]/stream           (the shipped SSE relay)
//   settled → POST /api/ai/guide/settle                 (LAND it — MOTIR-7470)
//   retry   → POST /api/ai/guide { sessionId, turnId }  (re-run the same turn)
//
// ⚠️ THE ROWS ARE READ, NEVER DERIVED FROM THE TURN. A landed turn's writes went
// through the card's own services, so after every settle — and on the overlay's
// live refresh — the card's rows are READ again (`listTodosAction`). The canvas
// then animates what CHANGED between two reads, which is what keeps a refresh
// that changes nothing from replaying a tick.
//
// ⚠️ THE DOOR'S OPENING TURN IS SENT ONCE PER OPEN, NOT PER MOUNT. A dev-mode
// double mount, or a remount the overlay causes, must not start (and bill) two
// conversations. The open is held in a module-level map keyed by card, so the
// second mount joins the first's request instead of making its own.

export type GuidePhase = 'opening' | 'idle' | 'running';

/** A person's own tick or untick on the canvas — recorded in the rail as a
 *  marker line (design panel 13), placed after the turn it followed. */
export interface GuidePersonMarker {
  id: string;
  afterTurnId: string | null;
  done: boolean;
  step: number;
}

export interface GuideConversationState {
  phase: GuidePhase;
  session: PlanChangeSessionDto | null;
  /** The card's rows as last read, or null before the first read lands. */
  rows: WorkItemTodoDto[] | null;
  progress: TodoProgressDto | null;
  /** A turn that did not finish, or a door that refused (a typed code). */
  errorCode: string | null;
  outOfCredits: boolean;
  markers: GuidePersonMarker[];
  /** A canvas tick the card refused, in the to-do catalog's words. */
  tickError: string | null;
}

/** The to-do reads and writes, injected so the hook stays free of the page's
 *  Server Action module (the host passes `todoActions`). */
export interface GuideTodoAccess {
  list: (input: {
    workItemId: string;
  }) => Promise<
    { ok: true; items: WorkItemTodoDto[]; progress: TodoProgressDto } | { ok: false; error: string }
  >;
  setDone: (input: {
    todoId: string;
    done: boolean;
  }) => Promise<
    { ok: true; todo: WorkItemTodoDto; progress: TodoProgressDto } | { ok: false; error: string }
  >;
}

export interface UseGuideConversationOptions {
  itemKey: string;
  /** The card's database id, once the overlay's anchor read resolved it. */
  workItemId: string | null;
  todos: GuideTodoAccess;
}

const OUT_OF_CREDITS_CODES = new Set(['MOTIR_AI_OUT_OF_CREDITS', 'out_of_credits']);

/** In-flight opens, keyed by card — see the header. Cleared once settled. */
const openings = new Map<string, Promise<GuideTurnResponse>>();

/** Open the guide on `itemKey`, joining a request already in flight for it. */
export function openGuideOnce(itemKey: string): Promise<GuideTurnResponse> {
  const key = itemKey.toUpperCase();
  const pending = openings.get(key);
  if (pending) return pending;
  const started = openGuideConversation(itemKey).finally(() => {
    // Released after the microtask the joiners read it in.
    queueMicrotask(() => openings.delete(key));
  });
  openings.set(key, started);
  return started;
}

/** The `user` turn whose job has not been answered yet, if the thread ends on one. */
function unansweredTurn(
  session: PlanChangeSessionDto,
): { id: string; jobId: string | null } | null {
  const last = [...session.turns].reverse().find((t) => t.role !== 'system');
  if (!last || last.role !== 'user') return null;
  return { id: last.id, jobId: last.jobId };
}

function errorCodeOf(err: unknown): { code: string | null; outOfCredits: boolean } {
  if (err instanceof PlanEditsClientError) {
    return {
      code: err.isOutOfCredits ? null : (err.code ?? 'FAILED'),
      outOfCredits: err.isOutOfCredits,
    };
  }
  return { code: 'FAILED', outOfCredits: false };
}

export function useGuideConversation({ itemKey, workItemId, todos }: UseGuideConversationOptions) {
  const [state, setState] = useState<GuideConversationState>({
    phase: 'opening',
    session: null,
    rows: null,
    progress: null,
    errorCode: null,
    outOfCredits: false,
    markers: [],
    tickError: null,
  });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const todosRef = useRef(todos);
  useEffect(() => {
    todosRef.current = todos;
  }, [todos]);
  // Stamped per read, so an older read that resolves late never overwrites a
  // newer one (`motir-core/CLAUDE.md`: sequence-guard the reconciles).
  const readSeq = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  /** Re-read the card's rows. Best-effort: a failed read keeps the last one. */
  const reloadRows = useCallback(async () => {
    if (!workItemId) return;
    const seq = ++readSeq.current;
    try {
      const result = await todosRef.current.list({ workItemId });
      if (!mountedRef.current || seq !== readSeq.current || !result.ok) return;
      setState((s) => ({ ...s, rows: result.items, progress: result.progress }));
    } catch {
      /* the last read stands */
    }
  }, [workItemId]);

  /** Watch a job to its end, then land it and re-read the rows. */
  const follow = useCallback(
    async (jobId: string, sessionId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setState((s) => ({ ...s, phase: 'running', errorCode: null, outOfCredits: false }));
      let failed: string | null | undefined;
      try {
        await streamAskJob(
          jobId,
          controller.signal,
          (code) => {
            failed = code;
          },
          () => {},
        );
      } catch {
        // An aborted stream (the overlay closed) ends here with nothing to say.
        if (controller.signal.aborted) return;
        failed = 'FAILED';
      }
      if (!mountedRef.current || controller.signal.aborted) return;
      if (failed !== undefined) {
        const gated = failed !== null && OUT_OF_CREDITS_CODES.has(failed);
        setState((s) => ({
          ...s,
          phase: 'idle',
          errorCode: gated ? null : 'GUIDE_FAILED',
          outOfCredits: gated,
        }));
        return;
      }
      try {
        const settled = await settleGuideJob(sessionId, jobId, controller.signal);
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          phase: 'idle',
          session: settled.session,
          errorCode: settled.outcome === 'failed' ? 'GUIDE_FAILED' : null,
        }));
      } catch (err) {
        if (!mountedRef.current || controller.signal.aborted) return;
        const { code, outOfCredits } = errorCodeOf(err);
        setState((s) => ({ ...s, phase: 'idle', errorCode: code, outOfCredits }));
        return;
      }
      await reloadRows();
    },
    [reloadRows],
  );

  /** Take a door response: hold the thread, and run its job if it started one. */
  const take = useCallback(
    async (response: GuideTurnResponse) => {
      if (!mountedRef.current) return;
      setState((s) => ({ ...s, session: response.session, phase: 'idle' }));
      const pending = response.jobId
        ? { jobId: response.jobId }
        : (() => {
            // A RESUME that reopened mid-turn (a reload while a turn ran): the
            // thread ends on a turn with a job and no answer, so follow that job.
            // The settle is replayable, so following a job another tab already
            // landed lands nothing and returns the thread.
            const open = unansweredTurn(response.session);
            return open?.jobId ? { jobId: open.jobId } : null;
          })();
      if (pending) await follow(pending.jobId, response.session.id);
    },
    [follow],
  );

  // OPEN — once per card for this mount. The guard is what keeps a re-run of
  // the effect (a dev double-invoke, a callback identity change) from opening a
  // second time; the module map above covers a second MOUNT.
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (openedRef.current === itemKey) return;
    openedRef.current = itemKey;
    void (async () => {
      try {
        const response = await openGuideOnce(itemKey);
        await take(response);
      } catch (err) {
        if (!mountedRef.current) return;
        const { code, outOfCredits } = errorCodeOf(err);
        setState((s) => ({ ...s, phase: 'idle', errorCode: code, outOfCredits }));
      }
    })();
  }, [itemKey, take]);

  useEffect(() => {
    void reloadRows();
  }, [reloadRows]);

  // THE LIVE REFRESH — a card edited elsewhere (the item page in another tab,
  // a teammate) is re-read when the reader comes back to this window. A refresh
  // that finds the same rows changes nothing, so nothing animates.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reloadRows();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reloadRows]);

  const send = useCallback(
    async (text: string) => {
      const session = stateRef.current.session;
      const body = text.trim();
      if (!session || !body || stateRef.current.phase !== 'idle') return;
      setState((s) => ({ ...s, phase: 'running', errorCode: null, outOfCredits: false }));
      try {
        await take(await sendGuideTurn(session.id, body));
      } catch (err) {
        if (!mountedRef.current) return;
        const { code, outOfCredits } = errorCodeOf(err);
        setState((s) => ({ ...s, phase: 'idle', errorCode: code, outOfCredits }));
      }
    },
    [take],
  );

  /** Try again — re-run the turn that did not finish. No second turn is written. */
  const retry = useCallback(async () => {
    const session = stateRef.current.session;
    if (stateRef.current.phase !== 'idle') return;
    if (!session) {
      // The door itself failed: open again.
      setState((s) => ({ ...s, phase: 'opening', errorCode: null, outOfCredits: false }));
      try {
        await take(await openGuideOnce(itemKey));
      } catch (err) {
        if (!mountedRef.current) return;
        const { code, outOfCredits } = errorCodeOf(err);
        setState((s) => ({ ...s, phase: 'idle', errorCode: code, outOfCredits }));
      }
      return;
    }
    const open = unansweredTurn(session);
    if (!open) return;
    setState((s) => ({ ...s, phase: 'running', errorCode: null, outOfCredits: false }));
    try {
      const rerun = await resubmitGuideTurn(session.id, open.id);
      // A turn that already HAD a job comes back with it: its settle is what
      // failed, so following the job again is the retry.
      await take(rerun.jobId ? rerun : { ...rerun, jobId: open.jobId });
    } catch (err) {
      if (!mountedRef.current) return;
      const { code, outOfCredits } = errorCodeOf(err);
      setState((s) => ({ ...s, phase: 'idle', errorCode: code, outOfCredits }));
    }
  }, [itemKey, take]);

  /**
   * The PERSON'S OWN tick or untick on the canvas (design panel 13) — through the
   * shipped to-do action, the same write the item page makes. No turn runs and
   * nothing is spent; the next turn reads the list as it now stands.
   */
  const setRowDone = useCallback(async (todoId: string, done: boolean) => {
    const rows = stateRef.current.rows ?? [];
    const step = rows.findIndex((r) => r.id === todoId) + 1;
    // Optimistic: the tick plays the moment it is pressed.
    setState((s) => ({
      ...s,
      tickError: null,
      rows: s.rows?.map((r) => (r.id === todoId ? { ...r, done } : r)) ?? null,
    }));
    try {
      const result = await todosRef.current.setDone({ todoId, done });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setState((s) => ({
          ...s,
          tickError: result.error,
          rows: s.rows?.map((r) => (r.id === todoId ? { ...r, done: !done } : r)) ?? null,
        }));
        return;
      }
      setState((s) => {
        const turns = s.session?.turns ?? [];
        return {
          ...s,
          rows: s.rows?.map((r) => (r.id === todoId ? result.todo : r)) ?? null,
          progress: result.progress,
          markers: [
            ...s.markers,
            {
              id: `${todoId}-${s.markers.length}`,
              afterTurnId: turns.at(-1)?.id ?? null,
              done,
              step,
            },
          ],
        };
      });
    } catch {
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        tickError: 'FAILED',
        rows: s.rows?.map((r) => (r.id === todoId ? { ...r, done: !done } : r)) ?? null,
      }));
    }
  }, []);

  return { state, send, retry, reloadRows, setRowDone };
}
