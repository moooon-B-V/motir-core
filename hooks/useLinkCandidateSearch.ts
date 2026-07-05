'use client';

import { useEffect, useRef, useState } from 'react';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';

export type LinkCandidateFetcher<T> = (
  query: string,
) => Promise<{ ok: true; candidates: T[] } | { ok: false; error: string }>;

/** One server fetch per settled keystroke — long enough to coalesce a fast typer. */
const DEBOUNCE_MS = 250;

/**
 * Controlled-query debounced issue search for the link pickers (Subtask 6.9.2 —
 * closes finding #98). Owns the search query, debounces the per-keystroke server
 * fetch (`fetcher` — the detail-page or create-modal candidate action), and
 * exposes candidates / loading / error for the shared `LinkAddForm`. Below
 * {@link QUICK_SEARCH_MIN_QUERY_LENGTH} it short-circuits to an empty list with
 * NO round-trip — the same guard the service applies — and the picker shows a
 * "type to search" prompt. `refetchKey` re-runs the current query when a
 * dependency changes (the detail picker passes the relationship, whose
 * already-linked exclusion set is direction-aware). Mirrors the
 * `MultiSelectPicker` "caller debounces its fetch off the controlled query"
 * contract and the `ParentPicker` data-fetch-effect precedent.
 */
export function useLinkCandidateSearch<T>({
  fetcher,
  refetchKey,
}: {
  fetcher: LinkCandidateFetcher<T>;
  refetchKey?: string;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The fetcher closes over currentItemId / relationship, so its identity changes
  // every render — hold it in a ref (kept current in an effect) so it isn't a
  // fetch-effect dependency. The debounced fetch reads `.current` at fire time,
  // by when this effect has committed the latest closure.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const trimmed = query.trim();
  const tooShort = trimmed.length < QUICK_SEARCH_MIN_QUERY_LENGTH;

  // Data-fetching effect: debounce the query, then fetch. Legitimately resets
  // loading/error/candidates around the async call (the ParentPicker precedent),
  // so the set-state-in-effect rule is disabled for this block only.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (tooShort) {
      setLoading(false);
      setError(null);
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      fetcherRef.current(trimmed).then((res) => {
        if (cancelled) return;
        setLoading(false);
        if (res.ok) {
          setCandidates(res.candidates);
        } else {
          setError(res.error);
          setCandidates([]);
        }
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, tooShort, refetchKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function reset() {
    setQuery('');
    setCandidates([]);
    setLoading(false);
    setError(null);
  }

  return { query, setQuery, candidates, loading, error, tooShort, reset };
}
