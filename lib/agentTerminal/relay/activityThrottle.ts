import { TERMINAL_ACTIVITY_THROTTLE_MS } from '@/lib/agentTerminal/protocol';

// THE ACTIVITY THROTTLE (`docs/decisions/agent-terminal.md` Q6 · MOTIR-6940):
// at most one `touchActivity` per instance per relay process per minute. Each
// bump re-arms the debounced idle timer, so a tighter bump would only enqueue
// jobs. In memory, per process — a second relay machine keeps its own, which at
// worst doubles a rate that is already one a minute.

export class ActivityThrottle {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly windowMs: number = TERMINAL_ACTIVITY_THROTTLE_MS,
  ) {}

  /** True when this instance may be bumped now (and records the bump). */
  take(instanceId: string): boolean {
    const now = this.now();
    const previous = this.last.get(instanceId);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    this.last.set(instanceId, now);
    if (this.last.size > 1_000) this.prune(now);
    return true;
  }

  /** How many instances are remembered — for tests. */
  get size(): number {
    return this.last.size;
  }

  /** Forget every instance whose window has passed (they would be bumped anyway). */
  prune(now: number = this.now()): void {
    for (const [id, at] of this.last) if (now - at >= this.windowMs) this.last.delete(id);
  }
}
