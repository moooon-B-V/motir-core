import { cache } from 'react';
import { cookies } from 'next/headers';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { organizationsService } from '@/lib/services/organizationsService';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import type { PublicProjectOverviewDto } from '@/lib/dto/publicProjects';

// Request-scoped public-projects read helpers (Story 6.12 · Subtask 6.12.11).
//
// `getPublicOverview` is `cache()`-wrapped so the public Overview read dedupes
// across a single request: the shell layout, the page, AND every
// `PublicSubmitRequest` button instance (the nav + the hero + the sidebar all
// render one) resolve the SAME project through one DB read instead of N. The
// submit form needs the project's GLOBAL id (the public write-URL segment),
// which now rides the overview DTO.
export const getPublicOverview = cache(
  (identifier: string, actorUserId: string | null): Promise<PublicProjectOverviewDto> =>
    publicProjectsService.getOverview(identifier, actorUserId),
);

// The signed-in viewer's active organization NAME — for the submit form's
// "Submitted as {name} ({org})" attribution hint (design Panel 4). Resolved from
// the active-org cookie (re-validated against membership, falling back to the
// user's first org), exactly as the shell does; `cache()`-wrapped so the three
// button instances share one resolution. Returns null when the viewer has no
// org (the hint then degrades to name-only).
export const getActiveOrgName = cache(async (userId: string): Promise<string | null> => {
  const store = await cookies();
  const pinned = store.get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const active = await organizationsService.resolveActiveOrganization(userId, pinned);
  return active?.organization.name ?? null;
});
