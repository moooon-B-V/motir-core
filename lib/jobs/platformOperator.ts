// The System tab's gate, in ONE place (MOTIR-8083).
//
// The pre-Epic-6 platform-admin escape hatch (Subtask 1.6.3): the jobs
// dashboard's System tab is visible to the request user only when their email
// equals `PLATFORM_ADMIN_EMAIL`. It was compared inline at two doors (the
// `/settings/workspace/jobs` page and the organization fold-in), which was
// tolerable while it only decided whether a READ tab showed. The operator
// replay of a workspace-less dead letter runs under `withSystemContext`, which
// bypasses tenant RLS, so the service needs the same answer and the three
// callers must not drift. Tracked for replacement with real platform-admin
// roles in Epic 6 (PRODECT_FINDINGS #36).

/**
 * Is this email the platform operator? An unset or empty `PLATFORM_ADMIN_EMAIL`
 * matches nobody — never an empty email.
 */
export function isPlatformOperator(email: string | null | undefined): boolean {
  const adminEmail = process.env['PLATFORM_ADMIN_EMAIL'];
  return Boolean(adminEmail) && Boolean(email) && email === adminEmail;
}
