import type { Prisma } from '@/generated/prisma/client';
import type { Clock, PageStore } from '@motir/pages';
import { createPageStore } from './pageStoreAdapter';

// ⚠️ THIS FILE IS `@motir/pages`' COMPOSITION ROOT (Story MOTIR-5752 ·
// MOTIR-7276), `docs/decisions/pages.md` §2 — modelled on
// `lib/orchestrator/index.ts`. It BINDS the package's ports to this app (the
// `PageStore` over Prisma, per transaction; the system clock) and RE-EXPORTS
// the package's surface, so nothing above it names which half of the boundary a
// symbol came from. `tests/packages/importDirection.test.ts` holds that
// `@motir/pages` is imported only here and under `components/pages/`.
//
// ⚠️ `lib/pages/projectPageContext.ts` shares this directory by NAME ONLY — it
// is a Next.js page-context helper with its own importers, and this file does
// not re-export it.

export * from '@motir/pages';

/** The `PageStore` for one open transaction. The page service opens it. */
export function pageStoreFor(tx: Prisma.TransactionClient): PageStore {
  return createPageStore(tx);
}

/** The wall clock. */
export const systemClock: Clock = { now: () => new Date() };
