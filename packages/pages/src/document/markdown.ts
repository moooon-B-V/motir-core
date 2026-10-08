import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown';
import { WORK_ITEM_MENTION_HREF_RE } from './extensions';
import { pageSchema } from './schema';

// Markdown ↔ the page document (Story MOTIR-5752 · MOTIR-7272), over
// `pageSchema` (`docs/decisions/pages.md` §3: `body_markdown` is derived from
// the Yjs state, and the agents' markdown write door turns markdown back into
// an update).
//
// The dialect is CommonMark plus the two GFM extensions the schema carries:
// tables and strikethrough from markdown-it, and task lists (`- [ ]` /
// `- [x]`), which markdown-it does not parse, recognised by a token pass below.
// A code block's language rides the fence's info string.

// ── Parsing ──────────────────────────────────────────────────────────────────

const markdownIt = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);

const TASK_PREFIX = /^\[([ xX])\] /;

/**
 * The first `inline` token of the list item opening at `open`, if the item
 * starts with a paragraph.
 */
function firstInline(tokens: Token[], open: number): Token | undefined {
  const paragraph = tokens[open + 1];
  const inline = tokens[open + 2];
  return paragraph?.type === 'paragraph_open' && inline?.type === 'inline' ? inline : undefined;
}

/** The indexes of a list's own `list_item_open` tokens (not nested lists'). */
function ownItems(tokens: Token[], listOpen: number): number[] {
  const items: number[] = [];
  const level = tokens[listOpen]!.level;
  for (let i = listOpen + 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.level === level && token.type === 'bullet_list_close') break;
    if (token.level === level + 1 && token.type === 'list_item_open') items.push(i);
  }
  return items;
}

/** Strip the `[ ] ` / `[x] ` marker off the start of an item's inline token. */
function stripTaskMarker(inline: Token): void {
  inline.content = inline.content.replace(TASK_PREFIX, '');
  const first = inline.children?.[0];
  if (first?.type === 'text') first.content = first.content.replace(TASK_PREFIX, '');
}

/**
 * Turn every bullet list whose items ALL start `[ ] ` / `[x] ` into a task
 * list — GFM's rule that a task list is a list of task items. A list mixing
 * the two stays a bullet list, its markers kept as text.
 */
function markTaskLists(tokens: Token[]): void {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.type !== 'bullet_list_open') continue;
    const items = ownItems(tokens, i);
    const inlines = items.map((item) => firstInline(tokens, item));
    if (
      items.length === 0 ||
      !inlines.every((inline) => inline && TASK_PREFIX.test(inline.content))
    )
      continue;

    token.type = 'task_list_open';
    const level = token.level;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const t = tokens[j]!;
      if (t.level === level && t.type === 'bullet_list_close') {
        t.type = 'task_list_close';
        break;
      }
      if (t.level !== level + 1) continue;
      if (t.type === 'list_item_open') {
        const inline = firstInline(tokens, j)!;
        t.type = 'task_item_open';
        t.attrSet('checked', String(TASK_PREFIX.exec(inline.content)![1] !== ' '));
        stripTaskMarker(inline);
      } else if (t.type === 'list_item_close') {
        t.type = 'task_item_close';
      }
    }
  }
}

// markdown-it's Token class, reached through the parser instance rather than a
// deep import, which its CommonJS build does not expose.
const TokenClass = (
  markdownIt.core.State.prototype as unknown as {
    Token: new (t: string, tag: string, n: -1 | 0 | 1) => Token;
  }
).Token;

function blockToken(type: string, nesting: -1 | 1): Token {
  const token = new TokenClass(type, 'p', nesting);
  token.block = true;
  return token;
}

/**
 * Give every table cell a paragraph: GFM cells hold inline content, the
 * schema's cells hold blocks.
 */
function wrapTableCells(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    if (token.type === 'th_close' || token.type === 'td_close') {
      out.push(blockToken('paragraph_close', -1));
    }
    out.push(token);
    if (token.type === 'th_open' || token.type === 'td_open') {
      out.push(blockToken('paragraph_open', 1));
    }
  }
  return out;
}

/**
 * Lift images out of paragraphs: the page's image is a BLOCK node, markdown's
 * is inline. Text either side of an image stays in a paragraph of its own.
 */
function liftImages(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const open = tokens[i]!;
    const inline = tokens[i + 1];
    const close = tokens[i + 2];
    if (
      open.type !== 'paragraph_open' ||
      inline?.type !== 'inline' ||
      close?.type !== 'paragraph_close' ||
      !inline.children?.some((child) => child.type === 'image')
    ) {
      out.push(open);
      continue;
    }

    let run: Token[] = [];
    const flush = (): void => {
      const meaningful = run.filter((child) => child.type !== 'softbreak');
      if (meaningful.length > 0) {
        const paragraph = Object.assign(Object.create(Object.getPrototypeOf(inline)), inline, {
          children: run,
          content: run.map((child) => child.content).join(''),
        }) as Token;
        out.push(open, paragraph, close);
      }
      run = [];
    };
    for (const child of inline.children) {
      if (child.type === 'image') {
        flush();
        child.block = true;
        out.push(child);
      } else {
        run.push(child);
      }
    }
    flush();
    i += 2;
  }
  return out;
}

/**
 * Turn every inline `[label](motir:<id>)` link into ONE `work_item_mention`
 * token (MOTIR-7570), before the `Link` mark sees it: the mark would keep it as
 * a plain link, and the editor's protocol check drops a `motir:` href. The
 * label is the link's text, whatever marks it carried. A `motir:` href that is
 * not a well-formed id stays an ordinary link.
 */
function markWorkItemMentions(tokens: Token[]): void {
  for (const block of tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const children = block.children;
    const out: Token[] = [];
    for (let i = 0; i < children.length; i += 1) {
      const open = children[i]!;
      const match =
        open.type === 'link_open'
          ? WORK_ITEM_MENTION_HREF_RE.exec(open.attrGet('href') ?? '')
          : null;
      const close = match
        ? children.findIndex((t, j) => j > i && t.type === 'link_close' && t.level === open.level)
        : -1;
      if (!match || close === -1) {
        out.push(open);
        continue;
      }
      const label = children
        .slice(i + 1, close)
        .map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : ''))
        .join('');
      const mention = new TokenClass('work_item_mention', '', 0);
      mention.attrSet('id', match[1]!);
      mention.attrSet('label', label);
      out.push(mention);
      i = close;
    }
    block.children = out;
  }
}

/** markdown-it, then the four token passes that bring it to the page schema. */
const pageTokenizer = {
  parse(source: string, env: unknown): Token[] {
    const tokens = markdownIt.parse(source, env);
    markTaskLists(tokens);
    markWorkItemMentions(tokens);
    return liftImages(wrapTableCells(tokens));
  },
} as unknown as ConstructorParameters<typeof MarkdownParser>[1];

const pageMarkdownParser = new MarkdownParser(pageSchema, pageTokenizer, {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'listItem' },
  bullet_list: { block: 'bulletList' },
  ordered_list: {
    block: 'orderedList',
    getAttrs: (tok) => ({ start: Number(tok.attrGet('start')) || 1 }),
  },
  task_list: { block: 'taskList' },
  task_item: {
    block: 'taskItem',
    getAttrs: (tok) => ({ checked: tok.attrGet('checked') === 'true' }),
  },
  heading: {
    block: 'heading',
    // The schema stops at level 3; a deeper heading keeps its place as a 3.
    getAttrs: (tok) => ({ level: Math.min(Number(tok.tag.slice(1)), 3) }),
  },
  code_block: { block: 'codeBlock', noCloseToken: true },
  fence: {
    block: 'codeBlock',
    getAttrs: (tok) => ({ language: tok.info.trim().split(/\s+/)[0] || null }),
    noCloseToken: true,
  },
  hr: { node: 'horizontalRule' },
  image: {
    node: 'image',
    getAttrs: (tok) => ({
      src: tok.attrGet('src'),
      alt: tok.children?.[0]?.content || null,
      title: tok.attrGet('title') || null,
    }),
  },
  hardbreak: { node: 'hardBreak' },
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'tableRow' },
  th: { block: 'tableHeader' },
  td: { block: 'tableCell' },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  s: { mark: 'strike' },
  link: {
    mark: 'link',
    getAttrs: (tok) => ({ href: tok.attrGet('href'), title: tok.attrGet('title') || null }),
  },
  code_inline: { mark: 'code', noCloseToken: true },
  work_item_mention: {
    node: 'workItemMention',
    getAttrs: (tok) => ({ id: tok.attrGet('id'), label: tok.attrGet('label') || null }),
  },
});

/** Parse markdown into a page document. */
export function parseMarkdown(markdown: string): ProseMirrorNode {
  return pageMarkdownParser.parse(markdown);
}

// ── Serializing ──────────────────────────────────────────────────────────────

const defaults = defaultMarkdownSerializer.nodes;

/** A cell's content as one line of GFM: blocks joined by `<br>`, pipes escaped. */
function cellMarkdown(cell: ProseMirrorNode): string {
  return (
    pageMarkdownSerializer
      .serialize(pageSchema.topNodeType.create(null, cell.content), SERIALIZE_OPTIONS)
      .split('\n')
      .filter((line) => line.length > 0)
      .join('<br>')
      // The cell is ALREADY serialized markdown, so its backslashes are escapes
      // the serializer wrote; escaping them again would double them. Only the
      // pipe — the one character the table syntax claims — is escaped here.
      .split('|')
      .join('\\|')
  );
}

function renderTable(state: MarkdownSerializerState, node: ProseMirrorNode): void {
  const rows: string[][] = [];
  node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cellMarkdown(cell)));
    rows.push(cells);
  });
  const width = Math.max(...rows.map((cells) => cells.length));
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  // GFM requires a header row; the table's first row is it.
  const [head = [], ...body] = rows;
  const lines = [line(head), line(Array.from({ length: width }, () => '---')), ...body.map(line)];
  state.write(lines.join('\n'));
  state.closeBlock(node);
}

const pageMarkdownSerializer: MarkdownSerializer = new MarkdownSerializer(
  {
    doc: (state, node) => state.renderContent(node),
    paragraph: defaults.paragraph!,
    blockquote: defaults.blockquote!,
    heading: defaults.heading!,
    horizontalRule: (state, node) => {
      state.write('---');
      state.closeBlock(node);
    },
    codeBlock: (state, node) => {
      const backticks = node.textContent.match(/`{3,}/gm);
      const fence = backticks ? `${backticks.sort().slice(-1)[0]}\`` : '```';
      state.write(`${fence}${(node.attrs.language as string | null) ?? ''}\n`);
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write(fence);
      state.closeBlock(node);
    },
    bulletList: (state, node) => state.renderList(node, '  ', () => '- '),
    orderedList: (state, node) => {
      const start = (node.attrs.start as number) || 1;
      const width = String(start + node.childCount - 1).length;
      const space = state.repeat(' ', width + 2);
      state.renderList(node, space, (i) => {
        const n = String(start + i);
        return `${state.repeat(' ', width - n.length)}${n}. `;
      });
    },
    listItem: (state, node) => state.renderContent(node),
    taskList: (state, node) => state.renderList(node, '  ', () => '- '),
    taskItem: (state, node) => {
      state.write(node.attrs.checked ? '[x] ' : '[ ] ');
      state.renderContent(node);
    },
    image: (state, node) => {
      const alt = state.esc((node.attrs.alt as string | null) ?? '');
      const src = String(node.attrs.src ?? '').replace(/[\\()]/g, '\\$&');
      const title = node.attrs.title as string | null;
      state.write(`![${alt}](${src}${title ? ` "${title.replace(/[\\"]/g, '\\$&')}"` : ''})`);
      state.closeBlock(node);
    },
    hardBreak: defaults.hard_break!,
    table: renderTable,
    // Rendered by `renderTable`; never reached on their own.
    tableRow: (state, node) => state.renderContent(node),
    tableHeader: (state, node) => state.renderContent(node),
    tableCell: (state, node) => state.renderContent(node),
    // The description editor's durable token, byte for byte, so a page body
    // and a description carry a mention the same way (MOTIR-7570).
    workItemMention: (state, node) => {
      state.write(
        `[${(node.attrs.label as string | null) ?? ''}](motir:${node.attrs.id as string})`,
      );
    },
    text: defaults.text!,
  },
  {
    italic: defaultMarkdownSerializer.marks.em!,
    bold: defaultMarkdownSerializer.marks.strong!,
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    link: defaultMarkdownSerializer.marks.link!,
    code: defaultMarkdownSerializer.marks.code!,
  },
);

// The schema's lists carry no `tight` attribute, so every list is written
// tight — the form the editor's lists read as and the agents write.
const SERIALIZE_OPTIONS = { tightLists: true };

/** Serialize a page document to markdown. */
export function serializeMarkdown(doc: ProseMirrorNode): string {
  return pageMarkdownSerializer.serialize(doc, SERIALIZE_OPTIONS);
}
