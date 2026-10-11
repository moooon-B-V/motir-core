import { describe, expect, it } from 'vitest';
import {
  renderSharpenedBlock,
  SHARPENED_BLOCK_END,
  SHARPENED_BLOCK_START,
  upsertSharpenedBlock,
} from '@/lib/sharpening/managedBlock';

// Task MOTIR-1101 · Subtask MOTIR-8183 — the sharpened block a Sharpen write-back
// owns inside a hand-written Markdown body. Pure, so pinned without a database.

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const HAND_WRITTEN = [
  '# Export invoices',
  '',
  'Intro paragraph a person wrote.',
  '',
  '## Acceptance criteria',
  '',
  '- The person can export one invoice.',
  '- Hand-written criterion two.',
  '',
  '## Notes',
  '',
  'Keep this exactly.',
  '',
].join('\n');

describe('upsertSharpenedBlock — insert', () => {
  it('adds exactly one block under an existing heading, after its hand-written text', () => {
    const out = upsertSharpenedBlock(HAND_WRITTEN, 'Acceptance criteria', '- Settled one');
    expect(count(out, SHARPENED_BLOCK_START)).toBe(1);
    expect(count(out, SHARPENED_BLOCK_END)).toBe(1);
    expect(out).toBe(
      HAND_WRITTEN.replace(
        '- Hand-written criterion two.\n',
        `- Hand-written criterion two.\n\n${renderSharpenedBlock('- Settled one')}\n`,
      ),
    );
    // The block sits inside its own section, before the next heading.
    expect(out.indexOf(SHARPENED_BLOCK_START)).toBeLessThan(out.indexOf('## Notes'));
    expect(out.indexOf(SHARPENED_BLOCK_START)).toBeGreaterThan(out.indexOf('## Acceptance'));
  });

  it('creates the heading at the end when the body lacks it', () => {
    const out = upsertSharpenedBlock(HAND_WRITTEN, 'Assumptions', '- Planner guessed');
    expect(out.startsWith(HAND_WRITTEN)).toBe(true);
    expect(out.slice(HAND_WRITTEN.length)).toBe(
      `\n## Assumptions\n\n${renderSharpenedBlock('- Planner guessed')}\n`,
    );
  });

  it('separates an appended heading from a body that does not end in a newline', () => {
    const out = upsertSharpenedBlock('Just a line', 'Assumptions', 'x');
    expect(out).toBe(`Just a line\n\n## Assumptions\n\n${renderSharpenedBlock('x')}\n`);
  });

  it('writes heading and block into an empty body', () => {
    expect(upsertSharpenedBlock('', 'Acceptance criteria', 'x')).toBe(
      `## Acceptance criteria\n\n${renderSharpenedBlock('x')}\n`,
    );
  });

  it('fills a heading whose section is empty, without touching the next heading', () => {
    const body = '## Acceptance criteria\n## Notes\nkeep\n';
    const out = upsertSharpenedBlock(body, 'Acceptance criteria', 'x');
    expect(out).toBe(`## Acceptance criteria\n\n${renderSharpenedBlock('x')}\n## Notes\nkeep\n`);
  });

  it('matches the heading case-insensitively and ignores one inside a code fence', () => {
    const body = '```md\n## Acceptance criteria\n```\n\n## ACCEPTANCE CRITERIA\n\n- a\n';
    const out = upsertSharpenedBlock(body, 'Acceptance criteria', 'x');
    expect(out).toBe(
      '```md\n## Acceptance criteria\n```\n\n## ACCEPTANCE CRITERIA\n\n- a\n\n' +
        `${renderSharpenedBlock('x')}\n`,
    );
  });
});

describe('upsertSharpenedBlock — replace', () => {
  it('replaces an existing block and leaves exactly one', () => {
    const once = upsertSharpenedBlock(HAND_WRITTEN, 'Acceptance criteria', '- Old answer');
    const twice = upsertSharpenedBlock(once, 'Acceptance criteria', '- New answer\n- Another');
    expect(count(twice, SHARPENED_BLOCK_START)).toBe(1);
    expect(twice).toContain(renderSharpenedBlock('- New answer\n- Another'));
    expect(twice).not.toContain('Old answer');
  });

  it('keeps one block per section when two sections carry one each', () => {
    let body = upsertSharpenedBlock(HAND_WRITTEN, 'Acceptance criteria', '- A');
    body = upsertSharpenedBlock(body, 'Assumptions', '- B');
    body = upsertSharpenedBlock(body, 'Acceptance criteria', '- A2');
    body = upsertSharpenedBlock(body, 'Assumptions', '- B2');
    expect(count(body, SHARPENED_BLOCK_START)).toBe(2);
    expect(body).toContain(renderSharpenedBlock('- A2'));
    expect(body).toContain(renderSharpenedBlock('- B2'));
    // Each section's block stays in its own section.
    const notes = body.indexOf('## Notes');
    expect(body.indexOf(renderSharpenedBlock('- A2'))).toBeLessThan(notes);
    expect(body.indexOf(renderSharpenedBlock('- B2'))).toBeGreaterThan(notes);
  });
});

describe('upsertSharpenedBlock — idempotence and preservation', () => {
  it.each([
    ['an existing heading', 'Acceptance criteria'],
    ['a missing heading', 'Assumptions'],
  ])('is byte-identical when run twice with the same input (%s)', (_label, heading) => {
    const once = upsertSharpenedBlock(HAND_WRITTEN, heading, '- Same\n- Answers');
    expect(upsertSharpenedBlock(once, heading, '- Same\n- Answers')).toBe(once);
  });

  it('leaves every byte outside the delimiters unchanged, hand-written text under the heading included', () => {
    const first = upsertSharpenedBlock(HAND_WRITTEN, 'Acceptance criteria', '- One');
    const second = upsertSharpenedBlock(first, 'Acceptance criteria', '- Two\n- Three');
    const outside = (s: string) =>
      s.slice(0, s.indexOf(SHARPENED_BLOCK_START)) +
      s.slice(s.indexOf(SHARPENED_BLOCK_END) + SHARPENED_BLOCK_END.length);
    expect(outside(second)).toBe(outside(first));
    expect(second).toContain('- Hand-written criterion two.');
    expect(second).toContain('Intro paragraph a person wrote.');
    expect(second.endsWith('## Notes\n\nKeep this exactly.\n')).toBe(true);
  });

  it('drops trailing newlines of the content so the block has one shape', () => {
    expect(renderSharpenedBlock('- a\n\n')).toBe(
      `${SHARPENED_BLOCK_START}\n- a\n${SHARPENED_BLOCK_END}`,
    );
  });
});
