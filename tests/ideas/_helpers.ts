import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PlatformRole } from '@/generated/prisma/client';
import type { IdeaActor, IdeaCredential, IdeaInput } from '@/lib/ideas/types';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';

/**
 * Shared fixtures for the idea-store suites (Story MOTIR-7662).
 */

/** A platform-staff user at `role`, as the actor the ideas gate would hand the service. */
export async function staffActor(
  role: PlatformRole,
  credential: IdeaCredential = { kind: 'session' },
  label = role,
): Promise<IdeaActor> {
  const user = await createTestUser({
    email: `ops+ideas-${label}@moooon.net`,
    name: `Ops ${label}`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role, credential };
}

/** Vocabulary tags, written as the owner (fixtures are not the code under test). */
export async function seedTags(...slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    await adminDb.ideaTag.create({
      data: { slug, label: slug.toUpperCase(), description: `Why ${slug} exists` },
    });
  }
}

/** A valid `direction` input; override any field. */
export function directionInput(slug: string, extra: Partial<IdeaInput> = {}): IdeaInput {
  return {
    slug,
    title: `Direction ${slug}`,
    pitch: `The pitch of ${slug}.`,
    kind: 'direction',
    category: 'ecommerce',
    capabilities: ['Does one thing', 'Does another'],
    evidence: [
      {
        claim: 'A sourced claim.',
        sourceName: 'A source, January 2026',
        url: 'https://example.com/source',
        sourceDate: '2026-01-01',
      },
    ],
    gap: 'Nobody serves it yet.',
    ...extra,
  };
}

/** A valid `motir_buys` input; override any field. */
export function motirBuysInput(slug: string, extra: Partial<IdeaInput> = {}): IdeaInput {
  return {
    slug,
    title: `Motir buys ${slug}`,
    pitch: `Motir would buy ${slug}.`,
    kind: 'motir_buys',
    category: 'legal',
    capabilities: ['Drafts the thing'],
    whyMotir: 'Motir needs it.',
    whoElse: 'Everyone else too.',
    ...extra,
  };
}

/** Every audit row about ideas, oldest first. */
export function ideaAuditRows() {
  return adminDb.platformAuditLog.findMany({
    where: { targetKind: 'idea' },
    orderBy: { seq: 'asc' },
  });
}

const SEED_MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261007100100_seed_ideas/migration.sql',
);

/**
 * Re-apply the idea SEED migration (MOTIR-7674). It is idempotent by contract,
 * so a suite that truncated the store gets today's 15 back, and running it twice
 * proves the contract. The file is ONE statement (a DO block) so one raw execute
 * applies all of it.
 */
export async function applyIdeaSeed(): Promise<void> {
  await adminDb.$executeRawUnsafe(readFileSync(SEED_MIGRATION, 'utf8'));
}
