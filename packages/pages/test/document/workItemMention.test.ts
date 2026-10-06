// @vitest-environment jsdom
import { generateHTML, generateJSON, getText } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { WorkItemMention, pageExtensions, pageSchema } from '../../src';

// The headless `workItemMention` node's HTML and text rules (MOTIR-7570): what
// a paste parses and what the schema renders, with no editor mounted.

const doc = (attrs: Record<string, unknown>) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'workItemMention', attrs }] }],
});
const mentionIn = (html: string) =>
  JSON.stringify(generateJSON(html, pageExtensions())).includes('workItemMention')
    ? generateJSON(html, pageExtensions()).content[0].content[0]
    : null;

describe('WorkItemMention', () => {
  it('renders a span carrying the id, with the key as its text', () => {
    expect(generateHTML(doc({ id: 'ck1', label: 'MOTIR-1' }), pageExtensions())).toBe(
      '<p><span data-type="workItemMention" data-work-item-id="ck1">MOTIR-1</span></p>',
    );
    // With no label the id stands in, in HTML and in text.
    expect(generateHTML(doc({ id: 'ck1', label: null }), pageExtensions())).toContain('>ck1<');
    const node = pageSchema.nodeFromJSON(doc({ id: 'ck2', label: 'MOTIR-2' }));
    expect(getText(node, { textSerializers: { workItemMention: () => 'x' } })).toBe('x');
    expect(
      WorkItemMention.config.renderText?.call(
        {} as never,
        { node: node.child(0).child(0) } as never,
      ),
    ).toBe('MOTIR-2');
    expect(
      WorkItemMention.config.renderText?.call(
        {} as never,
        {
          node: pageSchema
            .nodeFromJSON(doc({ id: 'ck3', label: null }))
            .child(0)
            .child(0),
        } as never,
      ),
    ).toBe('ck3');
    expect(
      WorkItemMention.config.renderText?.call(
        {} as never,
        {
          node: pageSchema
            .nodeFromJSON(doc({ id: null, label: null }))
            .child(0)
            .child(0),
        } as never,
      ),
    ).toBe('');
  });

  it('parses its own span and a pasted motir: anchor, outranking the Link mark', () => {
    expect(
      mentionIn('<p><span data-type="workItemMention" data-work-item-id="ck1">MOTIR-1</span></p>'),
    ).toEqual({ type: 'workItemMention', attrs: { id: 'ck1', label: 'MOTIR-1' } });
    expect(mentionIn('<p><a href="motir:ck9"> MOTIR-9 </a></p>')).toEqual({
      type: 'workItemMention',
      attrs: { id: 'ck9', label: 'MOTIR-9' },
    });
    expect(mentionIn('<p><a href="motir:ck9"></a></p>')).toEqual({
      type: 'workItemMention',
      attrs: { id: 'ck9', label: null },
    });
    expect(mentionIn('<p><span data-work-item-id="ck8"></span></p>')).toEqual({
      type: 'workItemMention',
      attrs: { id: 'ck8', label: null },
    });
    // A label-less chip renders its id as its text; pasting it back keeps it
    // label-less rather than storing the id as a label (MOTIR-7574).
    expect(
      mentionIn('<p><span data-type="workItemMention" data-work-item-id="ck7">ck7</span></p>'),
    ).toEqual({ type: 'workItemMention', attrs: { id: 'ck7', label: null } });
  });

  it('refuses a malformed id: neither rule makes a mention of it', () => {
    expect(mentionIn('<p><a href="motir:bad id">x</a></p>')).toBeNull();
    expect(mentionIn('<p><span data-work-item-id="bad id">x</span></p>')).toBeNull();
    expect(mentionIn('<p><span data-work-item-id>x</span></p>')).toBeNull();
    expect(mentionIn('<p><a href="motir:">x</a></p>')).toBeNull();
  });
});
