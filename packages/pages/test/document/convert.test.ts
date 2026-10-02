import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  PAGE_FRAGMENT,
  applyUpdate,
  deriveFormats,
  emptyState,
  markdownToUpdate,
  pageSchema,
  stateToJson,
  stateToMarkdown,
  stateToText,
} from '../../src';
import { FIXTURE_MARKDOWN, FIXTURE_TEXT } from './fixture';

/** A state whose document reads as `markdown`. */
const stateOf = (markdown: string) =>
  applyUpdate(emptyState(), markdownToUpdate(emptyState(), markdown));

describe('the page body conversions', () => {
  it('starts from an empty page that still validates', () => {
    const state = emptyState();
    expect(stateToJson(state)).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(stateToMarkdown(state)).toBe('');
    expect(stateToText(state)).toBe('');
    // A valid Yjs state: it loads into a document and its fragment reads empty.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    expect(doc.getXmlFragment(PAGE_FRAGMENT).length).toBe(0);
  });

  it('round-trips the fixture: markdown → update on an empty state → markdown', () => {
    const update = markdownToUpdate(emptyState(), FIXTURE_MARKDOWN);
    expect(stateToMarkdown(applyUpdate(emptyState(), update))).toBe(FIXTURE_MARKDOWN);
  });

  it('derives JSON that validates against the schema, and text one line per block', () => {
    const state = stateOf(FIXTURE_MARKDOWN);
    const json = stateToJson(state);
    expect(() => pageSchema.nodeFromJSON(json).check()).not.toThrow();
    expect(stateToText(state)).toBe(FIXTURE_TEXT);
  });

  it('derives all three formats from one read, agreeing with each conversion alone', () => {
    const state = stateOf(FIXTURE_MARKDOWN);
    expect(deriveFormats(state)).toEqual({
      json: stateToJson(state),
      markdown: stateToMarkdown(state),
      text: stateToText(state),
    });
  });

  it('converges two independent edits in either order, keeping both', () => {
    const base = stateOf('Alpha\n\nBeta');
    const a = markdownToUpdate(base, 'Alpha one\n\nBeta');
    const b = markdownToUpdate(base, 'Alpha\n\nBeta two');

    const ab = applyUpdate(applyUpdate(base, a), b);
    const ba = applyUpdate(applyUpdate(base, b), a);
    expect(stateToJson(ab)).toEqual(stateToJson(ba));
    expect(stateToMarkdown(ab)).toBe('Alpha one\n\nBeta two');
  });

  it('makes a state read as the markdown, and merges over an unrelated concurrent edit', () => {
    const base = stateOf('Alpha\n\nBeta');
    const update = markdownToUpdate(base, '# Alpha\n\nBeta changed');
    expect(stateToMarkdown(applyUpdate(base, update))).toBe('# Alpha\n\nBeta changed');

    const concurrent = markdownToUpdate(base, 'Alpha\n\nBeta\n\nGamma');
    const merged = applyUpdate(applyUpdate(base, concurrent), update);
    const markdown = stateToMarkdown(merged);
    expect(markdown).toContain('# Alpha');
    expect(markdown).toContain('Beta changed');
    expect(markdown).toContain('Gamma');
  });

  it('produces an empty update when the markdown already matches', () => {
    const base = stateOf('Same');
    expect(stateToMarkdown(applyUpdate(base, markdownToUpdate(base, 'Same')))).toBe('Same');
  });
});
