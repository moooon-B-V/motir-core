'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasLayoutDTO } from '@/lib/dto/canvasLayout';

// Client hook for the onboarding canvas's saved arrangement (Subtask 7.3.11) —
// loads the user's positions from the 7.3.77 read seam (`GET /api/canvas-layout`)
// and persists drags (debounced `PATCH`). Positions are keyed by nodeKey.
// Persistence is BEST-EFFORT: a failed load leaves the map empty (the canvas
// falls back to its auto-layout) and a failed save is swallowed — neither ever
// blocks the canvas. The move is applied OPTIMISTICALLY so a released node stays
// where it was dropped before the server round-trip.

type Positions = Record<string, { x: number; y: number }>;

const SAVE_DEBOUNCE_MS = 500;

export interface UseCanvasLayout {
  positions: Positions;
  savePosition: (nodeKey: string, x: number, y: number) => void;
  /** False until the saved-layout load ATTEMPT completes (success OR failure).
   *  Consumers gate rendering on it so nodes never paint at the auto-layout first
   *  and then jump to the stored positions (the MOTIR-1253 reposition flash). */
  loaded: boolean;
}

export function useCanvasLayout(): UseCanvasLayout {
  const [positions, setPositions] = useState<Positions>({});
  const [loaded, setLoaded] = useState(false);
  const pending = useRef<Positions>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  // Load the saved layout once on mount.
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/canvas-layout', {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (res.ok && mounted.current) {
          const body = (await res.json()) as { layout: CanvasLayoutDTO };
          if (mounted.current) {
            const map: Positions = {};
            for (const p of body.layout.positions) map[p.nodeKey] = { x: p.x, y: p.y };
            setPositions(map);
          }
        }
      } catch {
        /* best-effort: fall back to the auto-layout */
      } finally {
        // Flip `loaded` once the attempt is done — even on failure (the canvas
        // then renders with the auto-layout fallback rather than hanging).
        if (mounted.current) setLoaded(true);
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const flush = useCallback(() => {
    const batch = pending.current;
    pending.current = {};
    const list = Object.entries(batch).map(([nodeKey, p]) => ({ nodeKey, x: p.x, y: p.y }));
    if (list.length === 0) return;
    void fetch('/api/canvas-layout', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: list }),
    }).catch(() => {
      /* best-effort */
    });
  }, []);

  const savePosition = useCallback(
    (nodeKey: string, x: number, y: number) => {
      setPositions((prev) => ({ ...prev, [nodeKey]: { x, y } })); // optimistic
      pending.current[nodeKey] = { x, y };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  return { positions, savePosition, loaded };
}
