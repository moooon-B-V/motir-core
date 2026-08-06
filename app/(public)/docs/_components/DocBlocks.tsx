import type { ReactNode } from 'react';
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

/** `**bold**` and `` `code` `` — the two marks this document set uses. */
function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} className="font-semibold text-(--el-text)">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
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
