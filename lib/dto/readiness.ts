/**
 * What `GET /api/health/ready` answers (Bug MOTIR-8231) — whether this process
 * has warmed up enough to be sent traffic.
 *
 * `warming` covers every state before the first successful warm-up: nothing
 * started yet, a warm-up in flight, and one that failed and will be retried on
 * the next check. The route answers it with a 503, so Fly's proxy keeps the
 * machine out of rotation; `ready` is the 200.
 */
export interface ReadinessDTO {
  state: 'ready' | 'warming';
  /**
   * How many connections the route-handler runtime's pool holds open right now
   * (`pg.Pool.totalCount`), or null when the pool is not this module's to read.
   */
  openConnections: number | null;
  /** How many open connections the warm-up establishes before it declares the process ready. */
  warmConnections: number;
}
