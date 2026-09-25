// The org Workspaces card's page size (MOTIR-6312 · design panel 1): a sibling
// constant of the roster's `ORG_ROSTER_PAGE_SIZE`, and the same number, because
// the card's pager is the roster's pager verbatim. Shared by the server page's
// first read and the client island's later ones, so the two never disagree about
// where page 2 starts.
export const ORG_WORKSPACES_PAGE_SIZE = 10;
