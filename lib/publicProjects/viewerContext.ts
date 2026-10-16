import { cache } from 'react';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
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
