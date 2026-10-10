import type { HomePageDto, HomeWorkItemRowDto } from '@/lib/dto/home';

/**
 * A Workbench page as the flat list of every item on it (Story MOTIR-8012 · MOTIR-8015).
 * To do, In progress and Recently finished return GROUPS — a head carrying the tab's items
 * under it in `groupMembers` — so an assertion about which items a page holds reads the
 * head followed by its members, in the order the service sent. A context head (not on the
 * tab) is included, as the page draws it; filter on `groupHead !== 'context'` for the
 * tab's own items. Every other tab's rows carry no members, so this is the identity there.
 */
export function flattenHomePage(page: Pick<HomePageDto, 'items'>): HomeWorkItemRowDto[] {
  return page.items.flatMap((row) => [row, ...row.groupMembers]);
}

/** The tab's OWN items on a page — every row but a context head. */
export function homePageItems(page: Pick<HomePageDto, 'items'>): HomeWorkItemRowDto[] {
  return flattenHomePage(page).filter((row) => row.groupHead !== 'context');
}
