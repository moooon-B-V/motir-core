import { getSession } from '@/lib/auth';
import { getPublicOverview, getActiveOrgName } from '@/lib/publicProjects/viewerContext';
import { PublicSubmitRequestButton } from './PublicSubmitRequestButton';

// Server resolver for the public "Submit a request" control (Story 6.12 ·
// Subtask 6.12.11). It resolves — from the project `identifier` alone — the
// three things the client form needs: the project's GLOBAL id (the public write
// endpoints' address), whether the viewer is signed in, and the viewer's
// name + active-org for the "Submitted as …" attribution hint. Keeping the
// resolution here means the nav / hero / sidebar call sites just pass
// `identifier` (no prop-threading through four pages), and the cached reads
// (`getPublicOverview`) dedupe across all instances on a page.
//
// READ stays anonymous; only the WRITE needs an account, so a logged-out viewer
// gets the sign-in-to-act prompt (the unauthenticated public portal form is
// dropped — Yue, 2026-06-14; the public submit form is signed-in only).
export async function PublicSubmitRequest({
  identifier,
  size = 'sm',
}: {
  identifier: string;
  size?: 'sm' | 'md';
}) {
  const session = await getSession();
  const overview = await getPublicOverview(identifier, session?.user.id ?? null);
  const submitterOrg = session ? await getActiveOrgName(session.user.id) : null;

  return (
    <PublicSubmitRequestButton
      projectId={overview.id}
      roadmapHref={`/p/${encodeURIComponent(overview.identifier)}/roadmap`}
      size={size}
      signedIn={session !== null}
      submitterName={session?.user.name ?? null}
      submitterOrg={submitterOrg}
    />
  );
}
