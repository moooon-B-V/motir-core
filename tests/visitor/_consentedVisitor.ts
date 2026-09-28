import { projectAccessService } from '@/lib/services/projectAccessService';
import { visitorRecordsService } from '@/lib/services/visitorRecordsService';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { adminDb } from '../helpers/adminDb';

// A signed-in, CONSENTED Visitor of a public project (MOTIR-6666): a stranger with
// no membership anywhere in the project's workspace, who has pressed Continue on
// its consent screen. The Visitor reads' tests build their reader through this, so
// every one of them reads exactly as a real Visitor now does.

let seq = 0;

export async function consentedVisitor(identifier: string): Promise<VisitorReadContext> {
  const stranger = await adminDb.user.create({
    data: {
      email: `stranger-${Date.now()}-${seq++}@example.com`,
      name: 'Stranger',
      emailVerified: true,
    },
  });
  await visitorRecordsService.recordConsent({ identifier, userId: stranger.id });
  const verdict = await projectAccessService.resolveVisitor(identifier, {
    user: { id: stranger.id },
  });
  if (verdict.kind !== 'visitor') throw new Error(`expected a visitor, got ${verdict.kind}`);
  return verdict.ctx;
}
