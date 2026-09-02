import { NextResponse } from 'next/server';
import { legalManifestState } from '@/lib/legal/documents';

// GET /api/health/legal (MOTIR-4007) — WHAT THIS DEPLOYMENT'S LEGAL
// CONFIGURATION IS, readable from outside it.
//
// ⚠️ WHY IT EXISTS, AND WHY IT IS THE HALF THAT MATTERS.
// `docs/decisions/public-surface-hosts.md` AMENDMENT 2 §C decides that a
// malformed manifest entry is REJECTED — it never reaches a consumer, because
// `consent.ts` treats an unparseable version as material and would otherwise hold
// every signed-in reader at `/re-consent`. Rejecting it is right and rejecting it
// SILENTLY is the failure MOTIR-3909 exists to prevent, reached from the other
// side: a legal gate that quietly stops holding people looks exactly like one
// that has nobody to hold.
//
// So §C requires the rejection to be LOUD, and loud has three parts. The error
// log is one. **This route is the other two: `unconfigured` and `faulted` can
// never render as the same state, and a fault on one of the three RE-CONSENT
// documents is named separately** — because that is the case where the gate
// stops asking about a document it is supposed to gate on.
//
// ⚠️ UNAUTHENTICATED, the same decision `/api/health/release` and
// `/api/health/queue` record (`permission-inventory.md` R57): the consumer is an
// external monitor whose job is to reach this while the deployment is degraded,
// and every credential it would carry is one more thing that can be wrong at
// three in the morning. What makes it safe here is what it discloses — a status
// word, a count, and the SLUGS and FIELD NAMES of entries that failed to parse.
// It carries no document text, no url and no version, so a reader learns that a
// configuration is broken and nothing about what it says.
//
// ⚠️ THE HTTP STATUS CARRIES THE VERDICT, so a monitor that reads nothing but the
// status code still works — the same contract `/api/health/release` states, and
// for the same reason: a check configured against a body it has to parse
// silently stops meaning anything when the shape moves.
//
//   200  `configured`   — a manifest is set and every entry is usable
//   200  `unconfigured` — no manifest, which is CORRECT for a self-hosted build
//   503  `faulted`      — a manifest is set and something in it was refused
//
// **`unconfigured` is a 200 on purpose.** It is not a degraded state: a team
// running Motir for themselves has published no legal documents and the feature
// is ABSENT, which is the line the whole epic draws. Answering 503 would page
// somebody about a deployment that is working exactly as intended — and, worse,
// would train a reader to ignore the one status that means something is wrong.
//
// Thin transport per `CLAUDE.md`: ONE read, and the mapping to a status.

/** Never cached. A cached answer about a live configuration is worse than none. */
export const dynamic = 'force-dynamic';

/**
 * The documents whose absence STOPS THE GATE ASKING, rather than merely dropping
 * a link. Spelled here rather than imported from `lib/legal/consent.ts` so that
 * this route — a leaf transport — does not pull the consent module into a request
 * path that has nothing to do with consent; the list is asserted against the
 * exported constant by this route's own test, so the two cannot drift.
 */
const RECONSENT_SLUGS = ['terms', 'privacy', 'acceptable-use'];

export async function GET() {
  const { status, documents, faults } = legalManifestState();

  // The separately-named condition §C asks for: a refused entry that one of the
  // three re-consent documents was going to be. Everything else is a link that
  // will not render; this is a promise that stops being kept.
  const reconsentFaults = faults
    .filter((fault) => RECONSENT_SLUGS.includes(fault.entry))
    .map((fault) => fault.entry);

  return NextResponse.json(
    {
      status,
      documentCount: documents.length,
      faults: faults.map(({ entry, field, reason }) => ({ entry, field, reason })),
      // Present and empty on a healthy read, so a monitor can assert on the KEY
      // rather than on its absence.
      reconsentDocumentsAffected: [...new Set(reconsentFaults)],
    },
    { status: status === 'faulted' ? 503 : 200 },
  );
}
