import { describe, expect, it } from 'vitest';
import { parseSections } from '@/lib/workItems/sections/parse';
import { sectionFindingFor, sectionFindingsFor } from '@/lib/workItems/sections/validity';
import { runGetSectionSets } from '@/lib/mcp/tools/getSectionSets';
import { sectionsSummary } from '@/lib/mcp/parsedSections';
import { sectionSetsPayload } from '@/lib/mcp/payloads/sectionSets';
import {
  SECTION_SET_COMPONENTS,
  SECTION_SET_OPERATIONS,
} from '@/lib/api/v1/sectionSets/operations';

// Story MOTIR-9023 · MOTIR-9036 — the branches the story's door and read specs reach only
// through a database, pinned here without one.

function text(res: { content: unknown }): string {
  return (res.content as { text: string }[]).map((c) => c.text).join('\n');
}

describe('section branches without a database', () => {
  it('reads a context ref that is not at the head of its bullet', () => {
    const md = [
      '## Context refs',
      '',
      '- Start from `lib/a/b.ts` before anything else',
      '- `lib/c.ts` — the entry point',
    ].join('\n');
    const parsed = parseSections(md, 'task', 'code');
    expect(parsed.sections.contextRefs).toEqual([
      { ref: 'lib/a/b.ts', why: 'Start from `lib/a/b.ts` before anything else' },
      { ref: 'lib/c.ts', why: 'the entry point' },
    ]);
  });

  it('summarises a body with nothing found and nothing missing as "none"', () => {
    const none = sectionsSummary({
      sections: {},
      found: [],
      missing: [],
      invalid: [],
      signals: ['no-headings'],
      headed: [],
    } as never);
    expect(none).toBe('Sections: found none · missing none · no-headings');
  });

  it('finds nothing to say about a card whose kind or type the registry does not know', () => {
    expect(
      sectionFindingFor({ item: 'a', kind: 'nope', type: null, descriptionMd: '' }),
    ).toBeNull();
    expect(
      sectionFindingFor({ item: 'a', kind: 'task', type: 'nope', descriptionMd: '' }),
    ).toBeNull();
  });

  it('calls an empty body unstructured and a headed-but-short one incomplete, sorted by item', () => {
    const [b, a] = [
      sectionFindingFor({ item: 'b', kind: 'task', type: 'code', descriptionMd: '' }),
      sectionFindingFor({
        item: 'a',
        kind: 'task',
        type: 'code',
        descriptionMd: '## Acceptance criteria\n\n- one',
      }),
    ];
    expect(b?.state).toBe('unstructured');
    expect(a?.state).toBe('incomplete');
    const sorted = sectionFindingsFor([
      { item: 'b', kind: 'task', type: 'code', descriptionMd: '' },
      { item: 'a', kind: 'task', type: 'code', descriptionMd: '' },
    ]);
    expect(sorted.map((f) => f.item)).toEqual(['a', 'b']);
  });

  it('carries the section-sets read as one GET operation and one component', () => {
    expect(SECTION_SET_OPERATIONS.map((o) => o.operationId)).toEqual(['getSectionSets']);
    expect(Object.keys(SECTION_SET_COMPONENTS)).toEqual(['SectionSets']);
    expect(sectionSetsPayload.probes.map((p) => p.resource)).toEqual(['SectionSets']);
  });

  it('names an unreadable section in the finding', () => {
    const finding = sectionFindingFor({
      item: 'a',
      kind: 'task',
      type: 'test',
      descriptionMd: '## Cases\n\n- no arrow here',
    });
    expect(finding?.invalid.map((x) => x.section)).toContain('cases');
  });

  it('prints each set line of get_section_sets with its fallbacks', () => {
    const story = text(runGetSectionSets({ kind: 'story' }));
    expect(story).toMatch(/story \/ no type — required: .*; optional: /);
  });
});
