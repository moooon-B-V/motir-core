import { describe, expect, it } from 'vitest';
import type { PageMarkdownDto } from '@/lib/dto/pages';
import { toPageMarkdownDto } from '@/lib/mappers/pageMappers';
import { renderPageText } from '@/lib/mcp/tools/pageRef';

// The page tools' shared text render and the markdown DTO mapper (Story
// MOTIR-5760 · MOTIR-7413's coverage floor). Pure: each branch is a phrase an
// agent reads — where the page is filed, who saved it, whether it has a title —
// so each is pinned here rather than left to whichever integration fixture
// happens to reach it.

function page(overrides: Partial<PageMarkdownDto> = {}): PageMarkdownDto {
  return {
    id: 'pg_1',
    projectId: 'prj_1',
    title: 'Runbook',
    placement: { parentPageId: null, folderId: null },
    revision: 3,
    latestVersion: {
      number: 2,
      authorId: 'usr_1',
      authorName: 'Ada',
      savedAt: '2026-10-03T00:00:00.000Z',
    },
    markdown: '# Runbook',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderPageText', () => {
  it('heads with the title and id, then placement, revision and the newest version', () => {
    expect(renderPageText(page())).toBe(
      [
        '# Runbook (pg_1)',
        'at the project root · revision 3 · last saved by Ada in version 2',
        '',
        '# Runbook',
      ].join('\n'),
    );
  });

  it('names a folder placement and a sub-page placement', () => {
    expect(
      renderPageText(page({ placement: { parentPageId: null, folderId: 'fld_9' } })),
    ).toContain('in folder fld_9');
    expect(renderPageText(page({ placement: { parentPageId: 'pg_0', folderId: null } }))).toContain(
      'under page pg_0',
    );
  });

  it('falls back to Untitled, to the author id, and to no history', () => {
    const text = renderPageText(
      page({
        title: '',
        latestVersion: { number: 1, authorId: 'usr_7', authorName: '', savedAt: 'x' },
      }),
    );
    expect(text).toContain('# Untitled (pg_1)');
    expect(text).toContain('last saved by usr_7 in version 1');
    expect(renderPageText(page({ latestVersion: null }))).toContain('no version history');
  });
});

describe('toPageMarkdownDto', () => {
  const record = {
    id: 'pg_1',
    projectId: 'prj_1',
    title: 'Runbook',
    parentPageId: null,
    folderId: 'fld_1',
    revision: 4,
    bodyMarkdown: 'Body',
    updatedAt: new Date('2026-10-03T00:00:00.000Z'),
  };
  const latest = {
    number: 2,
    authorId: 'usr_1',
    savedAt: new Date('2026-10-02T00:00:00.000Z'),
  };

  it('carries the placement, revision, markdown and newest version', () => {
    expect(toPageMarkdownDto(record as never, latest as never, 'Ada')).toEqual({
      id: 'pg_1',
      projectId: 'prj_1',
      title: 'Runbook',
      placement: { parentPageId: null, folderId: 'fld_1' },
      revision: 4,
      latestVersion: {
        number: 2,
        authorId: 'usr_1',
        authorName: 'Ada',
        savedAt: '2026-10-02T00:00:00.000Z',
      },
      markdown: 'Body',
      updatedAt: '2026-10-03T00:00:00.000Z',
    });
  });

  it('reads an unknown author as an empty name, and no version as null', () => {
    expect(
      toPageMarkdownDto(record as never, latest as never, undefined).latestVersion,
    ).toMatchObject({ authorName: '' });
    expect(toPageMarkdownDto(record as never, null, undefined).latestVersion).toBeNull();
  });
});
