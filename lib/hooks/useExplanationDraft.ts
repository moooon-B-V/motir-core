'use client';

import { useCallback, useRef, useState } from 'react';

// The client side of "Draft with AI" (Subtask 8.8.12): submits a
// `generate_explanation` job to /api/ai/explanation and streams the drafted
// markdown from /api/ai/explanation/:jobId/stream straight into the editor,
// token-by-token (design/work-items/draft-with-ai 1C/1D). Shared by the create
// modal and the edit form so both drive the identical state machine.
//
// It owns NO source classification — that's explanationSourceForSave, keyed off
// the `draftBaseline` this hook exposes (the exact text the AI produced). The
// cloud-gate (disabled button + "Connect Motir AI" notice) lives in the consumer
// via the server-resolved `aiConfigured` prop; this hook handles only the
// submit → stream → token lifecycle and the stream-failed error state (3B).

export type DraftPhase = 'idle' | 'drafting' | 'error';

export interface DraftError {
  code: string;
  message: string;
}

// The work-item fields the draft is generated from — sent to the submit route.
export interface ExplanationDraftContext {
  title: string;
  description?: string | null;
  type?: string | null;
  parentKey?: string | null;
  parentTitle?: string | null;
}

export interface UseExplanationDraftOptions {
  // Receives the accumulated markdown as tokens arrive (and the final text). The
  // consumer writes it into the editor's value.
  onText: (text: string) => void;
  // Resolves the current draft context at click time (title is required — the
  // button is disabled until there is one).
  getContext: () => ExplanationDraftContext;
}

export interface UseExplanationDraft {
  phase: DraftPhase;
  isDrafting: boolean;
  error: DraftError | null;
  // The exact text the AI produced this session (null when none yet). The source
  // classifier (explanationSourceForSave) keys off this to mark ai_draft vs
  // user_edited.
  draftBaseline: string | null;
  start: () => void;
  stop: () => void;
  dismissError: () => void;
  // Abort any in-flight draft and forget the baseline/error — used when a host
  // surface resets (e.g. the create modal closes), so the next open starts clean.
  reset: () => void;
}

interface SubmitResponse {
  jobId?: string;
  code?: string;
  error?: string;
}

// Split a chunk buffer into complete SSE frames (separated by a blank line),
// returning the parsed frames + the unconsumed remainder.
function drainFrames(buffer: string): { frames: { event: string; data: unknown }[]; rest: string } {
  const frames: { event: string; data: unknown }[] = [];
  let rest = buffer;
  let sep = rest.indexOf('\n\n');
  while (sep !== -1) {
    const raw = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const parsed = parseFrame(raw);
    if (parsed) frames.push(parsed);
    sep = rest.indexOf('\n\n');
  }
  return { frames, rest };
}

function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join('\n');
  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
    // leave as the raw string
  }
  return { event, data };
}

export function useExplanationDraft(options: UseExplanationDraftOptions): UseExplanationDraft {
  const { onText, getContext } = options;
  const [phase, setPhase] = useState<DraftPhase>('idle');
  const [error, setError] = useState<DraftError | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<string | null>(null);

  // Latest callbacks via refs so `start` stays stable and never streams into a
  // stale editor setter.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;

  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const dismissError = useCallback(() => {
    setError(null);
    setPhase('idle');
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setError(null);
    setPhase('idle');
    setDraftBaseline(null);
  }, []);

  const start = useCallback(() => {
    if (abortRef.current) return; // already drafting
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setPhase('drafting');
    // Clear the editor so the draft fills it cleanly (Regenerate replaces the
    // previous draft); the streamed tokens then accumulate from empty.
    let accumulated = '';
    onTextRef.current('');

    void (async () => {
      try {
        const ctx = getContextRef.current();
        const submitRes = await fetch('/api/ai/explanation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ctx),
          signal: controller.signal,
        });
        const submitBody = (await submitRes.json().catch(() => ({}))) as SubmitResponse;
        if (!submitRes.ok || !submitBody.jobId) {
          throw new DraftFailure(submitBody.code ?? 'MOTIR_AI_UNAVAILABLE', submitBody.error);
        }

        const streamRes = await fetch(
          `/api/ai/explanation/${encodeURIComponent(submitBody.jobId)}/stream`,
          { headers: { Accept: 'text/event-stream' }, signal: controller.signal },
        );
        if (!streamRes.ok || !streamRes.body) {
          const body = (await streamRes.json().catch(() => ({}))) as SubmitResponse;
          throw new DraftFailure(body.code ?? 'MOTIR_AI_UNAVAILABLE', body.error);
        }

        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let failure: DraftFailure | null = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = drainFrames(buffer);
          buffer = rest;
          for (const { event, data } of frames) {
            if (event === 'token') {
              const text = (data as { text?: unknown })?.text;
              if (typeof text === 'string') {
                accumulated += text;
                onTextRef.current(accumulated);
              }
            } else if (event === 'explanation') {
              const md = (data as { explanationMd?: unknown })?.explanationMd;
              if (typeof md === 'string') {
                accumulated = md;
                onTextRef.current(accumulated);
              }
            } else if (event === 'error') {
              const d = (data as { code?: unknown; message?: unknown }) ?? {};
              failure = new DraftFailure(
                typeof d.code === 'string' ? d.code : 'MOTIR_AI_UNAVAILABLE',
                typeof d.message === 'string' ? d.message : undefined,
              );
            }
            // `status` frames carry only progress — nothing to render.
          }
        }

        // The text generated so far is kept either way (design 3B).
        setDraftBaseline(accumulated.length > 0 ? accumulated : null);
        if (failure) {
          setError({ code: failure.code, message: failure.message });
          setPhase('error');
        } else {
          setPhase('idle');
        }
      } catch (err) {
        if (controller.signal.aborted) {
          // User pressed Stop — keep whatever streamed in, drop back to idle.
          setDraftBaseline(accumulated.length > 0 ? accumulated : null);
          setPhase('idle');
        } else if (err instanceof DraftFailure) {
          setDraftBaseline(accumulated.length > 0 ? accumulated : null);
          setError({ code: err.code, message: err.message });
          setPhase('error');
        } else {
          setDraftBaseline(accumulated.length > 0 ? accumulated : null);
          setError({
            code: 'MOTIR_AI_UNAVAILABLE',
            message: err instanceof Error ? err.message : 'Drafting failed.',
          });
          setPhase('error');
        }
      } finally {
        abortRef.current = null;
      }
    })();
  }, []);

  return {
    phase,
    isDrafting: phase === 'drafting',
    error,
    draftBaseline,
    start,
    stop,
    dismissError,
    reset,
  };
}

// Internal carrier for a typed draft failure (a submit non-2xx, a stream non-2xx,
// or a terminal `error` SSE frame) — its `code` is the 7.1.1 taxonomy code.
class DraftFailure extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}
