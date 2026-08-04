import { describe, expect, it } from 'vitest';
import { replaceInProse } from '@/lib/markdown/proseRanges';

// Unit tests for the Markdown-structure-aware prose walker (bug MOTIR-2043) —
// the helper that decides WHICH stretches of a stored body a write-side rewrite
// is allowed to touch. Pure string work, no DB. `normalizeWorkItemRefs` is its
// first caller (tests/work-items/work-item-refs.test.ts covers that contract);
// here we pin the walker itself with a marker replacer, so a regression shows up
// as "the wrong region was offered", not as a token-shaped diff.

/** Wrap each prose run the walker offers, so its boundaries are visible. */
const mark = (body: string) => replaceInProse(body, (prose) => `«${prose}»`);

/** Collect the prose runs the walker offers, in order. */
function proseRuns(body: string): string[] {
  const runs: string[] = [];
  replaceInProse(body, (prose) => {
    runs.push(prose);
    return prose;
  });
  return runs;
}

describe('replaceInProse — what counts as prose', () => {
  it('offers paragraph text', () => {
    expect(mark('Just a sentence.')).toBe('«Just a sentence.»');
  });

  it('never offers an inline code span, at any backtick run length', () => {
    expect(mark('a `code` b')).toBe('«a »`code`« b»');
    expect(mark('a ``co ` de`` b')).toBe('«a »``co ` de``« b»');
  });

  it('never offers a fenced code block — including its info string', () => {
    expect(mark('p\n\n```ts\nconst x = 1;\n```\n\nq')).toBe(
      '«p»\n\n```ts\nconst x = 1;\n```\n\n«q»',
    );
  });

  it('never offers an indented code block', () => {
    expect(mark('p\n\n    indented();\n\nq')).toBe('«p»\n\n    indented();\n\n«q»');
  });

  it('never offers a raw HTML block', () => {
    expect(mark('<div>\nraw\n</div>')).toBe('<div>\nraw\n</div>');
  });

  it('never offers a link destination, and never its label', () => {
    expect(mark('go [there](/a/path) now')).toBe('«go »[there](/a/path)« now»');
  });

  it('never offers an image destination or alt text', () => {
    expect(mark('see ![alt](/img.png) here')).toBe('«see »![alt](/img.png)« here»');
  });

  it('never offers a reference link label or its definition', () => {
    expect(mark('use [label][ref].\n\n[ref]: /target\n')).toBe(
      '«use »[label][ref]«.»\n\n[ref]: /target\n',
    );
  });

  it('never offers a GFM autolink literal', () => {
    expect(mark('at https://example.test/x now')).toBe('«at »https://example.test/x« now»');
  });

  it('offers text in a heading, list item, block quote, emphasis and table cell', () => {
    expect(proseRuns('# H\n\n- item\n\n> quoted\n\n*em*\n\n| a |\n| --- |\n| cell |\n')).toEqual([
      'H',
      'item',
      'quoted',
      'em',
      'a',
      'cell',
    ]);
  });

  it('splits prose around an inline boundary rather than spanning it', () => {
    expect(proseRuns('before `code` after')).toEqual(['before ', ' after']);
  });
});

describe('replaceInProse — non-destructiveness', () => {
  const bodies = [
    '',
    'plain',
    '`only code`',
    '```\nfence\n```',
    '<div>\nhtml\n</div>',
    'mixed `code`, a [link](/u), an ![img](/i.png), and prose.',
    '# Heading\n\n1. one\n2. two\n\n| a | b |\n| --- | --- |\n| c | d |\n',
    'text with \\* escapes \\_ and &amp; entities',
    'trailing whitespace and a hard break  \nsecond line\n',
  ];

  it('is byte-identical to the input when the replacer is the identity', () => {
    for (const body of bodies) {
      expect(replaceInProse(body, (prose) => prose)).toBe(body);
    }
  });

  it('leaves a body with no prose at all completely untouched', () => {
    expect(mark('```\nfence only\n```')).toBe('```\nfence only\n```');
    expect(mark('')).toBe('');
  });

  it('hands the replacer the RAW source slice, so escapes round-trip', () => {
    // The mdast *value* would be the decoded `a * b`; the raw source keeps the
    // backslash, which is what a splice back into the original must preserve.
    expect(proseRuns('a \\* b')).toEqual(['a \\* b']);
    expect(replaceInProse('a \\* b', (prose) => prose.toUpperCase())).toBe('A \\* B');
  });

  it('applies the replacement only inside prose, everywhere in the document', () => {
    // Three prose runs — `'KEY '`, the single space between the span and the
    // link, and `' KEY'` — each replaced; the span and the link are untouched.
    expect(proseRuns('KEY `KEY` [KEY](/KEY) KEY')).toEqual(['KEY ', ' ', ' KEY']);
    expect(replaceInProse('KEY `KEY` [KEY](/KEY) KEY', () => 'X')).toBe('X`KEY`X[KEY](/KEY)X');
  });
});
