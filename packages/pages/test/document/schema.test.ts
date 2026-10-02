import { describe, expect, it } from 'vitest';
import { PAGE_FRAGMENT, pageExtensions, pageSchema } from '../../src';

describe('pageSchema', () => {
  it('holds a node for every extension the page document lists', () => {
    expect(Object.keys(pageSchema.nodes).sort()).toEqual([
      'blockquote',
      'bulletList',
      'codeBlock',
      'doc',
      'hardBreak',
      'heading',
      'horizontalRule',
      'image',
      'listItem',
      'orderedList',
      'paragraph',
      'table',
      'tableCell',
      'tableHeader',
      'tableRow',
      'taskItem',
      'taskList',
      'text',
    ]);
  });

  it('holds exactly the marks markdown can write — no underline', () => {
    expect(Object.keys(pageSchema.marks).sort()).toEqual([
      'bold',
      'code',
      'italic',
      'link',
      'strike',
    ]);
  });

  it('carries a code block language, image src and alt, a task’s checked flag', () => {
    expect(Object.keys(pageSchema.nodes.codeBlock!.spec.attrs ?? {})).toContain('language');
    expect(Object.keys(pageSchema.nodes.image!.spec.attrs ?? {})).toEqual(
      expect.arrayContaining(['src', 'alt']),
    );
    expect(Object.keys(pageSchema.nodes.taskItem!.spec.attrs ?? {})).toContain('checked');
    expect(pageSchema.nodes.heading!.spec.attrs?.level?.default).toBe(1);
  });

  it('binds the fragment Tiptap’s collaboration extension uses', () => {
    expect(PAGE_FRAGMENT).toBe('default');
  });

  it('builds a fresh extension list on every call', () => {
    expect(pageExtensions()).not.toBe(pageExtensions());
    expect(pageExtensions().map((extension) => extension.name)).toEqual([
      'starterKit',
      'image',
      'link',
      'taskList',
      'taskItem',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
    ]);
  });
});
