import 'server-only';

import { isCloud } from '@/lib/billing/availability';

// DOES THIS DEPLOYMENT RUN HOSTED AGENTS AT ALL? (Story MOTIR-6989 · MOTIR-6995)
//
// A BUILD fact, never a live read. The Hosted agent settings room exists only on
// a deployment that runs hosted agents (`design/settings/design-notes.md`
// § Hosted agent room — *where the room exists*): it is the
// `hostedRunsAvailable` axis of the settings registry
// (`SettingsNavAvailability`), and the room's page answers `notFound()` without
// it, as billing does off-cloud.
//
// ⚠️ NOT motir-ai's health. A room that came and went with Motir AI answering
// would read as a feature being removed and 404 a bookmark mid-outage; the room
// draws the outage instead (its unavailable state).
//
// A hosted run is a metered container on Motir's own fleet — a capability of the
// hosted service, absent from a self-hosted build — so the answer is the CLOUD
// question, asked through its one reader (`isCloud()`, MOTIR-4033: two
// questions get two functions even when they read one variable). It defaults
// CLOSED exactly as that flag does: unset means no hosted runs.

/** True only on a build that runs hosted agents. Server-only; never throws. */
export function isHostedRunsAvailable(): boolean {
  return isCloud();
}
