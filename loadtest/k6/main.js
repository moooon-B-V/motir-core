// THE k6 ENTRY (Story MOTIR-8538 · MOTIR-8678).
//
//   K6_AUTO_EXTENSION_RESOLUTION=false k6 run \
//     -e LOADTEST_PROFILE=/abs/profile.resolved.json \
//     -e LOADTEST_MANIFEST=/abs/manifest.json \
//     --summary-export summary.json loadtest/k6/main.js
//
// Composes the scenario functions the agent, run-lifecycle and reader cards export
// into ONE `options.scenarios` block, built by the resolver
// (`loadtest/profiles/resolve.ts`): closed model, `ramping-vus`, fixed scenario
// names (agent_reads, agent_writes, agent_claims, burst, runs, reader_tab,
// reader_browse), each tagged with its reserved `role`.
//
// ⚠️ NO THRESHOLDS. `options` has no `thresholds` key and none is added here: k6
// has nothing to fail, and the verdict is `pnpm loadtest:report`'s alone, judged
// against the profile's own threshold sections.
//
// Both paths must be ABSOLUTE: k6 resolves a relative `open()` against this file.
// The manifest holds every token and cookie, and nothing here prints one.

import { agentClaims } from './scenarios/agentClaims.js';
import { agentReads } from './scenarios/agentReads.js';
import { agentWrites } from './scenarios/agentWrites.js';
import { burst } from './scenarios/burst.js';
import { probeReaderCookie, readerBrowse, readerTab } from './scenarios/readers.js';
import { runsScenario } from './scenarios/runs.js';
import { loadReaders } from './lib/manifest.js';

const profilePath = __ENV.LOADTEST_PROFILE;
const manifestPath = __ENV.LOADTEST_MANIFEST;
if (!profilePath || !manifestPath) {
  throw new Error('LOADTEST_PROFILE and LOADTEST_MANIFEST must both name absolute paths');
}

const resolved = JSON.parse(open(profilePath));
const manifest = JSON.parse(open(manifestPath));
const baseUrl = manifest.baseUrl.replace(/\/+$/, '');
const so = resolved.k6.scenarioOptions;
const with_ = (o) => Object.assign({ baseUrl }, o);

export const options = resolved.k6.options;

const readers = resolved.vus.readers > 0 ? loadReaders(manifestPath, resolved.vus.readers) : [];

export const agentReadsExec = agentReads(manifest, with_(so.agentReads));
export const agentWritesExec = agentWrites(manifest, with_(so.agentWrites));
export const agentClaimsExec = agentClaims(manifest, with_(so.agentClaims));
export const burstExec = burst(manifest, with_(so.burst));
export const runsExec = runsScenario({ manifest, baseUrl, runs: so.runs });
export const readerTabExec = readerTab(readers, with_(so.readerTab));
export const readerBrowseExec = readerBrowse(readers, with_(so.readerBrowse));

/** Abort before any VU starts when the target does not accept the seeded cookie. */
export function setup() {
  if (resolved.vus.readers > 0) probeReaderCookie(readers, { baseUrl });
}
