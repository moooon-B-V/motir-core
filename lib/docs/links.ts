import 'server-only';

// WHERE THE RAIL'S `Docs` ROW POINTS (MOTIR-4167).
//
// The documentation index used to be a page this application served, and the
// rail row carried its app-relative path. The public reading surface moved to
// `motir-marketing` (MOTIR-3932) and the page left this repository (MOTIR-3951);
// the row did not move with it, so a signed-in reader who clicked **Docs** got a
// 404 for as long as nothing asserted the row's destination against the route
// tree. The `Legal` row beside it lost its destination to the same split and was
// rebuilt around a nullable resolver (`lib/legal/links.ts`, MOTIR-4010). This
// module is that shape for the documentation door.
//
// `docs/decisions/public-surface-hosts.md` AMENDMENT 2 §D (the MOTIR-4167
// amendment) is the record, with the alternatives it rejected — deriving the url
// from `MOTIR_PUBLIC_SITE_URL` chief among them, because that accessor falls
// back to the APPLICATION origin while unset and would answer the very 404 this
// row is being cured of.
//
// It is `server-only` for the same reason its sibling is: the answer is read
// from the deployment's environment, the rail is a client component, so the
// SERVER caller (`app/(authed)/layout.tsx`) resolves it and passes the result
// down as a prop.

/**
 * The environment value the documentation url is read from — ONE variable
 * holding the ABSOLUTE url of the published documentation, e.g.
 * `https://motir.co/docs` on the hosted deployment. The same contract every
 * legal document's `url` carries: absolute, because it is no longer a page this
 * application serves; operator-supplied, because where the documentation is
 * published is the operator's arrangement.
 */
export const DOCS_URL_ENV = 'MOTIR_DOCS_URL';

/**
 * Where the rail's `Docs` row points, or `null` when it should not render.
 *
 * `null` is the UNCONFIGURED build — a self-hoster who has pointed the row
 * nowhere — and it is not an error case: the row is then absent, not disabled
 * and not dead, exactly as the `Legal` row is on a build with no legal
 * documents configured. A door pointing nowhere is worse than no door.
 *
 * ⚠️ A RELATIVE VALUE IS REFUSED, AND LOUDLY. A relative path is precisely the
 * defect this resolver exists to remove — `/docs` names a route this
 * application does not serve — so an operator who sets one gets no row plus an
 * error-level log naming the variable, never a rendered link that 404s. Only an
 * absolute `http(s)` url is answered, verbatim.
 */
export function docsIndexUrl(): string | null {
  const configured = process.env[DOCS_URL_ENV]?.trim();
  if (!configured) return null;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    console.error(
      `[docs] ${DOCS_URL_ENV} is not an absolute url ("${configured}") — the rail's Docs row is not rendered`,
    );
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.error(
      `[docs] ${DOCS_URL_ENV} must be an http(s) url ("${configured}") — the rail's Docs row is not rendered`,
    );
    return null;
  }
  return configured;
}
