import type { ImportSourceId } from './_components/importClient';

/** Parse the OAuth round-trip return params the shipped callbacks set, recovering
 *  BOTH the source (so its card re-selects) and the success/failure flag:
 *   - Jira → `?jira=connected|denied|state_error|not_configured|error`.
 *   - Linear → `?import=linear_connected|linear_denied|…`.
 *   - Plane  → `?import=plane_connected|plane_denied|…`.
 *  Success is exactly the `…connected` outcome; every other value is a failure.
 *  Read by both pages the importer runs on: `/onboarding/import` and the migrate
 *  wizard's Import step (MOTIR-8254). */
export function resolveJustConnected(
  sp: Record<string, string | string[] | undefined>,
): { source: ImportSourceId | null; failed: boolean } | undefined {
  const jira = typeof sp['jira'] === 'string' ? sp['jira'] : undefined;
  if (jira) return { source: 'jira', failed: jira !== 'connected' };
  const generic = typeof sp['import'] === 'string' ? sp['import'] : undefined;
  if (generic) {
    const source: ImportSourceId | null = generic.startsWith('linear_')
      ? 'linear'
      : generic.startsWith('plane_')
        ? 'plane'
        : null;
    return { source, failed: !generic.endsWith('connected') };
  }
  return undefined;
}
