// THE CLOSE-OUT ARTIFACT-EVIDENCE CHECK (MOTIR-2709) — the other half of
// `isOrderingCheckExempt` (`lib/workItems/proseVsGraph.ts`).
//
// ── The gap this closes ─────────────────────────────────────────────────────
// A `type: 'deploy'` card's deliverable is an artifact somewhere OUTSIDE this
// repository — a tag on a registry, an image in a namespace, a package on npm.
// Every other card ends in a diff the system holds; this one ends in a claim.
//
// `deploy` is also the one type EXEMPT from the mechanized authoring gate — and
// correctly so: gate 14's ordering remedy is to cut post-merge criteria ONTO a
// `deploy` card, so the release leg would otherwise fire on every plan. Exempt
// when written and unchecked when closed, the two facts compose into a card type
// that can reach `done` with nothing behind it. Three cards did (MOTIR-2539 with
// zero comments against two criteria that required recording the version and its
// integrity; two sandbox images that "sat `done` for days in exactly that state").
//
// ── Why a string match and not a judgement ──────────────────────────────────
// `notes.html`'s ORDERING-limb entry records the precedent in its own words: the
// remedy for a check that needs no judgement is to replace the smell test with a
// string match, and — the part that matters here — the checks that fire are the
// ones where *something executes them*. The `likely-missing-edge` advisory works
// because it is code computed server-side; four sharpenings of the same prose
// gate did not. So the question asked here is deliberately small. Not "was this
// released properly", which is a judgement, but "does any comment on this card
// carry a version number or a digest", which is a scan.
//
// It will not catch a fabricated hash. It does not need to: nobody has ever
// fabricated one, and three people have closed a card having recorded nothing.
//
// ── Pure by construction ────────────────────────────────────────────────────
// No Prisma, no service imports — the caller passes comment BODIES in and gets a
// verdict out, so the whole rule is unit-testable against literals (including
// the two real incident fixtures) with no database.

/** Which shape of identifier satisfied the check. */
export type ArtifactEvidenceKind = 'digest' | 'integrity' | 'semver';

export interface ArtifactEvidence {
  kind: ArtifactEvidenceKind;
  /** The matched token, verbatim — so a caller can quote WHAT satisfied it. */
  match: string;
}

/**
 * The three accepted forms, most specific FIRST so a body carrying both a digest
 * and a version is reported as the digest.
 *
 * Each is deliberately permissive about its surroundings and strict about its
 * own shape: the cost of a false NEGATIVE is refusing a transition somebody is
 * entitled to make, which is the one failure that would train readers to route
 * around the gate.
 */
export const ARTIFACT_EVIDENCE_MATCHERS: readonly {
  readonly kind: ArtifactEvidenceKind;
  readonly re: RegExp;
}[] = [
  // `ghcr.io/moooon-b-v/motir-ci-runner@sha256:446c692d…` — the registry digest
  // the artifact-obtainable check tells a run to quote. Truncated digests are
  // accepted (12 hex is already past coincidence) because they get abbreviated
  // in prose more often than not.
  { kind: 'digest', re: /\bsha(?:256|512):[0-9a-f]{12,}\b/i },
  // `sha512-Rn7…==` — npm's `integrity` field, and the SRI form generally. The
  // prefix alone is close to conclusive; the length floor keeps a bare mention
  // of the ALGORITHM from counting.
  { kind: 'integrity', re: /\bsha(?:256|384|512)-[A-Za-z0-9+/]{20,}={0,2}/ },
  // `0.3.0`, `v1.12.4`, `cli-v0.2.1-rc.1` — the version a consumer installs.
  { kind: 'semver', re: /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?\b/ },
];

/**
 * The FIRST artifact identifier in `bodies`, or `null` when none carries one.
 *
 * Bodies are scanned in the order given (oldest comment first, as the repository
 * returns them); within a body the matchers run most-specific first.
 */
export function findArtifactEvidence(bodies: readonly string[]): ArtifactEvidence | null {
  for (const body of bodies) {
    if (!body) continue;
    for (const { kind, re } of ARTIFACT_EVIDENCE_MATCHERS) {
      const found = re.exec(body);
      if (found) return { kind, match: found[0] };
    }
  }
  return null;
}

/**
 * The exemption marker. Some `deploy` deliverables genuinely have no identifier
 * — a DNS cutover, a console toggle, a support ticket closed by somebody else's
 * system — and a check whose firing set is wider than the defect set trains
 * readers to route around it.
 *
 * ⚠️ This is an EXEMPTION, not a mute, and the difference is that it is written
 * down. The declaration lives where the evidence would have: a comment on the
 * card, authored by a person, timestamped, permanent, and findable afterwards by
 * this exact literal (`commentRepository.someBodyReferences(id, NO_ARTIFACT_MARKER)`).
 * So the escape hatch still costs what the gate is really asking for — that
 * somebody state, on the record, what closing this card means. A free-text
 * override nobody records would be the same failure with an extra step.
 */
export const NO_ARTIFACT_MARKER = 'NO ARTIFACT:';

/**
 * The reason must be a real one. Long enough to force a phrase ("DNS cutover",
 * "console toggle only") rather than the reflex `n/a`, short enough not to make
 * an honest declaration a writing exercise.
 */
export const MIN_EXEMPTION_REASON_LENGTH = 8;

/**
 * The marker anchored to the start of a LINE, tolerating the markdown a comment
 * is actually written in (`> `, `- `, `**NO ARTIFACT:**`). Anchoring matters:
 * a comment *discussing* the rule ("the check looks for NO ARTIFACT:") must not
 * exempt the card it is written on.
 */
const NO_ARTIFACT_DECLARATION_RE = new RegExp(
  String.raw`^[\s>*_-]*` + NO_ARTIFACT_MARKER.replace(':', String.raw`:\**`) + String.raw`\s*(.+)$`,
  'im',
);

/** Trailing markdown emphasis on the captured reason (`**…**`, `_…_`). */
const TRAILING_EMPHASIS_RE = /[*_\s]+$/;

/**
 * The declared no-artifact exemption in `bodies`, or `null` when none of them
 * declares one with a substantive reason.
 */
export function findNoArtifactDeclaration(bodies: readonly string[]): { reason: string } | null {
  for (const body of bodies) {
    if (!body) continue;
    const found = NO_ARTIFACT_DECLARATION_RE.exec(body);
    if (!found?.[1]) continue;
    const reason = found[1].replace(TRAILING_EMPHASIS_RE, '').trim();
    if (reason.length >= MIN_EXEMPTION_REASON_LENGTH) return { reason };
  }
  return null;
}

/**
 * Whether a card is IN the check's firing set — `type: 'deploy'`, and nothing
 * else.
 *
 * ⚠️ The mirror of {@link isOrderingCheckExempt}, and named for the same reason:
 * the firing set is a stated predicate with its own test, not a condition inlined
 * at the call site where a later reader has to reconstruct the intent.
 *
 * `executor: 'human'` is deliberately NOT here, though it IS on the authoring
 * side's exemption. There the pair is the rule's own remedy read back; here a
 * human cutting a release by hand is the exact case that failed — MOTIR-2539 was
 * closed by a person, not by a runner.
 */
export function requiresArtifactEvidence(type: string | null | undefined): boolean {
  return type === 'deploy';
}

/**
 * The verdict for a card in the firing set. Three outcomes, deliberately: a
 * caller must be able to tell "somebody recorded the artifact" from "somebody
 * recorded that there ISN'T one", because only the second is an exemption and
 * only exemptions are worth auditing later.
 */
export type ArtifactEvidenceVerdict =
  | { outcome: 'satisfied'; evidence: ArtifactEvidence }
  | { outcome: 'exempt'; reason: string }
  | { outcome: 'missing' };

/**
 * Assess a card's comment bodies for close-out evidence.
 *
 * EVIDENCE WINS OVER THE DECLARATION. A card carrying both a digest and a
 * "NO ARTIFACT" line published something, whatever a later comment says about
 * it, and reporting the exemption there would put a card into the audit set that
 * does not belong in it.
 */
export function assessArtifactEvidence(bodies: readonly string[]): ArtifactEvidenceVerdict {
  const evidence = findArtifactEvidence(bodies);
  if (evidence) return { outcome: 'satisfied', evidence };
  const declared = findNoArtifactDeclaration(bodies);
  if (declared) return { outcome: 'exempt', reason: declared.reason };
  return { outcome: 'missing' };
}
