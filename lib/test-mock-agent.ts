// Node-only shared undici MockAgent for the E2E seams (test-oauth-mock,
// test-blob-mock). Pulled out of instrumentation.ts so the `undici` import is
// never analyzed by Next's Edge-runtime bundler (the same reason the OAuth
// mock lives in its own module); instrumentation.ts dynamic-imports this only
// under NEXT_RUNTIME=nodejs with an E2E_TEST_* flag set.
//
// ONE agent serves every mock: setGlobalDispatcher replaces the dispatcher
// wholesale, so a second MockAgent would silently disconnect the first
// mock's intercepts — mocks ADD pools to this shared agent instead.
//
// CRITICAL — undici version coupling: the undici devDep is pinned to ^6.x
// because Node 22's built-in fetch uses its bundled undici@6.x dispatcher;
// calling setGlobalDispatcher from a DIFFERENT major silently sets a
// dispatcher on the wrong copy of undici and no intercept ever fires. If a
// future Node upgrade bumps the bundled undici to v7+, bump the devDep in
// lockstep.

import { MockAgent, setGlobalDispatcher } from 'undici';

/**
 * ⚠️ THE HOSTS NO E2E PROCESS MAY REACH FOR REAL (Bug MOTIR-5837).
 *
 * Every GitHub boundary the lane crosses is faked by a seam, and the lane's
 * contract is that NO REAL PULL REQUEST IS EVER MERGED and NO REAL REPOSITORY
 * IS EVER CREATED. A call no seam intercepts is therefore always a hole —
 * usually a PROCESS the seams were never installed in (the job worker, until
 * this card: `pull-request/auto-merge.requested` minted an installation token
 * against the real api.github.com and died on its 401).
 *
 * So the shared agent REFUSES these hosts rather than passing them through.
 * An unintercepted call then throws undici's `MockNotMatchedError`, which names
 * the method, the path and the origin — in the process that made it, on the
 * job's own failure line — instead of becoming outbound traffic whose only
 * symptom is a green pull request that never merges. Because the refusal lives
 * HERE, every process that installs the agent carries it; a process added later
 * cannot install the seams and forget the guard.
 *
 * `host` is undici's `URL.host`, so a default-port origin arrives bare.
 */
export const E2E_REFUSED_HOSTS: readonly string[] = ['api.github.com'];

export function installSharedMockAgent(): MockAgent {
  const agent = new MockAgent();
  // Allow real network for everything not explicitly intercepted (Prisma's
  // TCP to Postgres, the Inngest dev server, …) — EXCEPT the refused hosts
  // above, where an unmatched call must fail rather than leave the box.
  agent.enableNetConnect((host) => !E2E_REFUSED_HOSTS.includes(host));
  setGlobalDispatcher(agent);
  return agent;
}
