import { describe, expect, it } from 'vitest';
import { extractLinks, parseMarkdown } from '../../src';

// `extractLinks` (Story MOTIR-5747 · MOTIR-7570), `docs/decisions/pages.md` §8.1.

const json = (markdown: string) => parseMarkdown(markdown).toJSON();

describe('extractLinks', () => {
  it('returns one link per distinct item, in document order, each a mention', () => {
    const body = [
      '# [MOTIR-2](motir:ckbbbb) heads it',
      '',
      'Then [MOTIR-1](motir:ckaaaa), [MOTIR-2](motir:ckbbbb) and',
      '',
      '- [ ] a task naming [MOTIR-2](motir:ckbbbb)',
      '',
      '| a | b |',
      '| --- | --- |',
      '| [MOTIR-1](motir:ckaaaa) | x |',
    ].join('\n');
    expect(extractLinks(json(body))).toEqual([
      { workItemId: 'ckbbbb', source: 'mention' },
      { workItemId: 'ckaaaa', source: 'mention' },
    ]);
  });

  it('returns [] for a body with no mention, plain links included', () => {
    expect(extractLinks(json('Just [docs](https://x.y) and MOTIR-3 typed bare.'))).toEqual([]);
    expect(extractLinks({ type: 'doc' })).toEqual([]);
  });

  it('skips a mention node with no id', () => {
    expect(
      extractLinks({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'workItemMention', attrs: {} }] }],
      }),
    ).toEqual([]);
  });
});

describe('extractLinks — embeds (MOTIR-9180)', () => {
  it('derives an embed for a lone card', () => {
    expect(extractLinks(json('![MOTIR-1](motir:ckaaaa)'))).toEqual([
      { workItemId: 'ckaaaa', source: 'embed' },
    ]);
  });

  it('derives BOTH entries for one item carried as a card and a chip, in document order', () => {
    const body = ['[MOTIR-1](motir:ckaaaa) first', '', '![MOTIR-1](motir:ckaaaa)'].join('\n');
    expect(extractLinks(json(body))).toEqual([
      { workItemId: 'ckaaaa', source: 'mention' },
      { workItemId: 'ckaaaa', source: 'embed' },
    ]);
  });

  it('finds a card in a list item, a blockquote and a table cell, once per item', () => {
    const body = [
      '- ![a](motir:ckaaaa)',
      '',
      '> ![b](motir:ckbbbb)',
      '',
      '| x |',
      '| --- |',
      '| ![c](motir:ckcccc) |',
      '',
      '![a](motir:ckaaaa)',
    ].join('\n');
    expect(extractLinks(json(body))).toEqual([
      { workItemId: 'ckaaaa', source: 'embed' },
      { workItemId: 'ckbbbb', source: 'embed' },
      { workItemId: 'ckcccc', source: 'embed' },
    ]);
  });

  it('skips an embed node with no id, an empty id or a non-string id', () => {
    for (const attrs of [{}, { id: '' }, { id: 7 }]) {
      expect(extractLinks({ type: 'doc', content: [{ type: 'workItemEmbed', attrs }] })).toEqual(
        [],
      );
    }
  });
});
