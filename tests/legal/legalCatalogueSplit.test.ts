import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_ROOTS,
  catalogueRoots,
  legalKeysDeclaredIn,
  legalKeysReadIn,
  legalKeysReadUnder,
} from './legalCatalogueGuard';

// THE `legal.*` CATALOGUE SPLIT (Story MOTIR-4101 · Subtask MOTIR-4104).
//
// MOTIR-4103 deleted `app/(public)/legal/` and split the namespace with it: ten
// keys those pages read came out of `en` and `zh` together, and `signUpNotice`
// plus the whole `reconsent.*` subtree stayed because the sign-up notice and the
// re-consent interstitial still render on this host.
//
// ⚠️ TWO DIRECTIONS, AND `tests/i18n-catalog.test.ts` HOLDS NEITHER OF THEM.
// That suite compares `en` against `zh`, which is a real property and a
// different one: a key removed from BOTH locales passes it, and so does a key
// left in BOTH and read by nothing. What is asserted here is the catalogue
// against the SOURCE.
//
//   * MISSING — a key a surviving surface reads and the catalogue no longer
//     declares. next-intl throws on a missing message, so this is a render
//     crash, and it is the direction the split could plausibly have overshot in.
//
//   * ORPHAN — a key the catalogue declares that nothing reads. The quiet one:
//     it produces no type error, no failing test and no lint, so a key the split
//     should have taken would sit in both locales indefinitely, be re-translated
//     on the next pass, and read to any future reader as a surface that exists.
//
// ⚠️ AND THE LIVENESS CHECK BELOW IS NOT DECORATION. Both assertions are set
// equalities against a population this file DERIVES, and an extractor that
// matched nothing would make the read set empty — at which point "no missing
// key" holds vacuously and only the orphan direction would fail. The count
// assertion is what separates *the catalogue is clean* from *the scan is
// broken*.

describe('the legal.* namespace matches what the surviving surfaces read', () => {
  const declared = legalKeysDeclaredIn('en');
  const reads = legalKeysReadUnder(catalogueRoots());
  const read = [...new Set(reads.map((r) => r.key))].sort();

  it('reads a real, non-trivial set of keys — the scan is not vacuous', () => {
    expect([...CATALOGUE_ROOTS]).toEqual(['app', 'components']);
    expect(read.length, 'the source scan found no legal.* key at all').toBeGreaterThan(10);
    expect(declared.length, 'the en catalogue declares no legal.* key').toBeGreaterThan(10);
    // The two surfaces that survived the split, named so that deleting one and
    // leaving its keys is a failure here rather than an orphan nobody sees.
    expect(read).toContain('legal.signUpNotice');
    expect(read).toContain('legal.reconsent.agreeOne');
  });

  it('declares every key a surviving surface reads — no missing message', () => {
    const missing = reads.filter((r) => !declared.includes(r.key));
    expect(
      missing.map((r) => `${r.key} (read by ${r.file})`),
      'keys read from source that messages/en.json does not declare',
    ).toEqual([]);
  });

  it('declares no key nothing reads — no orphan left by the split', () => {
    const orphans = declared.filter((key) => !read.includes(key));
    expect(
      orphans,
      `legal.* keys in messages/en.json that no surface under ${CATALOGUE_ROOTS.join('/')} reads. ` +
        `MOTIR-4103 took the ten keys app/(public)/legal/ rendered; anything still here ` +
        `belongs to a surface that survived, or it belongs to motir-marketing.`,
    ).toEqual([]);
  });

  it('the zh twin carries exactly the same legal.* keys', () => {
    // `tests/i18n-catalog.test.ts` asserts this over the WHOLE catalogue. It is
    // repeated for this namespace alone so a split that half-lands names the
    // namespace in its failure message rather than arriving as one line in a
    // catalogue-wide diff — and so this file is a complete statement of the
    // split's post-condition rather than half of one.
    expect(legalKeysDeclaredIn('zh')).toEqual(legalKeysDeclaredIn('en'));
  });
});

describe('the negative control — the extractor sees what it claims to see', () => {
  it('binds keys to the DECLARED namespace, not to the variable name', () => {
    // The `SignUpCard.tsx` shape: two translators in one file, only one of them
    // legal. An extractor keyed on `t(` would attribute the auth copy to the
    // legal namespace and report every one of those keys as missing.
    const source = [
      `const t = useTranslations('auth');`,
      `const tLegal = useTranslations('legal');`,
      `const a = t('welcomeToMotir');`,
      `const b = tLegal.rich('signUpNotice', {});`,
    ].join('\n');

    expect(legalKeysReadIn(source)).toEqual(['legal.signUpNotice']);
  });

  it('qualifies a nested namespace with its own prefix', () => {
    const source = [
      `const t = useTranslations('legal.reconsent');`,
      `const h = t('headlineOne', { document: 'Terms' });`,
      `const f = t.rich('declineFoot', {});`,
    ].join('\n');

    expect(legalKeysReadIn(source)).toEqual([
      'legal.reconsent.declineFoot',
      'legal.reconsent.headlineOne',
    ]);
  });

  it('reads an awaited getTranslations binding too', () => {
    const source = [
      `const tl = await getTranslations('legal');`,
      `const n = tl('signUpNotice');`,
    ].join('\n');

    expect(legalKeysReadIn(source)).toEqual(['legal.signUpNotice']);
  });

  it('does NOT count a key named only in a comment', () => {
    // The direction that keeps the orphan check honest. A component whose header
    // explains which keys it USED to read would otherwise keep those keys alive
    // for as long as the explanation survived — and the repair for a red orphan
    // check would be to delete the record of the split.
    const source = [
      `// This card used to read legal.indexTitle via t('indexTitle').`,
      `const t = useTranslations('legal');`,
      `const n = t('signUpNotice');`,
    ].join('\n');

    expect(legalKeysReadIn(source)).toEqual(['legal.signUpNotice']);
  });

  it('ignores a namespace that merely CONTAINS the word', () => {
    // `shell.nav.legal` and `projectSquare.footCompanyLegal` are other
    // namespaces owned by other surfaces; this guard is about the split of
    // `legal.*` and must not adopt them.
    const source = [
      `const t = useTranslations('shell.nav');`,
      `const a = t('legal');`,
      `const u = useTranslations('legalish');`,
      `const b = u('whatever');`,
    ].join('\n');

    expect(legalKeysReadIn(source)).toEqual([]);
  });
});
