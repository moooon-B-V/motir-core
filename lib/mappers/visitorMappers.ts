import type { ProjectVisitorDTO } from '@/lib/dto/visitors';
import type { ProjectVisitorListRow } from '@/lib/repositories/projectVisitorRepository';

// A visitor record → the Managers' list row (Story MOTIR-6170 · MOTIR-6667). The
// five fields the consent screen said would be shared, and nothing else: the
// record's id and the person's user id stay on the server.

export function toProjectVisitorDTO(row: ProjectVisitorListRow): ProjectVisitorDTO {
  return {
    name: row.name?.trim() ?? '',
    email: row.email,
    firstVisitAt: row.firstVisitAt.toISOString(),
    lastVisitAt: row.lastVisitAt.toISOString(),
    consentedAt: row.consentedAt.toISOString(),
  };
}
