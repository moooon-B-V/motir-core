// The E2E server's keep-alive window (MOTIR-5697).
//
// Import-light ON PURPOSE, like `github-const.ts`: all three Playwright configs
// import it, and a config is parsed before any env/DB wiring exists.
//
// THE PAIR, both read rather than assumed:
//
//  • SERVER — `next start` builds a plain `http.createServer` and assigns
//    `server.keepAliveTimeout` ONLY when `--keepAliveTimeout` is passed
//    (`next/dist/server/lib/start-server.js`). Without the flag it is Node's
//    default: 5000 ms, plus Node 22's 1000 ms `keepAliveTimeoutBuffer`. An idle
//    pooled socket is closed by the server at ~6 s.
//  • CLIENT — `APIRequestContext` (`page.request`, `request.newContext`) sends
//    every request through ONE process-wide `new HttpHappyEyeballsAgent({
//    keepAlive: true })` (playwright-core 1.60), with no `timeout`. Node's
//    `Agent.keepSocketAlive` only lets the server's `Keep-Alive: timeout=5` hint
//    SHORTEN an agent timeout that already exists (`serverHint < agentTimeout`),
//    and with none it stays 0 — so the client keeps an idle socket for ever.
//
// The server's is the shorter, so the race is reachable by construction: a
// request issued as the server closes an idle socket reuses a dead connection
// and fails with `apiRequestContext.get: read ECONNRESET`. A local probe
// against a default `http.Server` reproduced that exact line at a 5988 ms idle
// gap (1 reset in 31 gaps swept 5985–6015 ms, 30 fresh connections); at the
// value below the same sweep reset 0 times on ONE connection.
//
// THE FIX IS ON THE SERVER, and it cannot be "slightly above the client",
// because the client's timeout is infinite. The server must simply not close
// an idle socket while a runner can still hold it: a Playwright worker lives no
// longer than its CI job, so the window is set above the longest job timeout in
// `.github/workflows/**` (`tests/e2e-server-keep-alive.test.ts` asserts it).
// Teardown is unaffected — Next's SIGTERM path calls `closeAllConnections()`.
//
// ⚠️ NOT a retry at the call site. A retry would hide the one signal that a
// connection problem exists; `withTruncateDeadlockRetry` in `db-reset.ts` is a
// recorded MASK for a different failure, not a pattern to copy here.

/** Two hours — above every CI job's `timeout-minutes`, so no run outlives it. */
export const E2E_SERVER_KEEP_ALIVE_MS = 7_200_000;

/** The `next start` flag that applies it. */
export const NEXT_START_KEEP_ALIVE_FLAG = `--keepAliveTimeout ${E2E_SERVER_KEEP_ALIVE_MS}`;
