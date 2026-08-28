import { describe, expect, it } from 'vitest';
import { listLegalDocuments } from '@/lib/legal/documents';
import {
  RECONSENT_DOCUMENT_SLUGS,
  type ReconsentSlug,
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
//
// ── ⚠️ THE TRIPWIRE WAS DEAD FOR ITS WHOLE LIFE (MOTIR-3806) ────────────────
// The case that carried flag 1's actual ask used to read
// `expect(isMaterialChange(document?.version, document?.version)).toBe(false)` —
// a version compared with ITSELF. `isMaterialChange` returns `false` whenever
// major and minor are equal, which they always are when a value is compared with
// itself, so the expectation could not fail for any version, on any revision,
// ever. It was described in this file as *"a statement of the CURRENT state"*;
// it was a statement of nothing. MOTIR-3705 shipped the first real revision of a
// published document (`privacy.md` 1.0.0 → 1.1.0, PR #2427) — the exact event the
// case existed to catch — and it stayed green.
//
// The repair is the PINNED BASELINE below. Both arguments are now independent
// values: a constant a human maintains, and the version parsed out of the file.
// That comparison genuinely fails on the next material bump, which is the point —
// the failure IS the prompt to read the diff and confirm the component.
//
// ── THE PINNED BASELINE ─────────────────────────────────────────────────────
/**
 * The version of each re-consent document that a person has last read a diff for
 * and confirmed the semver component of.
 *
 * ⚠️ It is a COPY of `content/legal/`, taken deliberately — never derived from
 * it. The two diverging is the whole signal; a baseline read out of the same
 * front matter it is checked against would be the tautology again in a new shape.
 *
 * **WHEN IT IS UPDATED:** only in the pull request that ships a revision, and
 * only after somebody has read that diff and decided whether what moved was
 * material (MAJOR / MINOR) or not (PATCH). Editing this map IS that decision
 * being recorded. Bumping it to clear a red test without making that read puts
 * the tripwire back exactly where MOTIR-3806 found it.
 *
 *   * **`terms` · `acceptable-use` at `1.0.0`** — the launch set as approved
 *     (`content(legal): approve the launch document set`, PR #2336). Neither has
 *     been revised since.
 *   * **`privacy` at `1.1.0`** — MOTIR-3705 widened §6 to cover work-item
 *     attribution anonymisation, and recorded the component on the record:
 *     *"version 1.0.0 -> 1.1.0 — MINOR, i.e. MATERIAL, so re-consent prompts."*
 *     (PR #2427). That is the read this baseline is the receipt for.
 */
const REVIEWED_BASELINE: Record<ReconsentSlug, string> = {
  terms: '1.0.0',
  privacy: '1.1.0',
  'acceptable-use': '1.0.0',
};

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

  it('has published no material revision the baseline has not been read against', () => {
    // THE TRIPWIRE. The published version is compared against the PINNED
    // baseline above — two independent values, which is the whole difference
    // from the assertion this replaced. It goes red the moment a MAJOR or MINOR
    // bump lands without `REVIEWED_BASELINE` moving with it, and the failure is
    // the prompt to check that the component chosen matches what actually moved.
    //
    // A PATCH bump passes, deliberately: `terms.md` §14 says a patch takes
    // effect when published, so a patch is not something a person has to be
    // stopped for. The residual risk stated above — a MATERIAL change shipped AS
    // a patch — is not reachable from here and stays accepted, for the reason
    // written there: only a human reading the diff can tell.
    for (const slug of RECONSENT_DOCUMENT_SLUGS) {
      const document = documents.find((candidate) => candidate.slug === slug);
      expect(document, `${slug} is published`).toBeDefined();
      expect(
        isMaterialChange(REVIEWED_BASELINE[slug], document?.version),
        `${slug}: published ${document?.version} is a material move past the reviewed ` +
          `baseline ${REVIEWED_BASELINE[slug]}. Read the diff, decide whether the component ` +
          `matches what moved, then record that read by updating REVIEWED_BASELINE.`,
      ).toBe(false);
    }
  });

  it('CAN fail — a version above each baseline is reported material', () => {
    // THE MUTATION CHECK, and it is the half MOTIR-3806 was missing rather than
    // an extra. The assertion above only ever exercises the PASSING direction,
    // and a guard exercised in one direction is indistinguishable from a guard
    // that cannot fail — which is precisely how a tautology sat here being
    // counted as coverage. So the same call, on the same baselines, must come
    // back `true` for a minor bump and `false` for a patch: proving it fires,
    // and proving it still discriminates rather than having become "always ask".
    for (const slug of RECONSENT_DOCUMENT_SLUGS) {
      const baseline = REVIEWED_BASELINE[slug];
      const parsed = parseSemanticVersion(baseline);
      if (!parsed) throw new Error(`${slug} baseline ${baseline} is not a semantic version`);

      const materialBump = `${parsed.major}.${parsed.minor + 1}.0`;
      const patchBump = `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;

      const material = isMaterialChange(baseline, materialBump);
      expect(material, `${slug}: ${baseline} → ${materialBump} must prompt`).toBe(true);

      const patch = isMaterialChange(baseline, patchBump);
      expect(patch, `${slug}: ${baseline} → ${patchBump} must stay silent`).toBe(false);
    }
  });
});
