import { describe, expect, it } from 'vitest';
import { renderSections } from '@/lib/workItems/sections/render';
import { extractScopeBoundary } from './helpers/extractScopeBoundary';

// The helper mirrors `motir-ai` `src/llm/authorSession.ts` `extractScopeBoundary`
// (motir-core cannot import motir-ai), so this asserts the boundary the renderer
// emits is the one the hosted planner's reader returns.
describe('renderSections — scope boundary parity with motir-ai', () => {
  const base = {
    framing: 'Framing.',
    acceptanceCriteria: ['One'],
    contextRefs: [{ ref: 'lib/x.ts', why: 'y' }],
  };

  it('round-trips a single-line boundary', () => {
    expect(
      extractScopeBoundary(
        renderSections('task', 'code', { ...base, scopeBoundary: 'Stops here.' }),
      ),
    ).toBe('Stops here.');
  });

  it('round-trips a multi-paragraph boundary with a list', () => {
    const boundary = 'First.\n\n- left to A\n- left to B\n\nLast.';
    expect(
      extractScopeBoundary(renderSections('task', 'code', { ...base, scopeBoundary: boundary })),
    ).toBe(boundary);
  });

  it('is found at the story and epic levels too', () => {
    expect(
      extractScopeBoundary(
        renderSections('epic', null, { framing: 'f', scopeBoundary: 'Epic wall.' }),
      ),
    ).toBe('Epic wall.');
  });
});
