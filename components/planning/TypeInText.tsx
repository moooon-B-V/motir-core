'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import {
  TYPEWRITER_CAP_MS,
  TYPEWRITER_CHAR_INTERVAL_MS,
  parseCssTime,
  typedLength,
  type TypeInPhase,
} from '@/lib/planning/typeIn';

// ONE FIELD TYPING ITSELF IN (Story MOTIR-8590 · Subtask MOTIR-8595; design
// `design/ai-planning/design-notes.md` Part XXVIII §28.6, §28.7).
//
// The FINAL element — the field's own shipped rendering (`children`) — is in the
// tree from the moment the field arrives, `sr-only` while it types, and it is the
// SAME node when it lands: a screen reader never meets a partial value, and
// nothing is re-announced. What a sighted reader watches is an `aria-hidden`,
// `inert` COPY of that element with its text nodes cut at the cursor, so a list
// item or a bold run appears inside its real block and nothing reflows when the
// copy is swapped for the final element. A static caret sits at the cursor; it
// does not blink, because a blink is a loop.
//
// It decides nothing about WHICH field types or WHEN: the phase is the panel's
// (`lib/planning/typeIn.ts`), and `onDone` hands the turn back.

const CARET_CLASS = 'inline-block h-[1em] w-0.5 align-text-bottom bg-(--el-accent-on-surface)';

/** Cuts `root`'s text at `budget` characters, removing everything after the cursor,
 *  and returns the text node the cursor sits at the end of. The first text node is
 *  always kept (emptied at a zero budget), so the caret sits inside the field's
 *  own block from the very first frame. */
function cutAt(
  root: Node,
  budget: number,
  at: Text | null = null,
): { left: number; at: Text | null } {
  let left = budget;
  for (const child of [...root.childNodes]) {
    if (left <= 0 && at) {
      root.removeChild(child);
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child as Text;
      if (text.data.length > left) text.data = text.data.slice(0, left);
      left -= text.data.length;
      at = text;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      (child as Element).removeAttribute('id');
      ({ left, at } = cutAt(child, left, at));
    }
  }
  return { left, at };
}

function cssMs(el: Element, name: string, fallback: number): number {
  const raw = getComputedStyle(el).getPropertyValue(name);
  return parseCssTime(raw) ?? fallback;
}

export function TypeInText({
  phase,
  children,
  placeholder = null,
  onDone,
  testId,
}: {
  phase: TypeInPhase;
  /** The field's final, shipped rendering. */
  children: ReactNode;
  /** What shows while the field waits its turn: the shipped empty treatment. */
  placeholder?: ReactNode;
  onDone: () => void;
  testId?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const finalRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (phase !== 'typing') return;
    const root = rootRef.current;
    const source = finalRef.current;
    const copy = copyRef.current;
    if (!root || !source || !copy) return;
    const paceMs = cssMs(root, '--typewriter-char-interval', TYPEWRITER_CHAR_INTERVAL_MS);
    const slowMs = cssMs(root, '--transition-slow', TYPEWRITER_CAP_MS / 3);
    const capMs = slowMs * 3;
    const total = source.textContent?.length ?? 0;
    const start = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      const shown = typedLength(total, now - start, paceMs, capMs);
      if (shown >= total) {
        copy.replaceChildren();
        onDoneRef.current();
        return;
      }
      const clone = document.createElement('div');
      for (const node of source.childNodes) clone.appendChild(node.cloneNode(true));
      const { at } = cutAt(clone, shown);
      const caret = document.createElement('span');
      caret.className = CARET_CLASS;
      caret.setAttribute('data-typewriter-caret', '');
      // A field with any text to type always yields a cursor node.
      at?.parentNode?.insertBefore(caret, at.nextSibling);
      copy.replaceChildren(...clone.childNodes);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      copy.replaceChildren();
    };
  }, [phase]);

  const hidden = phase === 'typing' || phase === 'queued';
  return (
    <div
      ref={rootRef}
      data-testid={testId}
      data-typewriter={phase === 'final' ? 'final' : phase === 'typing' ? 'typing' : 'waiting'}
      className="min-w-0"
    >
      <div ref={finalRef} className={hidden ? 'sr-only' : undefined}>
        {children}
      </div>
      {phase === 'queued' ? <div aria-hidden="true">{placeholder}</div> : null}
      {phase === 'typing' ? (
        <div ref={copyRef} aria-hidden="true" inert data-typewriter-copy="" />
      ) : null}
    </div>
  );
}
