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
