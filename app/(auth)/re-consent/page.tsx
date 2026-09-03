import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { legalAcceptanceService } from '@/lib/services/legalAcceptanceService';
import { getLegalDocument } from '@/lib/legal/documents';
import { sanitizeNextPath } from '@/lib/navigation/nextDestination';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';
import { ReconsentCard } from './_components/ReconsentCard';
import { ReconsentDeferred } from './_components/ReconsentDeferred';

/**
 * THE RE-CONSENT INTERSTITIAL (Story 8.4 · Subtask MOTIR-1135 · design
 * `design/auth/legal-agreement.mock.html`, panels 5–8).
 *
 * Nobody navigates here — they are HELD on their way somewhere by
 * `lib/legal/reconsentGate.ts`, because `motir.co/legal/terms` §14 promises
 * that we *"will not treat silence as agreement to a material change"*.
 *
 * ⚠️ IT WEARS THE `(auth)` FRAME, NOT THE APP SHELL, and that is the same
 * reasoning `two-factor-required.mock.html`'s notes record: drawing a hold
 * inside the app shell advertises everything the person cannot reach, and a
 * shell that renders is a shell whose data was loaded. Living in `(auth)` also
 * makes the gate structurally unable to redirect into itself — this route is not
 * under any of the three gated groups, so no exemption list is needed and none
 * can fall behind.
 *
 * Three states, and the page is a SERVER shell that decides which (MOTIR-3372's
 * split: the route resolves, the island renders):
 *
 *   1. **Signed out** → the DEFERRED screen (panel 8). This is where "Not now —
 *      sign out" lands, and it must render with no session at all: telling
 *      somebody nothing has changed is worthless if they are bounced to sign-in
 *      to hear it.
 *   2. **Signed in with nothing outstanding** → redirect onward. A reader who
 *      lands here by typing the URL, or who agreed in another tab, is never
 *      stranded on a screen with nothing to accept.
 *   3. **Signed in and held** → the card (panels 5–7).
 *
 * ⚠️ THE PAGE RE-DERIVES THE HOLD RATHER THAN TRUSTING THE REDIRECT. The gate
 * decides whether to send somebody here; this page decides what they see, from
 * its own read. Nothing about the hold travels in the URL — no slug list, no
 * version — so a hand-edited address cannot make the screen claim a document
 * moved when it did not.
 */
export default async function ReconsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Where they were going, forwarded by the gate. Already sanitized once when it
  // was written; sanitized again here because it has been through a URL in
  // between, and the destination of a `redirect()` is not a value to take on
  // trust twice (`lib/navigation/nextDestination.ts`).
  const destination = sanitizeNextPath(params['next']) ?? AUTHED_LANDING_PATH;

  const session = await getSession();
  if (!session) {
    // The deferred screen links the reader to the Terms without signing in, so
    // it needs the document's title, version and url — a manifest read
    // (MOTIR-4007), with no session and no database behind it. `null` if the
    // manifest does not carry it; the row simply does not render, and the screen
    // still says the thing it exists to say.
    const terms = getLegalDocument('terms');
    return (
      <ReconsentDeferred
        terms={terms ? { title: terms.title, version: terms.version, url: terms.url } : null}
      />
    );
  }

  const outstanding = await legalAcceptanceService.resolveOutstanding(session.user.id);
  if (outstanding.length === 0) redirect(destination);

  return <ReconsentCard documents={outstanding} destination={destination} />;
}
