import { describe, expect, it } from 'vitest';
import { hashFieldText } from '@/lib/translation/fieldRevision';
import { classifyTitles, type TitleCandidate } from '@/lib/translation/titleVerdicts';

// The pure per-title classifier (Story MOTIR-7738 · MOTIR-8828): every basis the
// field classifier has, and the totality of the output. No store, no model.

const t = (id: string, title: string, language: string | null): TitleCandidate => ({
  id,
  title,
  language,
});

describe('classifyTitles', () => {
  it('recorded mismatch: needs translating, names the recorded language, carries the revision', () => {
    const out = classifyTitles([t('a', 'Build the export feature', 'en')], 'ko');
    expect(out.a).toEqual({
      id: 'a',
      needsTranslation: true,
      sourceLanguage: 'en',
      revision: hashFieldText('Build the export feature'),
    });
  });

  it('recorded match (primary subtag, case-insensitive): nothing to do', () => {
    const out = classifyTitles([t('a', 'Hello', 'KO-kr')], 'ko');
    expect(out.a).toMatchObject({ needsTranslation: false, sourceLanguage: null });
  });

  it('recorded language that is not a supported locale: needs translating, source unknown', () => {
    const out = classifyTitles([t('a', 'Hello', 'xx')], 'ko');
    expect(out.a).toMatchObject({ needsTranslation: true, sourceLanguage: null });
  });

  it('no record: the local detector decides and names the source', () => {
    const out = classifyTitles([t('a', '构建导出功能并且验证结果是否正确', null)], 'en');
    expect(out.a).toMatchObject({ needsTranslation: true, sourceLanguage: 'zh' });
  });

  it('no record, undecidable: still needs translating, source null', () => {
    const out = classifyTitles([t('a', '42', null)], 'en');
    expect(out.a).toMatchObject({ needsTranslation: true, sourceLanguage: null });
  });

  it('empty title: needs nothing but still has an entry and a revision', () => {
    const out = classifyTitles([t('a', '   ', 'en')], 'ko');
    expect(out.a).toEqual({
      id: 'a',
      needsTranslation: false,
      sourceLanguage: null,
      revision: hashFieldText('   '),
    });
  });

  it('is total: one entry per id, in a mixed set', () => {
    const out = classifyTitles(
      [t('a', 'Hello', 'en'), t('b', 'Hallo', 'ko'), t('c', '', null)],
      'ko',
    );
    expect(Object.keys(out).sort()).toEqual(['a', 'b', 'c']);
    expect(out.a!.needsTranslation).toBe(true);
    expect(out.b!.needsTranslation).toBe(false);
    expect(out.c!.needsTranslation).toBe(false);
  });

  it('an empty set gives an empty map', () => {
    expect(classifyTitles([], 'ko')).toEqual({});
  });
});
