import { describe, expect, it } from 'vitest';
import {
  RECONSENT_DOCUMENT_SLUGS,
  isMaterialChange,
  isReconsentDocument,
  outstandingReconsent,
  parseSemanticVersion,
} from '@/lib/legal/consent';
import { type LegalDocument } from '@/lib/legal/documents';

// The materiality rule and the re-consent set (Story 8.4 · Subtask MOTIR-1135).
//
// Everything here is PURE, so every branch is reachable from plain values and
// nothing needs a database or a filesystem. What these tests are really pinning
// down is a clause in a published contract: `content/legal/terms.md` §14
// promises that non-material changes "take effect when published", and the
// semver convention is how the code keeps that promise. A regression here is a
// broken promise, not a wrong pixel.

function doc(overrides: Partial<LegalDocument> & { slug: string }): LegalDocument {
  return {
    title: overrides.slug,
    version: '1.0.0',
    effectiveDate: null,
    status: 'approved',
    changeSummary: null,
    body: '',
    ...overrides,
  };
}

function held(documentSlug: string, version: string, acceptedAt = new Date('2026-01-01')) {
  return { documentSlug, version, acceptedAt };
}

describe('parseSemanticVersion', () => {
  it('reads a three-part version', () => {
    expect(parseSemanticVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemanticVersion(' 10.0.7 ')).toEqual({ major: 10, minor: 0, patch: 7 });
  });

  it('refuses anything that is not exactly three numeric parts', () => {
    for (const raw of ['1.0', '1.0.0.0', 'v1.0.0', '1.0.0-rc1', '', 'abc', null, undefined]) {
      expect(parseSemanticVersion(raw)).toBeNull();
    }
  });
});

describe('isMaterialChange', () => {
  it('PATCH is NOT material — §14 says it takes effect when published', () => {
    // The whole reason this module exists instead of a `>` comparison: a typo
    // fix must not hold every signed-in reader out of the product.
    expect(isMaterialChange('1.0.0', '1.0.1')).toBe(false);
    expect(isMaterialChange('2.3.4', '2.3.99')).toBe(false);
  });

  it('MINOR is material', () => {
    expect(isMaterialChange('1.0.0', '1.1.0')).toBe(true);
    // A minor bump is material even when the patch went BACKWARDS — the minor
    // component is what decides, and it is read first.
    expect(isMaterialChange('1.0.9', '1.1.0')).toBe(true);
  });

  it('MAJOR is material', () => {
    expect(isMaterialChange('1.9.9', '2.0.0')).toBe(true);
  });

  it('never accepted is material — there is no agreement on record', () => {
    expect(isMaterialChange(null, '1.0.0')).toBe(true);
    expect(isMaterialChange(undefined, '1.0.0')).toBe(true);
  });

  it('unchanged is not material', () => {
    expect(isMaterialChange('1.0.0', '1.0.0')).toBe(false);
  });

  it('a reader who is AHEAD is not held', () => {
    // A version that went backwards is a mistake in the repository. Holding
    // every signed-in reader out of the product is not how it gets fixed.
    expect(isMaterialChange('2.0.0', '1.0.0')).toBe(false);
    expect(isMaterialChange('1.2.0', '1.1.0')).toBe(false);
  });

  it('an unreadable version on EITHER side fails towards asking', () => {
    // The one place this module deliberately fails towards a prompt: a version
    // nobody can parse is a version whose materiality nobody can rule out, and
    // the cost of being wrong is one extra screen rather than a person bound by
    // a clause they were never shown.
    expect(isMaterialChange('one', '1.0.0')).toBe(true);
    expect(isMaterialChange('1.0.0', 'two')).toBe(true);
    expect(isMaterialChange('1.0.0', '')).toBe(true);
  });
});

describe('the re-consent set', () => {
  it('is the three documents that make up the agreement, in reading order', () => {
    // Terms first: it is the contract the other two hang off. `terms.md` §15
    // makes the three a single agreement.
    expect([...RECONSENT_DOCUMENT_SLUGS]).toEqual(['terms', 'privacy', 'acceptable-use']);
  });

  it('excludes the four documents whose grounds are published', () => {
    // Each exclusion quotes a document we are bound by rather than a judgement
    // made in code — see `lib/legal/consent.ts` for the clause behind each.
    for (const slug of ['cookies', 'dpa', 'subprocessors', 'model-providers']) {
      expect(isReconsentDocument(slug)).toBe(false);
    }
  });

  it('does not start gating on a document somebody adds to content/legal', () => {
    // The list can only ever ask for LESS, which is why it is closed here while
    // `documents.ts` treats the directory as the registry. A new file ships a
    // published page; it does not hold the whole product.
    const documents = [
      doc({ slug: 'terms' }),
      doc({ slug: 'privacy' }),
      doc({ slug: 'acceptable-use' }),
      doc({ slug: 'brand-new-policy', version: '9.0.0' }),
    ];
    const accepted = [
      held('terms', '1.0.0'),
      held('privacy', '1.0.0'),
      held('acceptable-use', '1.0.0'),
    ];
    expect(outstandingReconsent(documents, accepted)).toEqual([]);
  });
});

describe('outstandingReconsent', () => {
  const published = [
    doc({ slug: 'terms', title: 'Terms of Service', version: '2.0.0' }),
    doc({ slug: 'privacy', title: 'Privacy Policy', version: '1.0.1' }),
    doc({ slug: 'acceptable-use', title: 'Acceptable Use Policy', version: '1.0.0' }),
    doc({ slug: 'subprocessors', version: '5.0.0' }),
  ];

  it('is empty for a reader who is current on all three', () => {
    expect(
      outstandingReconsent(published, [
        held('terms', '2.0.0'),
        held('privacy', '1.0.0'),
        held('acceptable-use', '1.0.0'),
      ]),
    ).toEqual([]);
  });

  it('lists only the MATERIALLY changed document, and carries the delta', () => {
    // The fixture the design draws (panel 6): the Terms went 1.0.0 → 2.0.0 and
    // the AUP moved 1.0.0 → 1.0.1 in the same release. The AUP is deliberately
    // absent from the list.
    const outstanding = outstandingReconsent(
      [
        doc({ slug: 'terms', title: 'Terms of Service', version: '2.0.0' }),
        doc({ slug: 'privacy', title: 'Privacy Policy', version: '1.0.0' }),
        doc({ slug: 'acceptable-use', title: 'Acceptable Use Policy', version: '1.0.1' }),
      ],
      [held('terms', '1.0.0'), held('privacy', '1.0.0'), held('acceptable-use', '1.0.0')],
    );
    expect(outstanding.map((entry) => entry.slug)).toEqual(['terms']);
    expect(outstanding[0]).toMatchObject({
      title: 'Terms of Service',
      acceptedVersion: '1.0.0',
      currentVersion: '2.0.0',
    });
  });

  it('reports a never-accepted document with a null accepted version', () => {
    // A brand-new signup whose acceptance row was lost, or a document added to
    // the set. The row then reads as NEW rather than as a delta from nothing.
    const outstanding = outstandingReconsent(published, []);
    expect(outstanding.map((entry) => entry.slug)).toEqual(['terms', 'privacy', 'acceptable-use']);
    expect(outstanding.every((entry) => entry.acceptedVersion === null)).toBe(true);
  });

  it('keeps the latest whichever ORDER the rows arrive in', () => {
    // The repository returns them ascending, but nothing in this function may
    // depend on that: it is a fold over a list, and a caller that ever passes a
    // differently-ordered read must get the same answer.
    const rows = [
      held('terms', '1.0.0', new Date('2026-06-01')),
      held('terms', '2.0.0', new Date('2026-01-01')),
    ];
    expect(
      outstandingReconsent([doc({ slug: 'terms', version: '2.0.0' })], rows)[0]?.acceptedVersion,
    ).toBe('1.0.0');
    expect(
      outstandingReconsent([doc({ slug: 'terms', version: '2.0.0' })], [...rows].reverse())[0]
        ?.acceptedVersion,
    ).toBe('1.0.0');
  });

  it('takes the LATEST acceptance by timestamp, not the highest version', () => {
    // The table is append-only, so a person carries their whole history. What
    // they most recently agreed to is a fact about WHEN, not about which string
    // sorts higher — the record is of what happened.
    const outstanding = outstandingReconsent(
      [doc({ slug: 'terms', version: '2.0.0' })],
      [
        held('terms', '2.0.0', new Date('2026-01-01')),
        held('terms', '1.0.0', new Date('2026-06-01')),
      ],
    );
    expect(outstanding.map((entry) => entry.acceptedVersion)).toEqual(['1.0.0']);
  });

  it('carries the change summary and effective date through to the row', () => {
    const outstanding = outstandingReconsent(
      [
        doc({
          slug: 'terms',
          version: '2.0.0',
          changeSummary: 'Adds the hosted-agent execution service.',
          effectiveDate: '2026-10-12',
        }),
      ],
      [held('terms', '1.0.0')],
    );
    expect(outstanding[0]).toMatchObject({
      changeSummary: 'Adds the hosted-agent execution service.',
      effectiveDate: '2026-10-12',
    });
  });

  it('holds nobody on a document that is in the set but not in content/legal', () => {
    // The safe direction: a document that cannot be read, linked or agreed to
    // would otherwise be a hold nobody can clear.
    expect(outstandingReconsent([doc({ slug: 'terms', version: '1.0.0' })], [])).toHaveLength(1);
  });
});
