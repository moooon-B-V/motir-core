// WHERE a repository's row is in the Repositories room, by its `owner/name`
// (Story MOTIR-683 · MOTIR-691; `design/repository-set/design-notes.md` §18.3).
//
// A refused Run hosted names each repository Motir's app cannot write and links
// to THAT row — never straight to GitHub, because the room names who has to act.
// The refusal knows the repository only by `owner/name`, so the row carries an
// anchor keyed on it, and both sides spell it here, once.

/** The DOM id of a repository's anchor in the Repositories room. */
export function repositoryRowAnchorId(fullName: string): string {
  return `repository-${fullName.toLowerCase()}`;
}

/** The Repositories room, scrolled to one repository's row. */
export function repositoryRowHref(fullName: string): string {
  return `/settings/project/repositories#${encodeURIComponent(repositoryRowAnchorId(fullName))}`;
}
