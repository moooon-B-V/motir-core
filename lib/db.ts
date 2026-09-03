import { Prisma, PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Dev-mode singleton: Next.js hot-reload would otherwise create a new
// PrismaClient on every reload and leak connections. Stash on globalThis
// so the same instance survives across reloads.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and start the ' +
        'dev DB with `./scripts/db-up.sh`.',
    );
  }
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createClient();

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
}
