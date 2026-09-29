'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { readerRoutes, type ReaderRoutes } from '@/lib/visitor/routes';

// The reader's addresses for a CLIENT component of a shared page body
// (MOTIR-6888). The Visitor route tree's layout provides the public project's
// identifier; everywhere else — every member page, and every component test —
// the default answers the member routes, so a body rendered on both trees needs
// no prop and no router.
//
// A context rather than `usePathname`: the components that build these hrefs
// are mounted by dozens of tests that mock `next/navigation` without a pathname,
// and a board card or a menu should not take a router dependency to draw a link.

const MEMBER_ROUTES = readerRoutes(null);
const ReaderRoutesContext = createContext<ReaderRoutes>(MEMBER_ROUTES);

/** Wraps the Visitor tree's views so every shared body addresses that project's Visitor paths. */
export function ReaderRoutesProvider({
  identifier,
  children,
}: {
  identifier: string;
  children: ReactNode;
}) {
  const routes = useMemo(() => readerRoutes(identifier), [identifier]);
  return <ReaderRoutesContext.Provider value={routes}>{children}</ReaderRoutesContext.Provider>;
}

/** {@link readerRoutes} for whichever reader the surrounding page serves. */
export function useReaderRoutes(): ReaderRoutes {
  return useContext(ReaderRoutesContext);
}
