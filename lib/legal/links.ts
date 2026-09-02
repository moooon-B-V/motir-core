import 'server-only';
import { getLegalDocument, listLegalDocuments } from './documents';

// WHERE THE LEGAL LINKS POINT (Story MOTIR-3909 · MOTIR-4010).
//
// Three shipped surfaces used to hard-code a `/legal` path, because the
// documents were pages this application served. They are configuration now
// (`docs/decisions/public-surface-hosts.md` AMENDMENT 2 §C), and every one of
// them is an ABSOLUTE url on whatever host the operator publishes. So each
// surface asks a question this module answers, and each answer is NULLABLE —
// `null` is the unconfigured build, which is the common case for the open
// product and the arm the design draws (`design/auth/legal-agreement.mock.html`
// panels 12–14).
//
// It is `server-only` because the manifest is a server-side read. The three
// surfaces are client components, so their SERVER callers resolve these and pass
// the results down as props — which is also what keeps a client bundle from
// carrying the operator's document list.

/** The absolute url of one document, or `null` when it is not configured. */
export function legalDocumentUrl(slug: string): string | null {
  return getLegalDocument(slug)?.url ?? null;
}

/**
 * Both links the sign-up notice needs, or `null` when it should not render.
 *
 * ⚠️ BOTH OR NEITHER, and that is a decision rather than a convenience. The
 * notice is one sentence naming two documents — *"you agree to our Terms of
 * Service and Privacy Policy"* — so a build that has configured one of them
 * cannot render a half-linked version of it without asserting agreement to a
 * document nobody published. That is the same falseness AMENDMENT 2 §D rejects
 * for the unconfigured case, in a narrower form, and it gets the same answer:
 * the paragraph does not render.
 */
export function signUpLegalLinks(): { termsUrl: string; privacyUrl: string } | null {
  const termsUrl = legalDocumentUrl('terms');
  const privacyUrl = legalDocumentUrl('privacy');
  return termsUrl && privacyUrl ? { termsUrl, privacyUrl } : null;
}

/**
 * Where the rail's `Legal` row points, or `null` when it should not render.
 *
 * ⚠️ IT IS DERIVED, AND THE DERIVATION IS THE INTERESTING PART. The manifest is
 * a flat array of documents; it carries no index url, because AMENDMENT 2 §C's
 * field set is per-DOCUMENT. But the rail row is a door to the SET, so it needs
 * one — and the honest way to get it without widening the operator's
 * configuration is to read it off the urls they already supplied.
 *
 * So: if every configured url is `<base>/<slug>`, the index is `<base>`. That
 * holds for the hosted arrangement (`https://motir.co/legal/<slug>`) and for any
 * operator who publishes a document SET at one place, which is what having an
 * index means.
 *
 * **Where it does not hold, the row is ABSENT rather than guessed.** An operator
 * publishing at unrelated addresses — `acme.com/terms-of-service`,
 * `legal.acme.com/privacy` — has no index for this row to point at, and
 * inventing one would send a reader somewhere nobody published. Sign-up and the
 * re-consent rows still link each document directly, so nothing is unreachable;
 * what is missing is a single door, which is exactly what is missing in reality.
 *
 * A single configured document yields an index too — one document at
 * `<base>/<slug>` is still a set of one published at `<base>`.
 */
export function legalIndexUrl(): string | null {
  const documents = listLegalDocuments();
  if (documents.length === 0) return null;

  const bases = new Set<string>();
  for (const doc of documents) {
    const suffix = `/${doc.slug}`;
    // A url that does not end in its own slug is not part of a `<base>/<slug>`
    // set at all, so it cannot contribute a base and it disqualifies the
    // derivation rather than being skipped — a row pointing at the base of SOME
    // of the documents is worse than no row.
    if (!doc.url.endsWith(suffix)) return null;
    bases.add(doc.url.slice(0, -suffix.length));
  }
  return bases.size === 1 ? [...bases][0]! : null;
}
