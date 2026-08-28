'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { dataExportService } from '@/lib/services/dataExportService';
import { DATA_PRIVACY_PANE_PATH } from '@/lib/users/dataSubjectRequests';
import { consumeRateLimit } from '@/lib/rateLimit/fixedWindow';

// Server Actions for the Account › Data & privacy pane (Story 8.4 · Subtask
// MOTIR-1136). Transport only (per CLAUDE.md, a Server Action is the route-layer
// equivalent): resolve the session, call ONE service method, translate the
// outcome into the discriminated RESULT the pane maps to its copy.
//
// ONE action, deliberately. The export's request→build→notify→download lifecycle
// is MOTIR-3701's and MOTIR-3703's; this file is only the door the pane's
// "Request export" control opens. The DELETION write (schedule / cancel,
// MOTIR-3700) is NOT here: it is driven from the confirmation ledger, which is
// MOTIR-3704's surface, and a destructive write must not acquire a door before
// the confirmation that gates it exists.

/**
 * A rate limit on the DOOR, not on the build.
 *
 * The service already refuses to start a second build while one is `preparing`
 * (it returns the open row instead), so a user cannot queue archives in
 * parallel. What that check cannot bound is a reader who waits for each build to
 * finish and immediately asks for another — which is the "somebody queueing
 * fifty of them" case `dataExportRequestRepository`'s own comment says belongs to
 * a service-side limit. Five requests an hour is far above any honest use of a
 * once-in-a-while export and far below anything that costs the blob store.
 *
 * Keyed by the AUTHENTICATED user id (not IP): more precise for a signed-in
 * action and not spoofable from the client. The id is hashed into the key rather
 * than stored in the clear (`lib/rateLimit/keys.ts`).
 */
const REQUEST_EXPORT_MAX = 5;
const REQUEST_EXPORT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export type RequestDataExportResult =
  | { ok: true; started: boolean }
  | { ok: false; code: 'RATE_LIMITED' | 'FAILED' };

/**
 * Open a personal-data export request for the signed-in reader and kick off its
 * background build (design DECISION 1/2 · MOTIR-3701).
 *
 * `started: false` is a SUCCESS, not a refusal: it means an open request already
 * existed and was returned instead of a second one being created. The pane
 * renders the same `preparing` state either way, which is the honest answer —
 * the reader asked for an export and there is one being built.
 *
 * `revalidatePath` re-runs the pane's server read so the export card repaints
 * from the new row. The card is a client island seeded from server props, so it
 * ALSO holds the returned state optimistically (CLAUDE.md's page-state contract:
 * a refresh cannot reach a `useState` initializer).
 */
export async function requestDataExportAction(): Promise<RequestDataExportResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const limit = await consumeRateLimit(
    'account:data-export',
    [session.user.id],
    REQUEST_EXPORT_MAX,
    REQUEST_EXPORT_WINDOW_MS,
  );
  if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

  try {
    const { started } = await dataExportService.requestDataExport(session.user.id);
    revalidatePath(DATA_PRIVACY_PANE_PATH);
    return { ok: true, started };
  } catch {
    // The request row is the only thing this action writes, and the build is a
    // background job that records its OWN failure on the row (the service marks
    // it `failed` rather than throwing, so the pane can show DECISION 2's
    // failed state). So a throw here means the row was never opened, and the
    // honest answer to the reader is "we could not start it", not a spinner.
    return { ok: false, code: 'FAILED' };
  }
}
