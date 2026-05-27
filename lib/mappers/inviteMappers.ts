import type { User, Workspace } from '@prisma/client';
import type { ValidateInviteResultDTO } from '@/lib/dto/invites';

export function toValidateInviteResultDTO(args: {
  workspace: Workspace;
  inviter: User | null;
  email: string;
}): ValidateInviteResultDTO {
  return {
    workspaceName: args.workspace.name,
    // Defensive fallback when the inviter has been deleted between
    // sending the invite and the recipient opening it. We could 404 in
    // that case, but a leftover "A teammate" string is more
    // user-friendly than failing the acceptance UI.
    inviterName: args.inviter?.name ?? 'A teammate',
    email: args.email,
  };
}
