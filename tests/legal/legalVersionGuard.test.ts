import { describe, expect, it } from 'vitest';
import { listLegalDocuments } from '@/lib/legal/documents';
import {
  RECONSENT_DOCUMENT_SLUGS,
  isMaterialChange,
  parseSemanticVersion,
} from '@/lib/legal/consent';

// THE MATERIALITY SIGNAL, GUARDED (Story 8.4 · Subtask MOTIR-1135).
//
// `design/auth/design-notes.md`'s planning flag 1 puts this squarely on this
// card and refuses to let it stay implicit:
//
//   *"The materiality signal has to be WRITTEN somewhere, and today it is not.
//    The semver convention is the cheapest form — it needs no new field, and
//    `lib/legal/documents.ts` already parses `version`. But nothing enforces
//    that an author bumps the right component, and the whole promise rides on
//    it. Either MOTIR-1135 adds the check to `tests/legal/`, or the risk is
//    accepted and written down. Do not leave it implicit."*
//
// This file is the DISPOSITION, and it is both halves rather than one:
//
// ── WHAT IS MECHANICALLY GUARANTEED HERE ────────────────────────────────────
// Every published document carries a version the convention can actually READ,
// and every document the re-consent set names actually EXISTS. Those are the two
// failures that would break the mechanism silently rather than loudly, and they
// are checkable against the real `content/legal/` tree.
//
// ── ⚠️ WHAT IS NOT, STATED PLAINLY RATHER THAN LEFT TO BE DISCOVERED ────────
// **Nothing here can tell whether a bump names the right component.** Only a
// human reading the diff knows whether a change was a clarification or a new
// obligation, and a test that guessed from diff SIZE would be a coin flip
// wearing a green tick — a one-line change can add an obligation and a
// thousand-line reformat can add none. So the residual risk is ACCEPTED, and
// this paragraph is where it is written down:
//
//   **Bumping MINOR for a typo fix over-asks** — every signed-in reader is held
//   at an interstitial for nothing. Recoverable: revert the version, and the
//   hold clears on the next page load.
//
//   **Bumping PATCH for a material change under-asks**, and that one is NOT
//   recoverable by a later edit: readers carried on in silence, which is exactly
//   what `content/legal/terms.md` §14 promises we will not treat as agreement.
//   The repair is a fresh MINOR bump, which asks everyone again.
//
// The asymmetry is the thing to remember when in doubt: **over-asking costs a
// screen, under-asking costs a promise.** Round up.
describe('the published legal set supports the materiality convention', () => {
  const documents = listLegalDocuments();

  it('has documents to check', () => {
    // A guard over an empty directory passes vacuously, which is the one way
    // this file could report health it never measured.
    expect(documents.length).toBeGreaterThan(0);
  });

  it('gives every published document a version the convention can read', () => {
    // `isMaterialChange` fails towards ASKING when it cannot parse a version —
    // the safe direction, but it means an unparseable string here would hold
    // every reader at the interstitial for ever, with no bump able to clear it.
    // This is the check that keeps that arm unreachable in production.
    const unreadable = documents
      .filter((document) => parseSemanticVersion(document.version) === null)
      .map((document) => `${document.slug}: ${JSON.stringify(document.version)}`);
    expect(unreadable).toEqual([]);
  });

  it('publishes every document the re-consent set names', () => {
    // A slug in the set with no file behind it holds nobody (by design — a hold
    // nobody can clear is worse), so the failure is SILENT: the mechanism would
    // simply stop asking about that document. Loud is better.
    const published = new Set(documents.map((document) => document.slug));
    const missing = RECONSENT_DOCUMENT_SLUGS.filter((slug) => !published.has(slug));
    expect(missing).toEqual([]);
  });

  it('still publishes the four documents the set deliberately EXCLUDES', () => {
    // Each exclusion in `lib/legal/consent.ts` quotes a ground published in a
    // document we are bound by. If one of those documents stops existing, the
    // exclusion stops having a reason — and this test is what says so, rather
    // than the reasoning quietly outliving its source.
    const published = new Set(documents.map((document) => document.slug));
    for (const slug of ['cookies', 'dpa', 'subprocessors', 'model-providers']) {
      expect(published.has(slug), `${slug} is cited as an exclusion but no longer published`).toBe(
        true,
      );
    }
  });

  it('holds nobody today — the published set is all at its initial version', () => {
    // A statement of the CURRENT state rather than an invariant: nothing has
    // been revised since publication, so a person who accepted at sign-up is
    // current on all three. When the first real revision ships, this expectation
    // is the one that fails, and the failure is the prompt to check that the
    // component chosen matches what actually moved — which is the closest a test
    // can honestly get to flag 1's real ask.
    for (const slug of RECONSENT_DOCUMENT_SLUGS) {
      const document = documents.find((candidate) => candidate.slug === slug);
      expect(isMaterialChange(document?.version, document?.version)).toBe(false);
    }
  });
});
