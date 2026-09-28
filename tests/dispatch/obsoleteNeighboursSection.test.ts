import { describe, expect, it } from 'vitest';
import {
  assembleDispatchPrompt,
  obsolescenceNoteFirstLine,
  OBSOLESCENCE_NOTE_LINE_CHARS,
  type DispatchPromptSource,
  type ObsoleteNeighbour,
} from '@/lib/dispatch/promptTemplate';

// The OBSOLETE-NEIGHBOUR lines in the dispatch prompt's CONTEXT (Story MOTIR-6576 ·
// Subtask MOTIR-6657) — PURE: the assembler reads nothing, so these fix the TEXT.
// The service half, which finds the marked neighbours in the real database, is
// `obsoleteNeighboursRead.test.ts`.

function source(over: Partial<DispatchPromptSource> = {}): DispatchPromptSource {
  return {
    key: 'PROD-7',
    title: 'Add the ready-set filter bar',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    difficulty: null,
    priority: 'high',
    storyPoints: 3,
    estimateMinutes: 40,
    descriptionMd: ['Build it.', '', '## Context refs', '', '- `lib/dto/ready.ts` — the DTO'].join(
      '\n',
    ),
    blockerKeys: ['PROD-3'],
    openDependentKeys: [],
    parent: { key: 'PROD-2', title: 'Ready surface' },
    projectName: 'Motir',
    projectKey: 'PROD',
    targetRepo: 'motir-core',
    sessionBranch: null,
    ...over,
  };
}

function neighbour(over: Partial<ObsoleteNeighbour> = {}): ObsoleteNeighbour {
  return {
    role: 'parent',
    key: 'PROD-2',
    title: 'Ready surface',
    mark: 'outdated',
    supersededByKeys: ['PROD-9'],
    noteFirstLine: 'Replaced by the board filter.',
    ...over,
  };
}

const GUIDANCE =
  "  An OUTDATED item's body is history: read what it does now from the items that" +
  ' superseded it. A DEPRECATED one was retired on purpose: do not build on it.';

describe('the obsolete-neighbour CONTEXT lines (MOTIR-6657)', () => {
  it('an unmarked neighbourhood renders byte-identically to a source without the field', () => {
    const without = assembleDispatchPrompt(source()).prompt;
    expect(assembleDispatchPrompt(source({ obsoleteNeighbours: [] })).prompt).toBe(without);
    expect(without).not.toMatch(/^- ⚠ /m);
    expect(without).not.toContain('superseded it');
  });

  it('a marked parent renders ONE line — role, key, mark, superseder, note — then the guidance once', () => {
    const { prompt } = assembleDispatchPrompt(source({ obsoleteNeighbours: [neighbour()] }));
    expect(prompt).toContain(
      '- ⚠ parent PROD-2 is OUTDATED — superseded by PROD-9. Replaced by the board filter.',
    );
    expect(prompt.split(GUIDANCE)).toHaveLength(2);
  });

  it('sits directly under the context refs, in the order it is given', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        obsoleteNeighbours: [
          neighbour(),
          neighbour({ role: 'blocker', key: 'PROD-3', mark: 'deprecated', supersededByKeys: [] }),
          neighbour({ role: 'context ref', key: 'PROD-4', supersededByKeys: ['PROD-5', 'PROD-6'] }),
        ],
      }),
    );
    const lines = prompt.split('\n');
    const ref = lines.indexOf('    - lib/dto/ready.ts');
    expect(lines.slice(ref + 1, ref + 5)).toEqual([
      '- ⚠ parent PROD-2 is OUTDATED — superseded by PROD-9. Replaced by the board filter.',
      '- ⚠ blocker PROD-3 is DEPRECATED — superseded by nothing recorded. Replaced by the board filter.',
      '- ⚠ context ref PROD-4 is OUTDATED — superseded by PROD-5, PROD-6. Replaced by the board filter.',
      GUIDANCE,
    ]);
  });

  it('a neighbour with no note ends at the superseders, with no trailing space', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ obsoleteNeighbours: [neighbour({ noteFirstLine: null })] }),
    );
    expect(prompt).toMatch(/^- ⚠ parent PROD-2 is OUTDATED — superseded by PROD-9\.$/m);
  });

  it('a card with no context refs still carries the lines, under the none-named line', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ descriptionMd: 'Build it.', obsoleteNeighbours: [neighbour()] }),
    );
    const lines = prompt.split('\n');
    const none = lines.indexOf('- Context refs: none named on the card.');
    expect(lines[none + 1]).toMatch(/^- ⚠ parent PROD-2/);
  });
});

describe('obsolescenceNoteFirstLine', () => {
  it('is null for an absent, empty or blank note', () => {
    expect(obsolescenceNoteFirstLine(null)).toBeNull();
    expect(obsolescenceNoteFirstLine(undefined)).toBeNull();
    expect(obsolescenceNoteFirstLine('')).toBeNull();
    expect(obsolescenceNoteFirstLine(' \n\n  \n')).toBeNull();
  });

  it('takes the first NON-EMPTY line, Markdown left as written', () => {
    expect(obsolescenceNoteFirstLine('\n\n  **Replaced** by `PROD-9`.  \nSecond line.')).toBe(
      '**Replaced** by `PROD-9`.',
    );
  });

  it('caps the line with an ellipsis, and leaves one at the cap alone', () => {
    const exact = 'x'.repeat(OBSOLESCENCE_NOTE_LINE_CHARS);
    expect(obsolescenceNoteFirstLine(exact)).toBe(exact);
    expect(obsolescenceNoteFirstLine(`${exact}y`)).toBe(`${exact}…`);
  });
});
