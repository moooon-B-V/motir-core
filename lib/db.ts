import { Prisma, PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { setTransactionStallPool } from '@/lib/monitoring/transactionStall';

// Dev-mode singleton: Next.js hot-reload would otherwise create a new
// PrismaClient on every reload and leak connections. Stash on globalThis
// so the same instance survives across reloads — the pool with it, so the
// occupancy `dbPool()` reports is the pool the stashed client actually uses.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaPool?: Pool;
};

// ⚠️ THE POOL IS BUILT HERE, NOT BY THE ADAPTER, SO SOMETHING CAN READ IT
// (MOTIR-6701). `new PrismaPg({ connectionString })` builds its `pg.Pool`
// privately, which left a P2028 ("Unable to start a transaction in the given
// time" / "A commit cannot be executed on an expired transaction") with no way
// to say whether the pool was exhausted when it fired. The pool is the SAME one
// the adapter would have built — the same connection string and pg's default
// size — so nothing about how the app connects changes; it is only visible now.
//
// `disposeExternalPool: true` keeps `$disconnect()` ending the pool, as it did
// when the adapter owned it: a script that disconnects and then waits for the
// event loop to drain would otherwise hang on the idle clients.
function createClient(): { client: PrismaClient; pool: Pool } {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and start the ' +
        'dev DB with `./scripts/db-up.sh`.',
    );
  }
  const pool = new Pool({ connectionString: url });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return { client: new PrismaClient({ adapter }), pool };
}

// A client already on `globalThis` is always reused — the dev hot-reload
// singleton, or one a script planted before importing this module
// (`scripts/bench/boundReadTransactionShape.ts` installs a query-logging one).
// Its pool is known only when this module stashed it; a planted client's is not,
// and the report then says the pool was unmeasured rather than guess.
const created: { client: PrismaClient; pool: Pool | null } = globalForPrisma.prisma
  ? { client: globalForPrisma.prisma, pool: globalForPrisma.prismaPool ?? null }
  : createClient();

export const db = created.client;
// Hand the pool to the transaction-timeout reporter (it never imports this file).
setTransactionStallPool(created.pool);

/**
 * The `pg.Pool` behind `db` — READ-ONLY use: its occupancy counters
 * (`totalCount`, `idleCount`, `waitingCount`) and its configured `max`, which
 * `lib/monitoring/transactionStall.ts` attaches to a transaction-timeout report.
 * Never query through it: a query here bypasses the workspace binding every
 * repository read relies on.
 */
export function dbPool(): Pool | null {
  return created.pool;
}

/**
 * `db`, NARROWED to `Prisma.TransactionClient` — the delegate surface a
 * repository read uses, with `$transaction` / `$connect` / `$disconnect` /
 * `$extends` removed.
 *
 * ⚠️ IT EXISTS FOR THE TYPE CHECKER, AND THE COST IT REMOVES IS NOT SMALL
 * (MOTIR-4295). It is the same object as `db`. What differs is that the
 * repository idiom for a read that ACCEPTS an optional transaction —
 *
 *     const client = tx ?? db;          // Prisma.TransactionClient | PrismaClient
 *
 * — hands every subsequent `client.<model>.findMany({ … })` a UNION of two
 * enormous client types. TypeScript then resolves the call against BOTH
 * constituents and relates the two payload instantiations, and the generated
 * client is 105 models deep. Measured on `lib/repositories/githubPullRequestRepository.ts`
 * with `--generateTrace`, ONE method written that way costs **9.6 s** of check
 * time; the same method reading `tx` alone costs 36 ms and reading `db` alone
 * costs 54 ms. Three such methods were 25 s of a 35 s whole-app check.
 *
 * Annotating the local (`const client: Prisma.TransactionClient = tx ?? db`) does
 * NOT fix it — the union still has to be related to the annotation, and it
 * measured 10.6 s. Removing the union at the SOURCE does: `tx ?? dbRead` is
 * `TransactionClient | TransactionClient`, which is one type, and the single
 * PrismaClient → TransactionClient relation is computed once, here.
 *
 * So: a repository whose read takes `tx?: Prisma.TransactionClient` writes
 * `const client = tx ?? dbRead;`. A read that needs no transaction keeps using
 * `db` directly, and anything that opens a transaction MUST use `db` — this
 * value has no `$transaction`, which is the point.
 */
const _dbCarriesDelegates: Pick<Prisma.TransactionClient, 'workItem' | '$queryRaw'> = db;
void _dbCarriesDelegates;

export const dbRead = db as unknown as Prisma.TransactionClient;

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = db;
  if (created.pool) globalForPrisma.prismaPool = created.pool;
}
