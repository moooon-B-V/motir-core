import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_EVIDENCE_MATCHERS,
  MIN_EXEMPTION_REASON_LENGTH,
  NO_ARTIFACT_MARKER,
  assessArtifactEvidence,
  findArtifactEvidence,
  findNoArtifactDeclaration,
  requiresArtifactEvidence,
} from '@/lib/workItems/artifactEvidence';

// The close-out artifact-evidence rule (MOTIR-2709), tested where it is pure —
// bodies in, verdict out, no database.
//
// ⚠️ THE TWO INCIDENT FIXTURES BELOW ARE THE POINT OF THIS FILE. The rule is
// calibrated on the defect that motivated it rather than on invented input: the
// state MOTIR-2539 was closed in must FAIL, and the state MOTIR-2584 was closed
// in must PASS. Everything else here is the boundary work around those two.

/**
 * MOTIR-2539 — "Cut `cli-v0.2.1` and PULL it back", marked `done` with **zero
 * comments**, against two acceptance criteria that required recording the
 * version and its integrity on the card. No tag on the remote, no `0.2.1` on
 * npm. This empty array IS the incident.
 */
const MOTIR_2539_AT_CLOSE: readonly string[] = [];

/**
 * MOTIR-2584 — the same release cut correctly a day later. Excerpted VERBATIM
 * from the close-out comment on the live card (the version table and the
 * unauthenticated registry read), so the positive fixture is a real recorded
 * release rather than a plausible-looking one.
 */
const MOTIR_2584_AT_CLOSE: readonly string[] = [
  [
    '**Released. `@motir/cli@0.3.0` is on npm and pulls back clean.**',
    '',
    '## 5. Registry facts, from an unauthenticated shell',
    '',
    '```',
    "version         = '0.3.0'",
    "dist.integrity  = 'sha512-jEIbpb2rPPf7/DOxcXCjrunMGxstfxOaqsNyzZzD6M5c9mlIqgrZ+OAgAqwaCyq+AWZqIX+g0DgKhRhVidnNJQ=='",
    "dist.shasum     = '3d15eeb9cbc1e818b9126bd6abb3765dc871d5d6'",
    '```',
  ].join('\n'),
];

describe('requiresArtifactEvidence — the firing set', () => {
  it('fires on `deploy` and on nothing else', () => {
    expect(requiresArtifactEvidence('deploy')).toBe(true);
    for (const type of ['code', 'test', 'design', 'manual', 'chore', 'decision']) {
      expect(requiresArtifactEvidence(type)).toBe(false);
    }
  });

  it('treats an untyped card as outside the set', () => {
    expect(requiresArtifactEvidence(null)).toBe(false);
    expect(requiresArtifactEvidence(undefined)).toBe(false);
  });

  it('is a predicate of the TYPE alone — an executor cannot exempt a release', () => {
    // The deliberate divergence from `isOrderingCheckExempt`, which DOES exempt
    // `executor: 'human'`. There the pair is the ordering rule's own remedy read
    // back; here a person cutting a release by hand is the case that failed —
    // MOTIR-2539 was closed by a human, not by a runner. The predicate takes no
    // executor argument at all, so the divergence is structural, not a comment.
    expect(requiresArtifactEvidence.length).toBe(1);
  });
});

describe('findArtifactEvidence — the three accepted forms', () => {
  it('accepts a plain semver', () => {
    expect(findArtifactEvidence(['shipped 1.4.0 to production'])).toEqual({
      kind: 'semver',
      match: '1.4.0',
    });
  });

  it('accepts a `v`-prefixed tag and a prerelease', () => {
    expect(findArtifactEvidence(['tagged v0.2.1'])?.match).toBe('v0.2.1');
    expect(findArtifactEvidence(['cut 1.0.0-rc.2'])?.match).toBe('1.0.0-rc.2');
  });

  it('accepts a registry digest', () => {
    const body = 'pulled ghcr.io/moooon-b-v/motir-ci-runner@sha256:446c692d1f0a3b5c7e9d';
    expect(findArtifactEvidence([body])).toEqual({
      kind: 'digest',
      match: 'sha256:446c692d1f0a3b5c7e9d',
    });
  });

  it('accepts an npm integrity hash', () => {
    const found = findArtifactEvidence(['integrity sha512-jEIbpb2rPPf7/DOxcXCjrunMGxstfxOaqs==']);
    expect(found?.kind).toBe('integrity');
  });

  it('reports the MOST SPECIFIC form when a body carries several', () => {
    // A release comment nearly always carries both. Reporting `digest` rather
    // than the version that happens to appear first is what lets a caller quote
    // back the thing that actually identifies the artifact.
    const found = findArtifactEvidence(['released 0.3.0, digest sha256:446c692d1f0a3b5c7e9d']);
    expect(found?.kind).toBe('digest');
  });

  it('scans every comment, in the order given', () => {
    expect(findArtifactEvidence(['did the thing', 'no really', 'it is 2.0.0'])?.match).toBe(
      '2.0.0',
    );
  });

  it('finds nothing in prose that records no identifier', () => {
    expect(
      findArtifactEvidence([
        'Done — the lane is green and the workflow ran.',
        'Merged, see the CI run. Version 2 of the sandbox.',
        'The sha256 of the image is in the run log somewhere.',
      ]),
    ).toBeNull();
  });

  it('ignores empty bodies rather than matching on them', () => {
    expect(findArtifactEvidence(['', '   '])).toBeNull();
  });

  it('is stateless across calls — no `g`-flag lastIndex carry-over', () => {
    // The bug this pins: a `g`-flagged matcher shared at module scope advances
    // `lastIndex` on every hit, so the SECOND card checked in a process would be
    // scanned from an arbitrary offset and could be refused with evidence right
    // there in front of it.
    const body = ['released 1.2.3'];
    expect(findArtifactEvidence(body)).toEqual(findArtifactEvidence(body));
    for (const { re } of ARTIFACT_EVIDENCE_MATCHERS) expect(re.global).toBe(false);
  });
});

describe('findNoArtifactDeclaration — the stated exemption', () => {
  it('accepts the marker at the start of a line, with a substantive reason', () => {
    expect(findNoArtifactDeclaration(['NO ARTIFACT: DNS cutover, nothing to publish'])).toEqual({
      reason: 'DNS cutover, nothing to publish',
    });
  });

  it('tolerates the markdown a comment is actually written in', () => {
    expect(findNoArtifactDeclaration(['**NO ARTIFACT:** console toggle only'])?.reason).toBe(
      'console toggle only',
    );
    expect(findNoArtifactDeclaration(['> no artifact: DNS cutover in the registrar'])?.reason).toBe(
      'DNS cutover in the registrar',
    );
    expect(
      findNoArtifactDeclaration(['Closing this out.\n\nNO ARTIFACT: a console switch, no build'])
        ?.reason,
    ).toBe('a console switch, no build');
  });

  it('does NOT exempt a card whose comment merely DISCUSSES the marker', () => {
    // Anchoring earns its keep here: this card's own body quotes the marker, and
    // a mid-sentence match would exempt every card that talks about the rule.
    expect(
      findNoArtifactDeclaration(['the check looks for NO ARTIFACT: at the start of a line']),
    ).toBeNull();
  });

  it('refuses a reason too short to be one', () => {
    expect(findNoArtifactDeclaration(['NO ARTIFACT: n/a'])).toBeNull();
    expect(findNoArtifactDeclaration(['NO ARTIFACT:'])).toBeNull();
    const justLongEnough = 'x'.repeat(MIN_EXEMPTION_REASON_LENGTH);
    expect(findNoArtifactDeclaration([`${NO_ARTIFACT_MARKER} ${justLongEnough}`])?.reason).toBe(
      justLongEnough,
    );
  });
});

describe('assessArtifactEvidence — the verdict', () => {
  it('is `satisfied` when a comment records an artifact', () => {
    expect(assessArtifactEvidence(['published 1.4.0'])).toEqual({
      outcome: 'satisfied',
      evidence: { kind: 'semver', match: '1.4.0' },
    });
  });

  it('is `exempt` when a comment declares there is no artifact', () => {
    expect(assessArtifactEvidence(['NO ARTIFACT: DNS cutover at the registrar'])).toEqual({
      outcome: 'exempt',
      reason: 'DNS cutover at the registrar',
    });
  });

  it('is `missing` when the card says nothing either way', () => {
    expect(assessArtifactEvidence([])).toEqual({ outcome: 'missing' });
    expect(assessArtifactEvidence(['Done, merged.'])).toEqual({ outcome: 'missing' });
  });

  it('prefers EVIDENCE over a declaration when a card carries both', () => {
    // A card that published something published it, whatever a later comment
    // says — and only genuine exemptions belong in the audit set.
    const verdict = assessArtifactEvidence([
      'NO ARTIFACT: this one is a console toggle',
      'actually it did publish: 0.3.0',
    ]);
    expect(verdict.outcome).toBe('satisfied');
  });
});

describe('calibration against the real incidents (MOTIR-2709 AC4)', () => {
  it('REFUSES the state MOTIR-2539 was closed in — zero comments', () => {
    expect(assessArtifactEvidence(MOTIR_2539_AT_CLOSE)).toEqual({ outcome: 'missing' });
  });

  it('ACCEPTS the state MOTIR-2584 was closed in — version + integrity recorded', () => {
    const verdict = assessArtifactEvidence(MOTIR_2584_AT_CLOSE);
    expect(verdict.outcome).toBe('satisfied');
    // `integrity`, not `semver`: the npm `sha512-` hash is the strongest
    // identifier in that comment, and it is what a consumer can verify. (The
    // `dist.shasum` beside it is a bare hex with no algorithm prefix, which this
    // rule deliberately does not accept — unprefixed hex is indistinguishable
    // from a commit sha.)
    expect(verdict).toMatchObject({ evidence: { kind: 'integrity' } });
  });
});
