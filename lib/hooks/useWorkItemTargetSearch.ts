'use client';

import { useEffect, useRef, useState } from 'react';
import { searchWorkItemMentions } from '@/lib/mentions/workItemMentionSearch';
import type { WorkItemMentionCandidate } from '@/components/ui/markdownEditorMentions';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';

// The debounced work-item search behind the planning composer's `@` target picker
// (Subtask MOTIR-1491). It adds NO data source: `searchWorkItemMentions` is the
// SHIPPED 5.8.5 fetcher over `GET /api/work-items/mention-search` (workspace +
// browsable-project scoped, capped), the same one the rich-text editor's `@`
// picker rides — this hook only owns the timer, the cancellation and the
// question "are these results the ones for the query on screen?".
//
// The type import is TYPE-ONLY, so nothing from the editor module (Tiptap and
// friends) is pulled into the planning bundle.
//
// ⚠️ Nothing is CLEARED by an effect: the only state is the last RESOLVED
// (query, results) pair, written from the fetch callback, and `results` /
// `loading` are DERIVED from whether that pair still describes the current query.
// Clearing in an effect body would be a synchronous setState in an effect (a lint
// error in this repo, and a cascading render) — and it would also make "stale
// results for the previous query" a state the UI can briefly render.

/** The debounce the shipped editor picker uses — kept identical so the two `@`
 *  surfaces feel the same and hit the endpoint at the same rate. */
export const TARGET_SEARCH_DEBOUNCE_MS = 250;

export interface WorkItemTargetSearchState {
  results: WorkItemMentionCandidate[];
  loading: boolean;
  /** Below the server's minimum — no request is made, the picker hints instead. */
  tooShort: boolean;
}

const NO_RESULTS: WorkItemMentionCandidate[] = [];

/**
 * Search the project's work items for `query`, debounced, while `enabled`.
 *
 * A sub-threshold query never reaches the network (the service would short-circuit
 * it to `[]` anyway — the `QUICK_SEARCH_MIN_QUERY_LENGTH` guard), and a failed
 * request resolves to no results rather than throwing into the composer: the
 * picker's no-results state is the honest thing to show either way.
 */
export function useWorkItemTargetSearch(
  query: string,
  enabled: boolean,
): WorkItemTargetSearchState {
  const trimmed = query.trim();
  const tooShort = trimmed.length < QUICK_SEARCH_MIN_QUERY_LENGTH;
  const active = enabled && !tooShort;

  // The last query whose results came back, and those results. `null` means
  // "nothing has resolved yet".
  const [resolved, setResolved] = useState<{
    query: string;
    results: WorkItemMentionCandidate[];
  } | null>(null);

  // The latest request wins: an in-flight response for an older query is dropped
  // by its own `cancelled` flag AND by this sequence guard, so a slow keystroke
  // can never overwrite the newest results (the seq-guard rule in CLAUDE.md).
  const seqRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    const seq = ++seqRef.current;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchWorkItemMentions(trimmed).then(
        (rows) => {
          if (cancelled || seq !== seqRef.current) return;
          setResolved({ query: trimmed, results: rows });
        },
        () => {
          if (cancelled || seq !== seqRef.current) return;
          setResolved({ query: trimmed, results: [] });
        },
      );
    }, TARGET_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, active]);

  const settled = active && resolved !== null && resolved.query === trimmed;
  return {
    results: settled ? resolved.results : NO_RESULTS,
    // Searching from the moment the query changes until ITS results land —
    // the debounce window included, which is what the user is waiting through.
    loading: active && !settled,
    tooShort,
  };
}
