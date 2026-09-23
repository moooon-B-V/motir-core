import type { APIResponse, Route } from '@playwright/test';

// The ask-door stubs' ONE shared hop onto the REAL session routes (MOTIR-6023;
// `agent-authored-plans.md` AMENDMENT 17 §1–§2). A stub fakes the classification
// and the run; the turn itself must still be written by the product, so the
// thread the rail reads back is genuinely persisted rows.
//
// Since sessions are addressed BY ID, which door that is depends on what the
// rail held when it asked:
//   - it named a `sessionId` → append to THAT session (`…/session/turns`);
//   - it named none (the first turn of a conversation) → `POST …/session`, which
//     STARTS the session with this turn — or lands it on the caller's resumable
//     one, exactly as the real ask door does.

/** The `{ body, sessionId }` an intercepted `POST /api/ai/ask` carried. */
export function readAskRequest(route: Route): {
  body: string;
  isAnswer: boolean;
  sessionId: string | null;
} {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(route.request().postData() ?? '{}');
  } catch {
    parsed = {};
  }
  const bag = parsed as { body?: unknown; isAnswer?: unknown; sessionId?: unknown };
  return {
    body: typeof bag.body === 'string' ? bag.body : '',
    isAnswer: bag.isAnswer === true,
    sessionId: typeof bag.sessionId === 'string' && bag.sessionId ? bag.sessionId : null,
  };
}

/** Write an intercepted ask turn through the real session routes; the response
 *  is the updated session DTO. */
export async function persistAskTurn(route: Route): Promise<APIResponse> {
  const { body, isAnswer, sessionId } = readAskRequest(route);
  const origin = new URL(route.request().url()).origin;
  return sessionId
    ? route.fetch({
        url: `${origin}/api/ai/plan-change/session/turns`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ sessionId, body, isAnswer }),
      })
    : route.fetch({
        url: `${origin}/api/ai/plan-change/session`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ body, isAnswer }),
      });
}

/** Re-read the session an intercepted request NAMED (by `sessionId` in its body),
 *  through the real by-id read. */
export async function readNamedSession(route: Route): Promise<APIResponse> {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(route.request().postData() ?? '{}');
  } catch {
    parsed = {};
  }
  const sessionId = (parsed as { sessionId?: unknown }).sessionId;
  const origin = new URL(route.request().url()).origin;
  const query =
    typeof sessionId === 'string' && sessionId ? `?id=${encodeURIComponent(sessionId)}` : '';
  // ⚠️ `method: 'GET'` IS LOAD-BEARING. `route.fetch` inherits the intercepted
  // request's method, and every caller intercepts a POST — so without it this
  // "read" is a `POST …/session`, which since MOTIR-6024 STARTS a session and
  // refuses a body-less call with 400. It used to pass by accident, back when
  // that POST opened one.
  return route.fetch({ url: `${origin}/api/ai/plan-change/session${query}`, method: 'GET' });
}
