// @vitest-environment jsdom
import { generateHTML, generateJSON } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { WorkItemEmbed, pageExtensions, pageSchema } from '../../src';

// The headless `workItemEmbed` node's HTML and text rules (MOTIR-9180): what a
// paste parses and what the schema renders, with no editor mounted.

const doc = (attrs: Record<string, unknown>) => ({
  type: 'doc',
  content: [{ type: 'workItemEmbed', attrs }],
});
const firstBlock = (html: string) => generateJSON(html, pageExtensions()).content[0];

describe('WorkItemEmbed', () => {
  it('renders a div carrying the id, with the key (or the id) as its text', () => {
    expect(generateHTML(doc({ id: 'ck1', label: 'MOTIR-1' }), pageExtensions())).toBe(
      '<div data-type="workItemEmbed" data-work-item-id="ck1">MOTIR-1</div>',
    );
    expect(generateHTML(doc({ id: 'ck1', label: null }), pageExtensions())).toContain('>ck1<');
  });

  it('renders its plain text as the key, then the id, then nothing', () => {
    const textOf = (attrs: Record<string, unknown>) =>
      WorkItemEmbed.config.renderText?.call(
        {} as never,
        { node: pageSchema.nodeFromJSON(doc(attrs)).child(0) } as never,
      );
    expect(textOf({ id: 'ck2', label: 'MOTIR-2' })).toBe('MOTIR-2');
    expect(textOf({ id: 'ck3', label: null })).toBe('ck3');
    expect(textOf({ id: null, label: null })).toBe('');
  });

  it('renders an empty div when it holds neither a key nor an id', () => {
    expect(generateHTML(doc({ id: null, label: null }), pageExtensions())).toContain('></div>');
  });

  it('parses its own div back, taking the text as the label unless it is the id', () => {
    expect(
      firstBlock('<div data-type="workItemEmbed" data-work-item-id="ck1">MOTIR-1</div>'),
    ).toMatchObject({ type: 'workItemEmbed', attrs: { id: 'ck1', label: 'MOTIR-1' } });
    expect(
      firstBlock('<div data-type="workItemEmbed" data-work-item-id="ck1">ck1</div>'),
    ).toMatchObject({ type: 'workItemEmbed', attrs: { id: 'ck1', label: null } });
  });

  it('parses a pasted motir: image as a card, not as an image', () => {
    expect(firstBlock('<img src="motir:ck9" alt="MOTIR-9">')).toMatchObject({
      type: 'workItemEmbed',
      attrs: { id: 'ck9' },
    });
    // A div with no recognisable id is not a card.
    expect(firstBlock('<div data-type="workItemEmbed">x</div>').type).not.toBe('workItemEmbed');
  });
});
