import { z } from 'zod';
import type { PageMarkdownDto } from '@/lib/dto/pages';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Shared page-tool plumbing (Story MOTIR-5760 · MOTIR-7410). The page tools
// (`get_page`, `create_page`, `update_page`) address a project by its key and a
// page by its opaque id — the `<id>` in a page's address `/pages/<id>`. Kept in
// one place so the tools cannot drift on what a key or an id means, or on how a
// page reads back. Like `folderRef.ts`, this module holds no business logic:
// every refusal is `pagesService`'s own.

/** The zod field every page tool shares for the project. */
export const pageProjectKeyField = z
  .string()
  .min(1)
  .describe('The project key the page belongs to (e.g. "ACME").');

/** A page is addressed by its opaque id — the `<id>` in its address `/pages/<id>`. */
export const pageIdField = z
  .string()
  .min(1)
  .describe('The page id — the `<id>` in the page’s address `/pages/<id>`.');

/** Resolve a project key inside the token's workspace (browse-gated, 404-not-403). */
export async function resolvePageProject(
  projectKey: string,
  ctx: ServiceContext,
): Promise<{ id: string; identifier: string }> {
  const project = await projectsService.getByKey(projectKey.trim().toUpperCase(), ctx);
  return { id: project.id, identifier: project.identifier };
}

/** Where a page is filed, as one phrase. */
function renderPlacement(page: PageMarkdownDto): string {
  if (page.placement.parentPageId !== null) return `under page ${page.placement.parentPageId}`;
  if (page.placement.folderId !== null) return `in folder ${page.placement.folderId}`;
  return 'at the project root';
}

/**
 * The text render every page tool returns: the title, where it is filed, the
 * revision to write against, who saved the newest version, then the markdown.
 */
export function renderPageText(page: PageMarkdownDto): string {
  if (page.version) {
    const v = page.version;
    const marks = [v.sealed ? 'sealed' : null, v.frozen ? 'frozen' : null].filter(Boolean);
    return [
      `# ${page.title || 'Untitled'} (${page.id})`,
      `${renderPlacement(page)} · version ${v.number} by ${v.authorName || v.authorId}, saved ${v.savedAt}` +
        (marks.length ? ` · ${marks.join(', ')}` : '') +
        ` · the page is now at version ${page.latestVersion?.number ?? v.number}, revision ${page.revision}`,
      '',
      page.markdown,
    ].join('\n');
  }
  const version = page.latestVersion
    ? `last saved by ${page.latestVersion.authorName || page.latestVersion.authorId} in version ${page.latestVersion.number}`
    : 'no version history';
  return [
    `# ${page.title || 'Untitled'} (${page.id})`,
    `${renderPlacement(page)} · revision ${page.revision} · ${version}`,
    '',
    page.markdown,
  ].join('\n');
}
