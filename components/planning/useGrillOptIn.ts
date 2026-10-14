'use client';

import { useCallback, useState } from 'react';

// WHERE THE "GRILL ME" CHOICE LIVES (Task MOTIR-1101 · Subtask MOTIR-8447; design
// `design/ai-chat/design-notes.md` § Grill me, G1/G2).
//
// The choice belongs to the PLAN-CHANGE SESSION it was made in, never to the
// mounted rail and never to the person:
//
//   • The conversation phase can be ENTERED AGAIN in the same session (the
//     planner steps back out of the walk to ask what a change meant). The rail
//     stops rendering the control during planning, so a mount-scoped value would
//     be the right value only by accident — it is read back from the session.
//   • A DIFFERENT session starts with it off. A fresh overlay, or "Plan something
//     new", is a new session id with nothing stored against it.
//
// It is held in `sessionStorage` under the session id, so a reload of the same
// tab keeps it and nothing outlives the tab. Before the session exists (the
// person turns it on in a fresh overlay, before the first message creates the
// session) the value is held locally and ADOPTED by the first session id that
// appears — that session is the one the choice was made for.
//
// Every storage access is guarded: a private window or blocked storage still
// gets a working toggle for the life of the mount.

const KEY_PREFIX = 'motir.grillMe.';

function readStored(sessionId: string): boolean {
  try {
    return window.sessionStorage.getItem(KEY_PREFIX + sessionId) === 'on';
  } catch {
    return false;
  }
}

function writeStored(sessionId: string, on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(KEY_PREFIX + sessionId, 'on');
    else window.sessionStorage.removeItem(KEY_PREFIX + sessionId);
  } catch {
    // Storage unavailable: the in-memory value below still holds for this mount.
  }
}

export interface GrillOptIn {
  on: boolean;
  setOn: (on: boolean) => void;
}

/**
 * The person's Grill me choice for `sessionId` — the plan-change session the run
 * belongs to, or `null` before one exists. Off unless the person turned it on in
 * THIS session.
 */
export function useGrillOptIn(sessionId: string | null): GrillOptIn {
  const [held, setHeld] = useState<{ sessionId: string | null; on: boolean }>(() => ({
    sessionId,
    on: sessionId ? readStored(sessionId) : false,
  }));

  // The session changed under the rail — adjusted during render (React's
  // "storing information from previous renders"), so the first paint for the new
  // session already shows its own value.
  let current = held;
  if (held.sessionId !== sessionId) {
    if (held.sessionId === null && sessionId !== null) {
      // THE FIRST SESSION adopts the choice made before it existed.
      const on = held.on || readStored(sessionId);
      if (held.on) writeStored(sessionId, true);
      current = { sessionId, on };
    } else {
      // A DIFFERENT session: its own value, off unless it was set there.
      current = { sessionId, on: sessionId ? readStored(sessionId) : false };
    }
    setHeld(current);
  }

  const setOn = useCallback(
    (on: boolean) => {
      setHeld((h) => {
        if (h.sessionId) writeStored(h.sessionId, on);
        return { ...h, on };
      });
    },
    [setHeld],
  );

  return { on: current.on, setOn };
}
