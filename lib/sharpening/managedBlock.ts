// The SHARPENED block (Task MOTIR-1101 · Subtask MOTIR-8183) — how a Sharpen
// write-back puts the answers a person settled into a Markdown body that a person
// also writes by hand (a work item's description, an `add` proposal's body).
//
// The write-back owns exactly ONE delimited block per `##` section and nothing
// else. Replacing that block is how a cumulative write stays idempotent: the
// second call with the same answers produces the same bytes, a superset replaces
// the block rather than appending a second one, and every byte a person wrote —
// including text under the same heading — is left exactly as it was.
//
// PURE: no I/O. The write-back service (MOTIR-8175) is the only caller.

export const SHARPENED_BLOCK_START = '<!-- motir:sharpened:start -->';
export const SHARPENED_BLOCK_END = '<!-- motir:sharpened:end -->';

/** The block as it is written: the two markers around the content. */
export function renderSharpenedBlock(content: string): string {
  return `${SHARPENED_BLOCK_START}\n${content.replace(/\n+$/, '')}\n${SHARPENED_BLOCK_END}`;
}

interface Line {
  text: string;
  /** Offset of the line's first character in the body. */
  start: number;
  /** Offset just past the line's terminator (or the body's end). */
  end: number;
}

function splitLines(body: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < body.length) {
    const nl = body.indexOf('\n', start);
    const end = nl === -1 ? body.length : nl + 1;
    lines.push({ text: body.slice(start, nl === -1 ? body.length : nl), start, end });
    start = end;
  }
  return lines;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const ATX_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** A heading line OUTSIDE a fenced code block: its level and its text. */
function headingsOf(lines: Line[]): Array<{ index: number; level: number; text: string }> {
  const out: Array<{ index: number; level: number; text: string }> = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line.text)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const m = ATX_HEADING.exec(line.text);
    if (m) out.push({ index, level: m[1]!.length, text: m[2]!.trim() });
  });
  return out;
}

function sameHeading(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Put `content` into the sharpened block under the `## <heading>` section of
 * `body`:
 *
 * - the section already holds a block → that block's bytes are replaced, and
 *   nothing else moves;
 * - the section has no block → one is inserted after the section's last
 *   non-blank text, before whatever follows it;
 * - the body has no such heading → `## <heading>` and the block are appended at
 *   the end.
 *
 * Only the FIRST `##` heading with that text is used, and headings inside fenced
 * code blocks are ignored. Applying the same arguments twice yields the same
 * body.
 */
export function upsertSharpenedBlock(body: string, heading: string, content: string): string {
  const block = renderSharpenedBlock(content);
  const lines = splitLines(body);
  const headings = headingsOf(lines);
  const at = headings.findIndex((h) => h.level === 2 && sameHeading(h.text, heading));

  if (at === -1) {
    if (body.length === 0) return `## ${heading}\n\n${block}\n`;
    const sep = body.endsWith('\n') ? '\n' : '\n\n';
    return `${body}${sep}## ${heading}\n\n${block}\n`;
  }

  const headingLine = lines[headings[at]!.index]!;
  // The section runs to the next heading of the same or a higher level.
  const next = headings.slice(at + 1).find((h) => h.level <= 2);
  const sectionEnd = next ? lines[next.index]!.start : body.length;
  const section = body.slice(headingLine.end, sectionEnd);

  const startAt = section.indexOf(SHARPENED_BLOCK_START);
  if (startAt !== -1) {
    const endAt = section.indexOf(SHARPENED_BLOCK_END, startAt);
    if (endAt !== -1) {
      const from = headingLine.end + startAt;
      const to = headingLine.end + endAt + SHARPENED_BLOCK_END.length;
      return body.slice(0, from) + block + body.slice(to);
    }
  }

  // No block yet: insert after the section's last non-blank character, so the
  // whitespace that separates it from the next heading stays where it was.
  const trimmed = section.replace(/\s+$/, '');
  if (trimmed.length === 0) {
    const insertAt = headingLine.end;
    const lead = body.slice(0, insertAt).endsWith('\n') ? '\n' : '\n\n';
    return body.slice(0, insertAt) + lead + block + '\n' + body.slice(insertAt);
  }
  const insertAt = headingLine.end + trimmed.length;
  return body.slice(0, insertAt) + '\n\n' + block + body.slice(insertAt);
}
