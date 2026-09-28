import type { ContainerHandle, ReapSparePredicate } from './types';

/**
 * Ask the caller whether the reaper must leave `handle` running (MOTIR-6450).
 * One implementation for every adapter, so "a predicate that throws spares
 * nothing" is decided once: the reaper is the backstop that stops a leak billing,
 * and an unanswered question must not keep a container alive.
 */
export async function sparedByCaller(
  spare: ReapSparePredicate | undefined,
  handle: ContainerHandle,
): Promise<boolean> {
  if (!spare) return false;
  try {
    return await spare(handle);
  } catch (err) {
    console.warn('[orchestrator] a reap spare check failed — the container is not spared', {
      containerId: handle.id,
      detail: err instanceof Error ? err.message : 'unknown',
    });
    return false;
  }
}
