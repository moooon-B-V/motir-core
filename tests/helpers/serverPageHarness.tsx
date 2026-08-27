import type { ReactElement, ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

// THE RSC RENDER HARNESS (Story MOTIR-3440 · Task MOTIR-3568).
//
// ── What this is for ────────────────────────────────────────────────────────
//
// Until this file, no `app/**/page.tsx` had ever been in the coverage report,
// and `vitest.config.ts` said so in three separate places: "this repo has no
// RSC render harness". That sentence was true of the REPO and false of the
// TREE — the technique existed in five places, hand-rolled each time:
//
//   `tests/planning/roadmapPageStreaming.test.tsx`  await the page, walk the tree
//   `tests/planning/planningPageStreaming.test.tsx`            "
//   `tests/planning/plansPageEntrance.test.tsx`                "  (+ its own `walk`)
//   `tests/planning/plansTabbedList.test.tsx`                  "
//   `tests/api-docs/story-gate.test.tsx`            Fizz-render the page to HTML
//   `tests/api-docs/docs-rail-tiers.test.tsx`                  "
//   `tests/api-docs/cli-story-gate.test.tsx`                   "
//
// So this module FACTORS what was already working rather than inventing a
// mechanism. Both halves are kept, because they answer different questions:
//
//   `renderTree`       — call the page, await it, and walk the ELEMENT TREE it
//                        returned. Sees the settled shape. Cheapest, no DOM, no
//                        renderer. This is what the four planning tests do.
//   `renderToHtml`     — drive the same element through `react-dom/server.edge`
//                        so every async child, client component included, runs
//                        and produces markup. This is what the three api-docs
//                        tests do.
//   `renderFirstFlush` — the one thing NEITHER a structural test nor either of
//                        the above can see: what React flushed BEFORE a pending
//                        body resolved. Hold the body's read open with
//                        `deferred()`, read the first chunk off the stream, and
//                        the frame the reader actually gets is in your hand as
//                        a string.
//
// ── The one thing this harness is NOT ───────────────────────────────────────
//
// It is FIZZ, not Flight. `tests/auth/sessionRenderProbe.ts` measured the
// difference and its finding stands: Fizz installs no per-request `cache()`
// scope, so a page whose behaviour depends on React's request memoisation is
// still that probe's job, in a child process under `--conditions=react-server`.
// What Fizz reproduces faithfully is the part this harness is for — the shell,
// the Suspense boundaries, and the order their contents reach the client.

/**
 * Every node in an element tree, depth-first — INCLUDING the ones that ride a
 * prop rather than `children` (`EmptyState`'s `action` is one).
 *
 * Lifted verbatim from `tests/planning/plansPageEntrance.test.tsx`, which is
 * where it was written and where it was about to be copied a fifth time.
 */
export function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (!el.props) return out;
  out.push(el);
  for (const value of Object.values(el.props)) walk(value as ReactNode, out);
  return out;
}

/** Every element in `tree` whose `type` is `type` — a component or a tag name. */
export function findAll<P extends Record<string, unknown> = Record<string, unknown>>(
  tree: ReactNode,
  type: unknown,
): ReactElement<P>[] {
  return walk(tree).filter((el) => el.type === type) as ReactElement<P>[];
}

/** The first element in `tree` whose `type` is `type`, or `undefined`. */
export function findFirst<P extends Record<string, unknown> = Record<string, unknown>>(
  tree: ReactNode,
  type: unknown,
): ReactElement<P> | undefined {
  return findAll<P>(tree, type)[0];
}

/** Every string that appears as a leaf of `tree`, in document order. */
export function textOf(tree: ReactNode): string {
  const parts: string[] = [];
  const visit = (node: ReactNode): void => {
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const el = node as ReactElement<Record<string, unknown>>;
    if (!el.props) return;
    for (const value of Object.values(el.props)) visit(value as ReactNode);
  };
  visit(tree);
  return parts.join(' ');
}

/**
 * `await` a page function and return its element tree.
 *
 * A thin wrapper, and deliberately so: the value is not the `await`, it is that
 * a reader looking for "how do I get at a page in a unit test" finds ONE answer
 * with the walk helpers beside it, rather than four files that each grew their
 * own.
 */
export async function renderTree<A extends unknown[]>(
  page: (...args: A) => Promise<ReactNode>,
  ...args: A
): Promise<ReactNode> {
  return page(...args);
}

/**
 * The CLIENT half of `next/navigation`, for a page whose island calls a router
 * hook while Fizz renders it.
 *
 * The shims are the harness's own scope: a page is a server component, but its
 * body is routinely a client island, and under Fizz that island's function body
 * really does run. `AcceptInviteButton`'s `useRouter()` was the first to prove
 * it — a mock that names only `redirect` fails there with "No useRouter export
 * is defined", and a reader meeting that error concludes the page is unrenderable
 * rather than that the mock is short two lines.
 *
 * Spread it INTO the file's own factory so `redirect` / `notFound` stay spies
 * the test can assert on:
 *
 *     vi.mock('next/navigation', async () => ({
 *       ...(await import('../../helpers/serverPageHarness')).navigationHooks(),
 *       redirect,
 *     }));
 */
export function navigationHooks(): Record<string, unknown> {
  const noop = (): void => {};
  return {
    useRouter: () => ({
      push: noop,
      replace: noop,
      refresh: noop,
      back: noop,
      forward: noop,
      prefetch: noop,
    }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
  };
}

/**
 * The SERVER half of `next-intl` — `getTranslations`, echoing keys.
 *
 * Keys rather than copy, because a page test asserts which BODY rendered and a
 * copy change must not fail it; the real catalogue reaches the CLIENT half
 * through `NextIntlClientProvider` in `withProviders`, which is where an
 * island's own copy comes from.
 *
 * ⚠️ `t.rich` INVOKES ITS CHUNK RENDERERS, and that is not decoration. A page
 * that interpolates through `t.rich('…', { strong: (chunks) => <strong>{chunks}</strong> })`
 * passes a real function, and a shim that ignores it leaves that arrow
 * unexecuted — so the page reports a function-coverage hole that belongs to the
 * MOCK rather than to the page, on exactly the surfaces this harness exists to
 * measure.
 *
 *     vi.mock('next-intl/server', async () => ({
 *       getTranslations: (await import('../../helpers/serverPageHarness')).serverTranslations,
 *     }));
 */
export async function serverTranslations(): Promise<
  ((key: string) => string) & { rich: (key: string, values?: Record<string, unknown>) => string }
> {
  const t = (key: string): string => key;
  t.rich = (key: string, values?: Record<string, unknown>): string => {
    for (const value of Object.values(values ?? {})) {
      if (typeof value === 'function') (value as (chunks: string) => unknown)(key);
    }
    return key;
  };
  return t;
}

/** A promise with its settle functions exposed — the pending body's controller. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Let the page run until `predicate` holds, without settling anything.
 *
 * The instrument for the ONE-WAVE claim: hold the first read of a `Promise.all`
 * open with `deferred()`, wait here until it has been ISSUED, and then assert
 * that its sibling has been issued too. A fixed number of `await Promise.resolve()`
 * turns cannot do this job — the page awaits its session, its params, its
 * translations, its workspace and its gate read before it reaches the wave at
 * all, so the turn count is a property of the page rather than of the claim, and
 * it changes the day someone adds a gate.
 *
 * Throws rather than returning false: a timeout here means the read the caller
 * is waiting for was never issued, which is a failing assertion and not a slow one.
 */
export async function until(
  predicate: () => boolean,
  { timeoutMs = 1000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Wrap `element` in what a real request supplies ABOVE a page: the client
 * providers, and a host element standing in for the authed layout's `<main>`.
 *
 * ⚠️ THE HOST ELEMENT IS LOAD-BEARING, AND IT IS FIDELITY RATHER THAN A
 * WORKAROUND. Measured, on a two-case control:
 *
 *   `<Suspense fallback={<b>F</b>}><Pending/></Suspense>`         → NOTHING is
 *     ever flushed. The reader's first `read()` blocks until the body settles.
 *   `<div><p>H</p><Suspense …><Pending/></Suspense></div>`        → the shell
 *     flushes immediately: `<p>H</p>`, the boundary marker, the fallback.
 *
 * React's Fizz flushes a SHELL, and a tree whose root IS the pending boundary
 * has no shell to flush. No page ever renders that way in the app — every one
 * of them is a child of `app/layout.tsx` → `app/(authed)/layout.tsx` → `<main>`
 * — so rendering a page bare would model a shape production never produces, and
 * `/invite/accept`, whose whole body is one boundary, would look unframeable
 * when it is the one surface in the story that earned a frame of its own.
 *
 * A context provider is not enough on its own: `NextIntlClientProvider` emits no
 * DOM, so it leaves the boundary at the root exactly as before.
 */
function withProviders(element: ReactNode): ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <div data-testid="harness-main">{element}</div>
    </NextIntlClientProvider>
  );
}

/** Errors React reports while rendering — surfaced instead of swallowed. */
function collectErrors(): { onError: (e: unknown) => void; errors: unknown[] } {
  const errors: unknown[] = [];
  return { errors, onError: (e: unknown) => errors.push(e) };
}

/**
 * Render an async server-component tree to its COMPLETE HTML, client children
 * included — the `renderPageToHtml` the three api-docs suites each declare.
 */
export async function renderToHtml(element: ReactNode): Promise<string> {
  const { renderToReadableStream } = await import('react-dom/server.edge');
  const { errors, onError } = collectErrors();
  const stream = await renderToReadableStream(withProviders(element), { onError });
  const html = await new Response(stream).text();
  if (errors.length > 0) throw errors[0];
  return html;
}

export interface FirstFlush {
  /** Everything React flushed before the pending boundary resolved. */
  shell: string;
  /** The complete document, once every boundary has settled. */
  complete: () => Promise<string>;
}

/**
 * Render `element` and hand back what React flushed FIRST — the shell, with
 * every still-pending `<Suspense>` represented by its fallback.
 *
 * This is the assertion no structural test can make. A `tests/navigation/
 * *-arrival.test.ts` suite reads the page's SOURCE and checks that the gate sits
 * above the boundary and the body inside it; it cannot check that the frame
 * therefore reaches the reader first, because it never executes a line. Here the
 * frame is a string.
 *
 * The caller holds the body open with `deferred()` and settles it from
 * `complete()`, so nothing depends on a race:
 *
 *     const body = deferred<Rule[]>();
 *     list.mockReturnValue(body.promise);
 *     const flush = await renderFirstFlush(<Page />);
 *     expect(flush.shell).toContain('settings-pane-frame');   // the frame
 *     body.resolve([]);
 *     expect(await flush.complete()).toContain('automation-settings');
 */
export async function renderFirstFlush(element: ReactNode): Promise<FirstFlush> {
  const { renderToReadableStream } = await import('react-dom/server.edge');
  const { errors, onError } = collectErrors();
  const stream = await renderToReadableStream(withProviders(element), { onError });

  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const chunks: string[] = [];

  const first = await reader.read();
  const shell = first.done ? '' : decoder.decode(first.value, { stream: true });
  chunks.push(shell);

  const complete = async (): Promise<string> => {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    if (errors.length > 0) throw errors[0];
    return chunks.join('');
  };

  return { shell, complete };
}
