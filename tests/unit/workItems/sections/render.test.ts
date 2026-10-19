import { describe, expect, it } from 'vitest';
import { ISSUE_TYPES } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { parseChoiceOptions } from '@/lib/approvalGates/choiceOptions';
import { splitPlanBody } from '@/lib/markdown/planBody';
import { acceptanceCriteriaSpan, acceptanceCriteriaTexts } from '@/lib/workItems/proseVsGraph';
import { renderSections } from '@/lib/workItems/sections/render';
import {
  sectionSetFor,
  type SectionType,
  type WorkItemSections,
} from '@/lib/workItems/sections/registry';
import { extractScopeBoundary } from './helpers/extractScopeBoundary';

const TYPES: SectionType[] = [null, ...WORK_ITEM_TYPES];

const CRITERIA = [
  'First criterion',
  'Second criterion\nwith a continuation line',
  'Third criterion',
];
const REFS = [
  { ref: 'lib/a/b.ts', why: 'the plain path' },
  { ref: '`lib/c.ts`', why: 'already backticked' },
  { ref: '[The registry](motir:cmabc123)', why: 'a chip whose why has `code` and - dashes' },
];
const REF_PATHS = ['lib/a/b.ts', 'lib/c.ts', 'motir:cmabc123'];

function fixture(kind: (typeof ISSUE_TYPES)[number], type: SectionType): WorkItemSections {
  const set = sectionSetFor(kind, type);
  const all: WorkItemSections = {
    framing: 'The framing paragraph.',
    question: 'What should we do?',
    why: { situation: 'two_workflows', evidence: 'It forks.' },
    options: [{ label: 'A', cost: 'low', forecloses: 'nothing' }],
    choiceOptions: [
      { label: 'Alpha', bestFor: 'speed', why: 'Because.' },
      { label: 'Beta', bestFor: 'safety' },
    ],
    recommendation: 'Take A.',
    states: ['empty', 'loaded'],
    cases: [{ condition: 'c', expected: 'e' }],
    tier: 'unit',
    strings: [{ key: 'k', locale: 'en', says: 'Hello' }],
    reproduction: 'Do the thing.',
    deliverables: 'A file.',
    approach: 'Carefully.',
    outline: 'One, two.',
    home: 'docs/x.md',
    steps: 'Step one.',
    postDeployVerification: 'Check it.',
    rollback: 'Revert.',
    verificationRecipe: 'Run it.',
    assumptions: ['One assumption'],
    gates: 'Follow-up work.',
    scopeBoundary: 'The boundary text.',
    acceptanceCriteria: CRITERIA,
    contextRefs: REFS,
  };
  return Object.fromEntries(
    Object.entries(all).filter(([name]) => set.sections.includes(name as never)),
  );
}

describe('renderSections — every kind x type cell', () => {
  for (const kind of ISSUE_TYPES) {
    for (const type of TYPES) {
      it(`${kind} / ${type ?? 'null'} is read back by the three parsers`, () => {
        const sections = fixture(kind, type);
        const out = renderSections(kind, type, sections);
        const defines = sectionSetFor(kind, type).sections.includes('acceptanceCriteria');

        const split = splitPlanBody(out);
        expect(split.contextRefs).toEqual(REF_PATHS.slice(0, sections.contextRefs?.length ?? 0));
        if (defines) {
          expect(split.acceptanceCriteria.join('\n')).toContain('First criterion');
          expect(acceptanceCriteriaTexts(out)).toHaveLength(CRITERIA.length);
          expect(acceptanceCriteriaSpan(out)).not.toBeNull();
        } else {
          expect(acceptanceCriteriaSpan(out)).toBeNull();
          expect(acceptanceCriteriaTexts(out)).toEqual([]);
        }
        expect(extractScopeBoundary(out)).toBe('The boundary text.');
      });
    }
  }

  it('a choice is read by parseChoiceOptions without defects', () => {
    const out = renderSections('task', 'choice', fixture('task', 'choice'));
    const parsed = parseChoiceOptions(out);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options.map((o) => o.label)).toEqual(['Alpha', 'Beta']);
    }
  });
});

describe('renderSections — hostile input', () => {
  const base = fixture('task', 'code');
  const expectIntact = (out: string) => {
    expect(acceptanceCriteriaTexts(out)).toHaveLength(CRITERIA.length);
    expect(splitPlanBody(out).contextRefs).toEqual(REF_PATHS);
    expect(extractScopeBoundary(out)).toBe('The boundary text.');
  };

  it('a framing with every line prefixed by "| " hides nothing', () => {
    expectIntact(
      renderSections('task', 'code', {
        ...base,
        framing: '| line one\n| line two\n| ## Acceptance criteria',
      }),
    );
  });

  it('a framing carrying our own headings fakes no section', () => {
    expectIntact(
      renderSections('task', 'code', {
        ...base,
        framing: 'Intro\n## Acceptance criteria\n- fake\n### Scope BOUNDARY\nfake',
      }),
    );
  });

  it('a criterion with an embedded heading line stays one criterion', () => {
    const out = renderSections('task', 'code', {
      ...base,
      acceptanceCriteria: ['First\n## X\nafter', 'Second', 'Third'],
    });
    expect(acceptanceCriteriaTexts(out)).toHaveLength(3);
  });

  it('a scopeBoundary containing a heading is not cut short', () => {
    const out = renderSections('task', 'code', {
      ...base,
      scopeBoundary: 'Before\n## Notes\nAfter',
    });
    expect(extractScopeBoundary(out)).toBe('Before\n\\## Notes\nAfter');
  });

  it('neutralises a heading line with a backslash and keeps its text', () => {
    const out = renderSections('task', 'code', { ...base, framing: 'a\n## Heading text\nb' });
    expect(out).toContain('\n\\## Heading text\n');
  });

  it('neutralises a heading indented one to three spaces', () => {
    for (const indent of [' ', '  ', '   ']) {
      const out = renderSections('task', 'code', { ...base, framing: `a\n${indent}## Indented` });
      expect(out).toContain('\\## Indented');
      expect(out).not.toMatch(/^\s{1,3}## Indented/m);
    }
  });

  it('leaves a # line inside a fenced code block untouched', () => {
    const out = renderSections('task', 'code', {
      ...base,
      framing: '```sh\n# a comment\n```\n~~~\n## in tilde\n~~~',
    });
    expect(out).toContain('```sh\n# a comment\n```');
    expect(out).toContain('~~~\n## in tilde\n~~~');
  });
});

describe('renderSections — shape', () => {
  const base = fixture('task', 'code');

  it('renders no heading for an absent or empty optional section', () => {
    const out = renderSections('task', 'code', { ...base, assumptions: [], deliverables: '  ' });
    expect(out).not.toMatch(/Assumptions|Deliverables/);
  });

  it('puts the difficulty line directly above the boundary heading', () => {
    const out = renderSections('task', 'code', base, {
      difficulty: { level: 'medium', reason: 'three parsers' },
    });
    const lines = out.split('\n');
    const at = lines.indexOf('## Scope BOUNDARY');
    expect(
      lines
        .slice(0, at)
        .filter((l) => l !== '')
        .at(-1),
    ).toBe('**Difficulty: medium** — three parsers');
  });

  it('emits no difficulty line when none is given', () => {
    expect(renderSections('task', 'code', base)).not.toContain('Difficulty');
  });

  it('is byte-identical on two calls, ends in one newline and has no trailing whitespace', () => {
    const a = renderSections('task', 'code', base);
    expect(renderSections('task', 'code', base)).toBe(a);
    expect(a.endsWith('\n')).toBe(true);
    expect(a.endsWith('\n\n')).toBe(false);
    expect(a).not.toMatch(/[ \t]$/m);
  });

  it('renders otherSections under their own headings, last', () => {
    const out = renderSections('task', 'code', {
      ...base,
      otherSections: [{ heading: 'Notes', body: 'x' }],
    });
    expect(out.trimEnd().endsWith('## Notes\n\nx')).toBe(true);
  });

  it('skips a missing required section without validating', () => {
    expect(renderSections('task', 'code', { framing: 'only' })).toBe('only\n');
  });
});
