// THE VISITOR'S ADDRESS ON EACH REQUEST (Bug MOTIR-6892). A module with no server
// imports, because both halves read it: the Visitor tree's client (which SENDS it,
// `app/(visitor)/p/[identifier]/_components/VisitorAddressFetch.tsx`) and the data doors
// (`lib/visitor/readActor.ts`, which READ it).
//
// A Visitor view's client reads — the board, the peek, the approval overlay by
// key, activity, tree levels, the run modal — used to learn their project from the
// `motir_visitor` cookie. A cookie is one value per BROWSER, and a reader keeps a
// Visitor tab open beside their own member tabs: the member tab's next page clears
// it (`proxy.ts`), and the Visitor tab's next read was answered from the reader's
// OWN project. So the Visitor tab now names its project on every request it makes,
// from the window it lives in — one address per TAB — and the cookie is left as
// the proxy's redirect hint alone.
//
// ⚠️ AN ADDRESS, NEVER A CREDENTIAL — exactly as the cookie was. A door serves a
// Visitor only when the SESSION resolves, through `resolveVisitor`, to a consented
// Visitor of exactly the project this names; any other verdict answers as the
// member path does, and no write door reads it.

/** The request header a Visitor view's same-origin requests carry: the public project's identifier. */
export const VISITOR_ADDRESS_HEADER = 'x-motir-visitor';

/**
 * Whether `value` may be read as a Visitor address: a project key's shape and
 * nothing else, so no forged header can put anything else into the resolver.
 * (The same shape `isVisitorCookieValue` admits.)
 */
export function isVisitorAddressValue(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/** Whether `url` is on `origin` — the address never leaves this app. */
function sameOrigin(url: string | URL, origin: string): boolean {
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * `fetch`, with every SAME-ORIGIN request carrying `identifier` as the Visitor
 * address. A cross-origin request is passed through untouched, and a request that
 * already names an address keeps it. Pure over its arguments, so the wrapper the
 * Visitor tree installs is unit-testable without a window.
 */
export function withVisitorAddress(
  base: typeof fetch,
  identifier: string,
  origin: string,
): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : input;
    if (!sameOrigin(url, origin)) return base(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    if (!headers.has(VISITOR_ADDRESS_HEADER)) headers.set(VISITOR_ADDRESS_HEADER, identifier);
    return base(input, { ...init, headers });
  };
}
