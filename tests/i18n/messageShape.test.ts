import { describe, expect, it } from 'vitest';
import { compareMessageShape } from '@/scripts/i18n/messageShape';

// Story MOTIR-7730 · MOTIR-7745 — a translation keeps its source's placeholders,
// plural/select structure and tags, whatever it does with the words.

const kinds = (source: string, target: string, locale: string) =>
  compareMessageShape(source, target, locale).map((v) => `${v.kind}:${v.name ?? ''}`);

describe('compareMessageShape — accepts a correct translation', () => {
  const plural = '{count, plural, one {# item} other {# items}}';

  it('a Japanese plural with only "other"', () => {
    expect(compareMessageShape(plural, '{count, plural, other {#件}}', 'ja')).toEqual([]);
  });

  it('a Polish plural with one / few / many / other', () => {
    expect(
      compareMessageShape(
        plural,
        '{count, plural, one {# element} few {# elementy} many {# elementów} other {# elementu}}',
        'pl',
      ),
    ).toEqual([]);
  });

  it('a translation that reorders a placeholder before the tag', () => {
    expect(
      compareMessageShape(
        'Code <chip>{code}</chip> · asked {ago}',
        '{ago}に質問 · コード <chip>{code}</chip>',
        'ja',
      ),
    ).toEqual([]);
  });

  it('exact =N keys are allowed in any locale', () => {
    expect(compareMessageShape(plural, '{count, plural, =0 {なし} other {#件}}', 'ja')).toEqual([]);
  });

  it('a raw (non-ICU) source keeps its literal tokens', () => {
    expect(
      compareMessageShape(
        'Run `motir help <command>`.',
        '`motir help <command>` を実行します。',
        'ja',
      ),
    ).toEqual([]);
    expect(kinds('Run `motir help <command>`.', '`motir help` を実行します。', 'ja')).toEqual([
      'tags:<command>',
    ]);
  });
});

describe('compareMessageShape — names the violation', () => {
  it('a dropped placeholder', () => {
    expect(kinds('Connect to {hostname}', '接続します', 'ja')).toEqual(['argument-set:hostname']);
  });

  it('an invented placeholder', () => {
    expect(kinds('Saved', '{name} を保存しました', 'ja')).toEqual(['argument-set:name']);
  });

  it('a plural flattened to a plain placeholder', () => {
    expect(kinds('{count, plural, one {# item} other {# items}}', '{count} 件', 'ja')).toEqual([
      'argument-kind:count',
    ]);
  });

  it('a plural without "other"', () => {
    expect(
      kinds(
        '{count, plural, one {# item} other {# items}}',
        '{count, plural, one {# Element}}',
        'de',
      ),
    ).toEqual(['plural-options:count']);
  });

  it('a Japanese plural with a "one" branch, outside ja\'s CLDR categories', () => {
    expect(
      kinds(
        '{count, plural, one {# item} other {# items}}',
        '{count, plural, one {1件} other {#件}}',
        'ja',
      ),
    ).toEqual(['plural-options:count']);
  });

  it('a select whose option keys differ', () => {
    expect(
      kinds(
        '{role, select, admin {Admin} other {Member}}',
        '{role, select, administrator {管理者} other {メンバー}}',
        'ja',
      ),
    ).toEqual(['select-options:role']);
  });

  it('a renamed tag', () => {
    expect(kinds('Read <link>the guide</link>', 'Lisez <lien>le guide</lien>', 'fr')).toEqual([
      'tags:link',
      'tags:lien',
    ]);
  });

  it('a dropped tag', () => {
    expect(kinds('Read <link>the guide</link>', 'Lisez le guide', 'fr')).toEqual(['tags:link']);
  });

  it('a tag dropped from one of two occurrences', () => {
    expect(kinds('<b>A</b> and <b>B</b>', '<b>A</b> et B', 'fr')).toEqual(['tags:b']);
  });

  it('a swapped nesting order', () => {
    expect(
      kinds('<strong><link>x</link></strong>', '<link><strong>x</strong></link>', 'fr'),
    ).toEqual(['tags:']);
  });

  it('an unparseable target', () => {
    expect(kinds('{count} items', '{count', 'ja')).toEqual(['unparseable:']);
  });

  it('recurses into plural branches', () => {
    expect(
      kinds(
        '{count, plural, one {# item in {project}} other {# items in {project}}}',
        '{count, plural, other {#件}}',
        'ja',
      ),
    ).toEqual(['argument-set:project']);
  });
});
