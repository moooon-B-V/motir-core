// One page body holding every node and mark the page schema carries — the
// round-trip fixture the conversion tests share (MOTIR-7272).
export const FIXTURE_MARKDOWN = `# Title

Some **bold**, *italic*, ~~strike~~, \`code\` and [a link](https://example.com).\\
After a break.

## Sub

> A quote

- one
- two
  - nested

1. first
2. second

- [x] done
- [ ] todo

\`\`\`ts
const a = 1;
\`\`\`

![alt text](https://example.com/a.png)

| A | B |
| --- | --- |
| 1 | **2** |

---

### Three`;

/** The fixture's plain text: one line per block, a hard break a line of its own. */
export const FIXTURE_TEXT = [
  'Title',
  'Some bold, italic, strike, code and a link.',
  'After a break.',
  'Sub',
  'A quote',
  'one',
  'two',
  'nested',
  'first',
  'second',
  'done',
  'todo',
  'const a = 1;',
  'A',
  'B',
  '1',
  '2',
  'Three',
].join('\n');
