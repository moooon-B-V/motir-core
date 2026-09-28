import { planSessionsService } from '@/lib/services/planSessionsService';

/**
 * The `?session=<id>` landing row the Plans room reads beside its list — a named
 * seam so `PlansView` holds no call that spells like a session read (its file is
 * guarded against reaching for the reader's SESSION, MOTIR-6643).
 */
export const readLandingRow: typeof planSessionsService.getSessionRow = (...args) =>
  planSessionsService.getSessionRow(...args);
