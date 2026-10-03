/**
 * HOW MANY MACHINES EACH PROCESS GROUP SHOULD HAVE RUNNING (MOTIR-7332).
 *
 * ⚠️ DECLARED HERE, NOT READ FROM `fly.toml` AT RUNTIME. The count is an
 * operator's decision (`docs/decisions/application-hosting.md` Q6 / §7), and
 * `identity.ts` records why a config file is not a reading: motir-ai's `fly.toml`
 * once promised a pool while production ran one machine for weeks. The board
 * renders the MEASURED count beside this expectation, so an operator judging the
 * card always sees both numbers. CI's deploy guard (`scripts/machinePool.mjs`)
 * derives the same expectation from `fly.toml` on every release, so a change to
 * the pool that forgets this file shows up as a card short or over on the board.
 *
 * - `app: 2` — `fly.toml` `http_service.min_machines_running = 2`, the web pool.
 * - `worker: 1` — the job worker. Fly also adds a STANDBY machine to a
 *   single-machine group; it sits stopped by design and is not counted, so a
 *   stopped standby never makes this group read as short.
 */
export const EXPECTED_STARTED_MACHINES: Readonly<Record<string, number>> = {
  app: 2,
  worker: 1,
};
