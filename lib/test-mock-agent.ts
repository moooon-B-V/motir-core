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

export function installSharedMockAgent(): MockAgent {
  const agent = new MockAgent();
  // Allow real network for everything not explicitly intercepted (Prisma's
  // TCP to Postgres, the Inngest dev server, …). MockAgent's default is to
  // disable net-connect; we call it explicitly to be unambiguous.
  agent.enableNetConnect();
  setGlobalDispatcher(agent);
  return agent;
}
