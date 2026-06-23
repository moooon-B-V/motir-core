'use client';

import { useEffect, useRef, useState } from 'react';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';

// Client read of the member-safe AI entitlement (Subtask 8.1.8) that drives the
// AI-boundary paywall. Fetches `GET /api/ai/access` once on mount; the route
// degrades to `applicable: false` on any failure, so this hook never throws and
// the consumer simply renders nothing when AI isn't blocked / not on cloud.
//
// `blocked` is the proactive trigger: on cloud, a balance at or below zero means
// the org cannot run AI right now (the SAME threshold the motir-ai credit gate
// refuses at), so the entry point shows the paywall before the user even tries.
export interface UseAiAccess {
  access: AiAccessDTO | null;
  loading: boolean;
  /** Cloud + the org is out of usable AI credits → show the paywall proactively. */
  blocked: boolean;
}

export function useAiAccess(): UseAiAccess {
  const [access, setAccess] = useState<AiAccessDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/ai/access', {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        const dto = res.ok ? ((await res.json()) as AiAccessDTO) : null;
        if (mountedRef.current) setAccess(dto);
      } catch {
        // Abort or network failure → leave access null (no paywall). The reactive
        // out-of-credits path remains the authoritative block.
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, []);

  const blocked = access?.applicable === true && access.balance <= 0;
  return { access, loading, blocked };
}
