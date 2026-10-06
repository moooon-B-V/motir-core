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
