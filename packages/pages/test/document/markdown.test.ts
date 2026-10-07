import { describe, expect, it } from 'vitest';
import { pageSchema, parseMarkdown, serializeMarkdown } from '../../src';
import { FIXTURE_MARKDOWN } from './fixture';

const roundTrip = (md: string) => serializeMarkdown(parseMarkdown(md));
const s = pageSchema;
const p = (text?: string) => s.node('paragraph', null, text ? [s.text(text)] : []);

describe('markdown ↔ the page document', () => {
  it('round-trips the fixture holding every node and mark', () => {
    expect(roundTrip(FIXTURE_MARKDOWN)).toBe(FIXTURE_MARKDOWN);
  });

  it('parses GFM task lists, checked and unchecked, nested included', () => {
    const doc = parseMarkdown('- [x] done\n- [ ] todo\n  - [X] inner');
    const list = doc.child(0);
    expect(list.type.name).toBe('taskList');
    expect(list.child(0).attrs.checked).toBe(true);
    expect(list.child(1).attrs.checked).toBe(false);
    expect(list.child(0).textContent).toBe('done');
    const inner = list.child(1).child(1);
    expect(inner.type.name).toBe('taskList');
    expect(inner.child(0).attrs.checked).toBe(true);
    expect(roundTrip('- [x] done\n- [ ] todo\n  - [x] inner')).toBe(
      '- [x] done\n- [ ] todo\n  - [x] inner',
    );
  });

  it('keeps a list that only partly carries task markers a bullet list', () => {
    const doc = parseMarkdown('- [x] done\n- plain');
    expect(doc.child(0).type.name).toBe('bulletList');
    expect(doc.child(0).child(0).textContent).toBe('[x] done');
  });

  it('keeps a list whose item opens with something other than a paragraph a bullet list', () => {
    expect(parseMarkdown('- ```\n  x\n  ```').child(0).type.name).toBe('bulletList');
  });

  it('rides a code block’s language on the fence and lengthens a fence its code contains', () => {
    const doc = parseMarkdown('```ts\nconst a = 1;\n```');
    expect(doc.child(0).attrs.language).toBe('ts');

    const fenced = s.node('doc', null, [
      s.node('codeBlock', { language: null }, [s.text('a\n```\nb')]),
    ]);
    expect(serializeMarkdown(fenced)).toBe('````\na\n```\nb\n````');
    expect(parseMarkdown('    indented').child(0).type.name).toBe('codeBlock');
    expect(parseMarkdown('```\nplain\n```').child(0).attrs.language).toBeNull();
  });

  it('caps headings at level 3', () => {
    const doc = parseMarkdown('#### Deep');
    expect(doc.child(0).attrs.level).toBe(3);
    expect(serializeMarkdown(doc)).toBe('### Deep');
  });

  it('keeps an ordered list’s start number', () => {
    expect(roundTrip('3. three\n4. four')).toBe('3. three\n4. four');
  });

  it('lifts an image out of a paragraph, keeping the text either side', () => {
    const doc = parseMarkdown('before ![pic](a.png "A title") after');
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).textContent).toBe('before ');
    expect(doc.child(1).type.name).toBe('image');
    expect(doc.child(1).attrs).toMatchObject({ src: 'a.png', alt: 'pic', title: 'A title' });
    expect(doc.child(2).textContent).toBe(' after');
    expect(serializeMarkdown(s.node('doc', null, [doc.child(1)]))).toBe('![pic](a.png "A title")');

    const bare = parseMarkdown('![](b.png)').child(0);
    expect(bare.attrs).toMatchObject({ src: 'b.png', alt: null, title: null });
    expect(parseMarkdown('![one](a.png)\n![two](b.png)').childCount).toBe(2);
  });

  it('escapes the characters an image source and title cannot carry raw', () => {
    const image = s.node('image', { src: 'a(1).png', alt: 'x', title: 'say "hi"' });
    expect(serializeMarkdown(s.node('doc', null, [image]))).toBe(
      '![x](a\\(1\\).png "say \\"hi\\"")',
    );
  });

  it('escapes a backslash in an image source and title, so the attrs survive a round trip', () => {
    const attrs = { src: 'a\\(1).png', alt: 'x', title: 'C:\\ "q"' };
    const md = serializeMarkdown(s.node('doc', null, [s.node('image', attrs)]));
    const back = parseMarkdown(md).child(0).attrs;
    // The parser percent-encodes a backslash in a URL; decoded, it is the source.
    expect(decodeURI(back.src as string)).toBe(attrs.src);
    expect(back).toMatchObject({ alt: 'x', title: attrs.title });
  });

  it('keeps a backslash in a table cell a single backslash through a round trip', () => {
    const cell = (text: string) => s.node('tableCell', null, [p(text)]);
    const table = s.node('table', null, [
      s.node('tableRow', null, [cell('h')]),
      s.node('tableRow', null, [cell('a\\|b')]),
    ]);
    const parsed = parseMarkdown(serializeMarkdown(s.node('doc', null, [table])));
    expect(parsed.child(0).child(1).textContent).toBe('a\\|b');
  });

  it('keeps a link’s title', () => {
    expect(roundTrip('[x](https://e.com "T")')).toBe('[x](https://e.com "T")');
  });

  it('writes a table’s first row as the header, pads short rows, escapes pipes and joins blocks', () => {
    const cell = (...blocks: ReturnType<typeof p>[]) => s.node('tableCell', null, blocks);
    const table = s.node('table', null, [
      s.node('tableRow', null, [cell(p('a')), cell(p('b'))]),
      s.node('tableRow', null, [cell(p('x | y'), p('second'))]),
    ]);
    expect(serializeMarkdown(s.node('doc', null, [table]))).toBe(
      '| a | b |\n| --- | --- |\n| x \\| y<br>second |  |',
    );
  });

  it('parses a table into header and body cells that each hold a paragraph', () => {
    const table = parseMarkdown('| A |\n| --- |\n| 1 |').child(0);
    expect(table.child(0).child(0).type.name).toBe('tableHeader');
    expect(table.child(1).child(0).type.name).toBe('tableCell');
    expect(table.child(1).child(0).child(0).type.name).toBe('paragraph');
  });

  it('writes an empty document as the empty string', () => {
    expect(serializeMarkdown(s.node('doc', null, [p()]))).toBe('');
  });
});

describe('the work-item mention (MOTIR-7570)', () => {
  it('parses the durable token into a workItemMention node and writes it back byte for byte', () => {
    const line = 'See [MOTIR-12](motir:ck123) now';
    const doc = parseMarkdown(line);
    expect(doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'workItemMention', attrs: { id: 'ck123', label: 'MOTIR-12' } },
            { type: 'text', text: ' now' },
          ],
        },
      ],
    });
    expect(serializeMarkdown(doc)).toBe(line);
  });

  it('leaves a plain link the Link mark, unchanged', () => {
    const doc = parseMarkdown('[docs](https://x.y)');
    const text = doc.child(0).child(0);
    expect(text.isText).toBe(true);
    expect(text.marks.map((m) => [m.type.name, m.attrs.href])).toEqual([['link', 'https://x.y']]);
    expect(roundTrip('[docs](https://x.y)')).toBe('[docs](https://x.y)');
  });

  it('keeps a malformed motir: href an ordinary link, never a mention', () => {
    const doc = parseMarkdown('[bad](motir:has%20space)');
    expect(JSON.stringify(doc.toJSON())).not.toContain('workItemMention');
  });

  it('takes the label from formatted link text and round-trips mentions in a list and a table', () => {
    expect(parseMarkdown('[**MOTIR-4**](motir:ck4)').child(0).child(0).attrs).toEqual({
      id: 'ck4',
      label: 'MOTIR-4',
    });
    const md = '- [MOTIR-5](motir:ck5)\n\n| a |\n| --- |\n| [MOTIR-6](motir:ck6) |';
    expect(roundTrip(md)).toBe(md);
  });
  // MOTIR-7574: the page editor stores the work item's id ONLY, so a chip it
  // inserted has no label, and its token is `[](motir:<id>)` — no key in the body.
  it('round-trips a mention with no stored label as an empty-label token', () => {
    const doc = s.node('doc', null, [
      s.node('paragraph', null, [
        s.text('See '),
        s.node('workItemMention', { id: 'ck7', label: null }),
        s.text(' now'),
      ]),
    ]);
    const md = serializeMarkdown(doc);
    expect(md).toBe('See [](motir:ck7) now');
    expect(parseMarkdown(md).child(0).child(1).attrs).toEqual({ id: 'ck7', label: null });
    expect(serializeMarkdown(parseMarkdown(md))).toBe(md);
    // In a list and a table too.
    const nested = '- [](motir:ck8)\n\n| a |\n| --- |\n| [](motir:ck9) |';
    expect(roundTrip(nested)).toBe(nested);
  });
});
