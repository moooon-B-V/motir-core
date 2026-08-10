import { Fragment, type ReactNode } from 'react';
import type { GuideBlock } from '@/lib/apiDocs/guide';
import { CodeBlock } from './CodeBlock';

// The three block kinds the guide and the policy are written in (Story 11.4 ·
// Subtask 11.4.8 — MOTIR-2189; design Panels 4–5: "numbered heading → one short
// paragraph → one code block → a callout only where a reader would otherwise get
// it wrong").
//
// Prose carries `**bold**` and `` `code` `` because a policy sentence about a
// field name is unreadable without them. A markdown RENDERER is deliberately not
// used: `lib/markdown/render.tsx` is the single source for USER-authored
// markdown, and reaching for it here would put a full markdown surface (links,
// images, HTML) in a document we author ourselves, where two inline marks are
// the whole requirement.

/**
 * The two marks, as a split.
 *
 * Bold is `[\s\S]+?` — anything, lazily — and NOT the `[^*]+` it started as.
 * That character class made "asterisk-free" part of what a bold run IS, so a
 * bold sentence quoting a glob (`` `*.ts` ``) simply failed to match and printed
 * its own asterisks. The alternation order does the work the class was doing:
 * the leftmost match wins, so a code span that OPENS first is matched whole and
 * a `**` inside it is never a bold delimiter (MOTIR-2616).
 */
const INLINE_MARKS = /(\*\*[\s\S]+?\*\*|`[^`]+`)/g;

/**
 * `**bold**` and `` `code` `` — the two marks this document set uses.
 *
 * The bold arm RECURSES. Emitting `part.slice(2, -2)` as a raw string child was
 * a one-level-deep read of a document set whose authors reasonably assume the
 * two marks nest, so every `**bold `filename`**` printed its backticks on the
 * shipped page. Feeding the run back through here makes a code span inside bold
 * a real `<code>` inside the `<strong>`.
 *
 * The code arm stays LITERAL, and that asymmetry is the point: code means "these
 * exact characters", so a `**` inside a code span is two asterisks a reader is
 * meant to see. A symmetric fix would be a renderer that has quietly stopped
 * rendering one of its two marks.
 */
function renderInline(text: string): ReactNode[] {
  return text.split(INLINE_MARKS).map((part, index) => {
    // The length guards are what separate a MATCHED run from a lone `**` or a
    // lone backtick sitting in ordinary text — both of which pass a
    // startsWith/endsWith pair on their own and would otherwise render as an
    // empty element, swallowing the character the author typed.
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} className="font-semibold text-(--el-text)">
          {renderInline(part.slice(2, -2))}
        </strong>
      );
    }
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={index}
          className="rounded-(--radius-kbd) bg-(--el-code-bg) px-1.5 py-px font-mono text-[12.5px] text-(--el-code-text)"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

/**
 * The two inline marks, for a caller laying out its OWN paragraph.
 *
 * Added by Story MOTIR-2309 (the MCP guide), whose per-client footnotes sit
 * inline beside a link and so cannot be a `prose` block. Without this they were
 * rendering `**name**` and backticks literally — the same marks every other
 * string in this document set carries, silently untreated because the caller had
 * laid out its own `<p>`. One treatment for the whole surface beats a second one
 * the next page hand-rolls.
 */
export function DocInline({ text }: { text: string }) {
  return <>{renderInline(text)}</>;
}

/** One authored block. */
export function DocBlock({ block }: { block: GuideBlock }) {
  if (block.kind === 'prose') {
    return (
      <p className="mb-3 max-w-[68ch] text-sm leading-relaxed text-(--el-text-secondary)">
        {renderInline(block.text)}
      </p>
    );
  }
  if (block.kind === 'code') {
    return (
      <div className="mb-4">
        <CodeBlock
          caption={block.caption}
          code={block.code}
          {...(block.copyable ? { copyable: true } : {})}
        />
      </div>
    );
  }
  if (block.kind === 'table') {
    return <DocTable block={block} />;
  }
  return (
    <div
      className={
        block.tone === 'warning'
          ? 'mb-4 flex max-w-[68ch] gap-2.5 rounded-(--radius-card) bg-(--el-tint-peach) px-3.5 py-3 text-[13.5px] leading-relaxed text-(--el-text-strong)'
          : 'mb-4 flex max-w-[68ch] gap-2.5 rounded-(--radius-card) bg-(--el-tint-sky) px-3.5 py-3 text-[13.5px] leading-relaxed text-(--el-text-strong)'
      }
    >
      {/* Decorative: the tone is already carried by the words. */}
      <span aria-hidden>{block.tone === 'warning' ? '▲' : '◆'}</span>
      <span>{renderInline(block.text)}</span>
    </div>
  );
}

/**
 * The `table` kind, at two widths.
 *
 * ⚠️ TWO renderings, not one responsive table. Squeezing four columns of paths
 * into a phone produces something unreadable, and dropping a column hides
 * exactly the fact a reader came to compare — so below the docs breakpoint the
 * same rows render as one card per row, with every cell keeping its column name
 * as its label. Each rendering is `display: none` at the other width, so a
 * screen reader is offered one of them, never both.
 */
function DocTable({ block }: { block: Extract<GuideBlock, { kind: 'table' }> }) {
  return (
    <div className="mb-5">
      {block.caption ? (
        <p className="mb-1.5 font-mono text-[11px] tracking-wide text-(--el-text-secondary) uppercase">
          {block.caption}
        </p>
      ) : null}

      {/* Wide: the same `table.spec` grammar the operation tables use. */}
      <table className="hidden w-full border-collapse text-[13px] md:table">
        <thead>
          <tr>
            {block.columns.map((column, index) => (
              <th
                key={index}
                scope="col"
                // The optional width is WIDE-ONLY and per column; the narrow arm
                // below is a `<dl>` and has no columns to size. See the
                // `columnWidths` note on `GuideBlock`.
                className={`border-b border-(--el-border) px-2.5 py-1.5 text-left font-sans text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase${
                  block.columnWidths?.[index] ? ` ${block.columnWidths[index]}` : ''
                }`}
              >
                {renderInline(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border-b border-(--el-border-soft) px-2.5 py-2 align-top leading-relaxed text-(--el-text-secondary)"
                >
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Narrow: one card per row; the column name becomes each cell's label. */}
      <div className="md:hidden">
        {block.rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="mb-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface) px-3 py-2.5"
          >
            <dl className="m-0 grid grid-cols-[minmax(0,5.5rem)_1fr] gap-x-2.5 gap-y-1">
              {row.map((cell, cellIndex) => (
                <Fragment key={cellIndex}>
                  <dt className="pt-0.5 text-[11px] tracking-wide text-(--el-text-secondary) uppercase">
                    {block.columns[cellIndex] ?? ''}
                  </dt>
                  <dd className="m-0 min-w-0 text-[12.5px] leading-relaxed break-words text-(--el-text-secondary)">
                    {renderInline(cell)}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A run of blocks. */
export function DocBlocks({ blocks }: { blocks: readonly GuideBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <DocBlock key={index} block={block} />
      ))}
    </>
  );
}
