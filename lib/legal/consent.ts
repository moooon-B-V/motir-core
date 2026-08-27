import { type LegalDocument } from './documents';

// WHAT A PERSON AGREED TO, AND WHEN THEY HAVE TO BE ASKED AGAIN
// (Story 8.4 · Subtask MOTIR-1135 · design `design/auth/legal-agreement.mock.html`).
//
// This module is PURE — no filesystem, no database, no environment. It takes the
// documents as they stand and the acceptances a person holds, and answers one
// question: which documents must they be shown before they can carry on. The
// gate (`lib/legal/reconsentGate.ts`) supplies both inputs; the service
// (`lib/services/legalAcceptanceService.ts`) records the answer.
//
// Everything decided here is decided by a document we are already bound by
// rather than by this file. Where that is so, the clause is quoted.

/**
 * THE RE-CONSENT SET — three of the seven published documents.
 *
 * ⚠️ NOT "every document in `content/legal/`". Comparing all seven asks every
 * user to re-agree whenever a factual roster is corrected, and four of them are
 * excluded on a ground that is PUBLISHED in a document we are bound by, not on a
 * judgement made here:
 *
 *   * **Cookie Policy** — no cookie consent is sought at all (every cookie is
 *     strictly necessary or a preference the reader set, under the ePrivacy
 *     Art. 5(3) exemption), so there is nothing to re-accept. A future
 *     non-essential cookie brings a BANNER, which that document itself promises.
 *   * **Subprocessors** — `content/legal/terms.md` §14 names *"a new
 *     sub-processor already covered by the Privacy Policy"* as its example of a
 *     NON-material change that *"takes effect when published"*. DPA customers get
 *     DPA §6's thirty-day objection window instead: a bilateral notice, not an
 *     app-wide hold.
 *   * **Data Processing Agreement** — a template, offered on request and signed
 *     bilaterally. Not part of what an individual accepts at sign-up, and amended
 *     with the customer who signed it through its own §6 / §11.
 *   * **Model providers** — `docs/decisions/legal-document-set.md` §7 (amended
 *     2026-08-27): a factual roster that varies no commitment and *"carries no
 *     notice period"*.
 *
 * The three that ARE here are the agreement itself. `terms.md` §15 makes the
 * Terms, the Acceptable Use Policy and the Privacy Policy the whole agreement;
 * `acceptable-use.md`'s own header says it *"forms part of the Terms of
 * Service"*; `privacy.md` §12 promises that *"where the change affects the terms
 * you accepted, you will be asked to review them"*.
 *
 * ⚠️ THIS IS A CLOSED LIST ON PURPOSE, and it is the ONE place in the legal
 * module that enumerates slugs — `documents.ts` treats the directory as the
 * registry precisely so nothing has to. The difference is what the list is FOR:
 * there, a missing slug 404s a published page (a list that can hide a document);
 * here, an unlisted document simply never holds anybody up (a list that can only
 * ask for LESS). Adding a document to `content/legal/` must not silently start
 * gating the whole product on it.
 */
export const RECONSENT_DOCUMENT_SLUGS = ['terms', 'privacy', 'acceptable-use'] as const;

export type ReconsentSlug = (typeof RECONSENT_DOCUMENT_SLUGS)[number];

/** True when `slug` is one of the three documents re-consent is asked for. */
export function isReconsentDocument(slug: string): slug is ReconsentSlug {
  return (RECONSENT_DOCUMENT_SLUGS as readonly string[]).includes(slug);
}

/** A parsed semver triple. `null` for anything that is not one. */
export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a front-matter `version:` string into its three components.
 *
 * Strict on purpose: exactly three dot-separated runs of digits, nothing else.
 * A version that does not parse is not guessed at — every caller below treats
 * `null` as *"I cannot tell what changed"*, and the safe answer to that is to
 * ASK, which is what {@link isMaterialChange} does.
 */
export function parseSemanticVersion(raw: string | null | undefined): SemanticVersion | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * ⚠️ THE TRIGGER IS MATERIALITY, NOT A VERSION COMPARISON.
 *
 * `content/legal/terms.md` §14 promises that non-material changes —
 * *"clarifications, corrections, a new sub-processor already covered by the
 * Privacy Policy"* — **take effect when published**, with no prompt. A bare
 * `current > accepted` over the version string therefore breaks a clause in the
 * published contract every time somebody fixes a typo, and holds the entire
 * signed-in product for it.
 *
 * The convention that carries the promise needs no new field, because the front
 * matter already carries semver:
 *
 *   * **MAJOR or MINOR bump ⇒ MATERIAL.** Prompts.
 *   * **PATCH bump ⇒ NON-MATERIAL.** Takes effect when published. Silent.
 *
 * Four cases that are not a bump at all, each decided rather than incidental:
 *
 *   * **Never accepted** (`accepted` is null) — material. There is no agreement
 *     on record, which is the strongest reason to ask there is.
 *   * **Unchanged, or the reader is AHEAD** — not material. A version that went
 *     backwards is a mistake in the repository, and holding every signed-in
 *     reader out of the product is not how it gets fixed.
 *   * **Either side unparseable** — MATERIAL, deliberately. This is the one place
 *     the module fails towards asking rather than towards silence: a version
 *     string nobody can read is a version whose materiality nobody can rule out,
 *     and the cost of being wrong is an extra prompt rather than a person bound
 *     by a clause they were never shown. `tests/legal/legalVersionGuard.test.ts`
 *     keeps the published set parseable so this arm stays unreachable in
 *     practice.
 */
export function isMaterialChange(
  acceptedVersion: string | null | undefined,
  currentVersion: string | null | undefined,
): boolean {
  if (acceptedVersion == null) return true;

  const accepted = parseSemanticVersion(acceptedVersion);
  const current = parseSemanticVersion(currentVersion);
  if (!accepted || !current) return true;

  if (current.major !== accepted.major) return current.major > accepted.major;
  if (current.minor !== accepted.minor) return current.minor > accepted.minor;
  // Same major AND minor: whatever moved was a patch, and §14 says a patch takes
  // effect when published.
  return false;
}

/** One document a person must re-accept, with what they last agreed to. */
export interface OutstandingDocument {
  slug: string;
  title: string;
  /** The version now published — what they are being asked to accept. */
  currentVersion: string;
  /**
   * The version they last accepted, or `null` when they never accepted this
   * document at all. The interstitial draws `1.0.0 → 2.0.0` from the pair and
   * omits the arrow when this is null, so a brand-new document reads as new
   * rather than as a delta from nothing.
   */
  acceptedVersion: string | null;
  /** The author's sentence about what moved, when there is one. */
  changeSummary: string | null;
  /** When the new version comes into force, or `null` while it is not yet set. */
  effectiveDate: string | null;
}

/** What one person has already agreed to, as the gate reads it out of the table. */
export interface HeldAcceptance {
  documentSlug: string;
  version: string;
  acceptedAt: Date;
}

/**
 * The documents this person must be shown before they can carry on — empty when
 * there are none, which is the overwhelmingly common answer and the one the gate
 * is optimised for.
 *
 * `held` may carry several rows per document (the table is append-only, so it
 * carries the person's whole history); the LATEST accepted version per document
 * is what counts, and latest is decided by `acceptedAt` rather than by comparing
 * versions — the record is of what happened, and a person who somehow accepted
 * `1.0.0` after `2.0.0` has, as a matter of fact, most recently accepted `1.0.0`.
 *
 * Documents come back in {@link RECONSENT_DOCUMENT_SLUGS} order, which is the
 * order the interstitial lists them in: the Terms first, because it is the
 * contract the other two hang off.
 */
export function outstandingReconsent(
  documents: readonly LegalDocument[],
  held: readonly HeldAcceptance[],
): OutstandingDocument[] {
  const latestBySlug = new Map<string, HeldAcceptance>();
  for (const acceptance of held) {
    const previous = latestBySlug.get(acceptance.documentSlug);
    if (!previous || acceptance.acceptedAt > previous.acceptedAt) {
      latestBySlug.set(acceptance.documentSlug, acceptance);
    }
  }

  const outstanding: OutstandingDocument[] = [];
  for (const slug of RECONSENT_DOCUMENT_SLUGS) {
    const document = documents.find((candidate) => candidate.slug === slug);
    // A document in the re-consent set that is not in `content/legal/` cannot be
    // read, linked or agreed to, so it holds nobody. That is the safe direction:
    // the alternative is a hold nobody can clear. `tests/legal/legalVersionGuard.test.ts`
    // is what makes the absence loud instead.
    if (!document) continue;

    const accepted = latestBySlug.get(slug) ?? null;
    if (!isMaterialChange(accepted?.version ?? null, document.version)) continue;

    outstanding.push({
      slug: document.slug,
      title: document.title,
      currentVersion: document.version,
      acceptedVersion: accepted?.version ?? null,
      changeSummary: document.changeSummary,
      effectiveDate: document.effectiveDate,
    });
  }
  return outstanding;
}
