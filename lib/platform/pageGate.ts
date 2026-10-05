import 'server-only';

import { notFound } from 'next/navigation';
import { type PlatformRole } from '@/generated/prisma/client';
import { requirePlatformStaff, type PlatformPrincipal } from './auth';
import { NotPlatformStaffError } from './errors';

/**
 * The platform-staff gate for a PAGE or LAYOUT under `app/(admin)` — the same
 * question as `requirePlatformStaff`, answered the way a rendered route must
 * answer it: with the app's ordinary 404 (`docs/decisions/platform-staff-auth.md`
 * §4), never a thrown error.
 *
 * ⚠️ WHY EVERY PAGE NEEDS THIS, AND NOT ONLY THE LAYOUT (MOTIR-7613). Next
 * renders a layout and the page beneath it CONCURRENTLY — the page does not wait
 * for its layout to finish. So when the `(admin)` layout's gate calls
 * `notFound()`, the page's own gate has already run and thrown
 * `NotPlatformStaffError` with nothing to catch it. The response is still the
 * layout's 404, but the page's throw reaches Next's `onRequestError` as an
 * UNHANDLED error, and the error monitor files a production error for every
 * anonymous probe of an admin URL. Answering `notFound()` here too makes both
 * renders agree: a routing sentinel, which the monitor does not report.
 *
 * Route handlers and server actions keep calling `requirePlatformStaff`
 * directly: they translate the error into their own refusal (a `NOT_PERMITTED`
 * result, a 404 JSON body) rather than a rendered not-found page.
 */
export async function requirePlatformStaffPage(
  minimum: PlatformRole = 'support',
): Promise<PlatformPrincipal> {
  try {
    return await requirePlatformStaff(minimum);
  } catch (err) {
    if (err instanceof NotPlatformStaffError) notFound();
    throw err;
  }
}
