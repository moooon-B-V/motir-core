import type { MemberRole, ProjectAccessLevel } from '@/generated/prisma/client';
import { describe, expect, it } from 'vitest';
import {
  canBrowse,
  canComment,
  canCommentPublicRequest,
  canCreateAttachments,
  canDeleteAllAttachments,
  canEdit,
  canManageProject,
  canManageWatchers,
  canModerateComments,
  canSubmitToTriage,
  canUpvotePublicRequest,
  type ProjectAccessInputs,
} from '@/lib/projects/access';
import { hasPermission, resolvePermissions } from '@/lib/permissions/resolve';
import {
  BUILTIN_ROLE_PERMISSIONS,
  IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import type { PermissionKey } from '@/lib/permissions/catalog';

// The PARITY TRUTH TABLE (Story MOTIR-2255 · Subtask MOTIR-2261). MOTIR-2261
// moved the decision that guards every read and every write in the product onto
// a new mechanism — the permission catalog and `resolvePermissions`. Nothing an
// actor can do is supposed to change, and that is not something a reviewer can
// establish by reading a diff of decision tables.
//
// So: all 64 combinations of accessLevel (4) × workspaceRole (4) × projectRole
// (4), through all eleven predicates.
//
// ⚠️ THE EXPECTATIONS BELOW ARE LITERAL BOOLEANS TRANSCRIBED FROM THE PRE-CHANGE
// POLICY — produced by running `origin/main`'s `lib/projects/access.ts` decision
// tables over the same 64 inputs and writing the answers down. They are NOT
// computed from the new code. A computed table would only prove the new code
// agrees with itself, which is exactly the thing that needed proving.
//
// If a future card intends a behaviour CHANGE, the row it changes must be edited
// here by hand, deliberately — that friction is the point.

type Row = {
  accessLevel: ProjectAccessLevel;
  workspaceRole: MemberRole | null;
  projectRole: MemberRole | null;
  expected: Record<string, boolean>;
};

const PREDICATES: Record<string, (i: ProjectAccessInputs) => boolean> = {
  canBrowse,
  canEdit,
  canComment,
  canModerateComments,
  canCreateAttachments,
  canDeleteAllAttachments,
  canManageWatchers,
  canManageProject,
  canSubmitToTriage,
  canUpvotePublicRequest,
  canCommentPublicRequest,
};

/**
 * The twelve per-domain administrative keys MOTIR-2256 splits out of
 * `project:administer`. Spelled out LITERALLY rather than derived from
 * `ROLE_GATED_PERMISSIONS` — deriving it would let a key silently join or leave
 * the split and still pass, which is precisely the drift the parity table below
 * exists to catch.
 */
const ADMINISTRATIVE_KEYS: readonly PermissionKey[] = [
  'member:manage',
  'project:manage_access',
  'board:configure',
  'workflow:manage',
  'automation:manage',
  'field:manage',
  'component:manage',
  'label:manage',
  'estimation:manage',
  'repository:manage',
  'repository:manage_access',
  'ai:configure',
];

const TABLE: Row[] = [
  {
    accessLevel: 'public',
    workspaceRole: 'owner',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'owner',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'owner',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'owner',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'admin',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'admin',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'admin',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'admin',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'member',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'member',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: false,
      canCreateAttachments: true,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'member',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'member',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: false,
      canCreateAttachments: true,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: null,
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: null,
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: null,
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: null,
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'owner',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'owner',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'owner',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'owner',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'admin',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'admin',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'admin',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'admin',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'member',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'member',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: false,
      canCreateAttachments: true,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'member',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'member',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: false,
      canCreateAttachments: true,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: null,
    projectRole: 'admin',
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: null,
    projectRole: 'member',
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: null,
    projectRole: 'viewer',
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: null,
    projectRole: null,
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'owner',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'owner',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'owner',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'owner',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'admin',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'admin',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'admin',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'admin',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'member',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'member',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: false,
      canCreateAttachments: true,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'member',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'member',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: false,
      canComment: true,
      canModerateComments: false,
      canCreateAttachments: true,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: null,
    projectRole: 'admin',
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: null,
    projectRole: 'member',
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: null,
    projectRole: 'viewer',
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: null,
    projectRole: null,
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'owner',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'owner',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'owner',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'owner',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'admin',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'admin',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'admin',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'admin',
    projectRole: null,
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'member',
    projectRole: 'admin',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: true,
      canCreateAttachments: true,
      canDeleteAllAttachments: true,
      canManageWatchers: true,
      canManageProject: true,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'member',
    projectRole: 'member',
    expected: {
      canBrowse: true,
      canEdit: true,
      canComment: true,
      canModerateComments: false,
      canCreateAttachments: true,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'member',
    projectRole: 'viewer',
    expected: {
      canBrowse: true,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'member',
    projectRole: null,
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: null,
    projectRole: 'admin',
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: null,
    projectRole: 'member',
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: null,
    projectRole: 'viewer',
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: null,
    projectRole: null,
    expected: {
      canBrowse: false,
      canEdit: false,
      canComment: false,
      canModerateComments: false,
      canCreateAttachments: false,
      canDeleteAllAttachments: false,
      canManageWatchers: false,
      canManageProject: false,
      canSubmitToTriage: false,
      canUpvotePublicRequest: false,
      canCommentPublicRequest: false,
    },
  },
];

describe('the permission model is behaviour-neutral over the shipped policy', () => {
  it('covers every combination exactly once (4 levels × 4 workspace roles × 4 project roles)', () => {
    expect(TABLE).toHaveLength(64);
    const seen = new Set(TABLE.map((r) => `${r.accessLevel}|${r.workspaceRole}|${r.projectRole}`));
    expect(seen.size).toBe(64);
  });

  it('asserts all eleven predicates on every row', () => {
    for (const row of TABLE) {
      expect(Object.keys(row.expected).sort()).toEqual(Object.keys(PREDICATES).sort());
    }
    expect(Object.keys(PREDICATES)).toHaveLength(11);
  });

  it.each(TABLE)(
    'accessLevel=$accessLevel workspaceRole=$workspaceRole projectRole=$projectRole',
    ({ accessLevel, workspaceRole, projectRole, expected }) => {
      const inputs: ProjectAccessInputs = { accessLevel, workspaceRole, projectRole };
      for (const [name, predicate] of Object.entries(PREDICATES)) {
        expect(
          predicate(inputs),
          `${name}({ ${accessLevel}, ws=${workspaceRole}, proj=${projectRole} })`,
        ).toBe(expected[name]);
      }
    },
  );
});

describe('the anonymous public actor holds exactly the Story 6.12 grant', () => {
  const anonymous: ProjectAccessInputs = {
    accessLevel: 'public',
    workspaceRole: null,
    projectRole: null,
  };

  it('resolves to project:browse plus the three public-request keys, and nothing else', () => {
    expect([...resolvePermissions(anonymous)].sort()).toEqual(
      [
        'project:browse',
        'public_request:comment',
        'public_request:submit',
        'public_request:upvote',
      ].sort(),
    );
  });

  it('holds no normal write — edit, comment, moderation and administration are all denied', () => {
    expect(canEdit(anonymous)).toBe(false);
    expect(canComment(anonymous)).toBe(false);
    expect(canCreateAttachments(anonymous)).toBe(false);
    expect(canModerateComments(anonymous)).toBe(false);
    expect(canDeleteAllAttachments(anonymous)).toBe(false);
    expect(canManageWatchers(anonymous)).toBe(false);
    expect(canManageProject(anonymous)).toBe(false);
  });

  it('holds nothing at all on a non-public project', () => {
    for (const accessLevel of ['open', 'limited', 'private'] as const) {
      expect([...resolvePermissions({ ...anonymous, accessLevel })]).toEqual([]);
    }
  });
});

describe('the two rails resolve INSIDE the set, not around it', () => {
  it('a workspace manager holds the whole ROLE-GATED catalog on every level', () => {
    for (const accessLevel of ['public', 'open', 'limited', 'private'] as const) {
      for (const workspaceRole of ['owner', 'admin'] as const) {
        const held = resolvePermissions({ accessLevel, workspaceRole, projectRole: null });
        // ROLE_GATED_PERMISSIONS, not every catalog key: the catalog also holds
        // the level-gated public-request grants (never role-held) and the
        // `planned` keys MOTIR-2256 has yet to wire to a gate.
        for (const key of ROLE_GATED_PERMISSIONS) {
          expect(held.has(key), `${workspaceRole} on ${accessLevel} lacks ${key}`).toBe(true);
        }
      }
    }
  });

  it('does NOT widen the level-gated public-request grants for a workspace manager', () => {
    // The shipped canSubmitToTriage is `accessLevel === 'public'` for EVERYONE.
    // A naive "manager gets the full catalog" rail would silently grant these on
    // a private project — this is the row that catches it.
    const owner = resolvePermissions({
      accessLevel: 'private',
      workspaceRole: 'owner',
      projectRole: 'admin',
    });
    expect(owner.has('public_request:submit')).toBe(false);
    expect(owner.has('public_request:upvote')).toBe(false);
    expect(owner.has('public_request:comment')).toBe(false);
  });

  it('a project viewer is read-only on every access level', () => {
    for (const accessLevel of ['public', 'open', 'limited', 'private'] as const) {
      const held = resolvePermissions({
        accessLevel,
        workspaceRole: 'member',
        projectRole: 'viewer',
      });
      expect(held.has('project:browse')).toBe(true);
      expect(held.has('work_item:edit')).toBe(false);
      expect(held.has('comment:add')).toBe(false);
      expect(held.has('attachment:create')).toBe(false);
      expect(held.has('project:administer')).toBe(false);
    }
  });

  it('the twelve administrative keys are held by exactly the actors project:administer is', () => {
    // The NEUTRALITY PROOF for MOTIR-2256. The story splits one umbrella
    // permission into twelve per-domain ones and claims nobody's access changes.
    // That claim is only true if each of the twelve resolves identically to
    // `project:administer` for EVERY actor the system can describe — not for the
    // handful anybody would think to try. This walks all 64 rows and both rails.
    //
    // A divergence here means one of two things, and both are real findings:
    // the key was added to the wrong role set, or `levelGrants` grew a branch
    // naming it (see the ⚠️ on `levelGrants` — it must not).
    for (const row of TABLE) {
      const inputs: ProjectAccessInputs = {
        accessLevel: row.accessLevel,
        workspaceRole: row.workspaceRole,
        projectRole: row.projectRole,
      };
      const umbrella = hasPermission(inputs, 'project:administer');
      for (const key of ADMINISTRATIVE_KEYS) {
        expect(
          hasPermission(inputs, key),
          `${key} diverges from project:administer on { ${row.accessLevel}, ws=${row.workspaceRole}, proj=${row.projectRole} } (expected ${umbrella})`,
        ).toBe(umbrella);
      }
    }
  });

  it('the twelve are held by admin and by NO other built-in role', () => {
    // The other half of neutrality: the split must not GRANT anything. A member
    // or viewer picking up an administrative key would satisfy the parity test
    // above only if `project:administer` moved too — but stating it directly is
    // what makes a mistaken paste into the wrong set fail loudly.
    for (const key of ADMINISTRATIVE_KEYS) {
      expect(BUILTIN_ROLE_PERMISSIONS.admin.has(key), `admin lacks ${key}`).toBe(true);
      expect(BUILTIN_ROLE_PERMISSIONS.member.has(key), `member holds ${key}`).toBe(false);
      expect(BUILTIN_ROLE_PERMISSIONS.viewer.has(key), `viewer holds ${key}`).toBe(false);
      expect(
        IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS.has(key),
        `the implicit workspace-member grant holds ${key}`,
      ).toBe(false);
    }
  });

  it('the access level SUBTRACTS: a workspace member without a project membership', () => {
    const base = { workspaceRole: 'member' as const, projectRole: null };
    // open — the role's base set survives intact
    const open = resolvePermissions({ ...base, accessLevel: 'open' });
    expect(open.has('work_item:edit')).toBe(true);
    expect(open.has('comment:add')).toBe(true);
    // limited — view + comment, but EDIT is taken away
    const limited = resolvePermissions({ ...base, accessLevel: 'limited' });
    expect(limited.has('project:browse')).toBe(true);
    expect(limited.has('comment:add')).toBe(true);
    expect(limited.has('work_item:edit')).toBe(false);
    // private — invisible without a project membership
    expect([...resolvePermissions({ ...base, accessLevel: 'private' })]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE MEMBER-FACING TABLE (Story MOTIR-2291 · Subtask MOTIR-2349).
//
// The eleven-predicate table above proves NEUTRALITY: MOTIR-2255 moved the
// decision onto a new mechanism and nothing an actor could do changed, so not one
// of its 64 rows moves here either — this card touches no shipped predicate, and
// that unchanged table is the assertion.
//
// This second table proves the opposite kind of thing, and it is this card's
// deliverable rather than a chore. MOTIR-2291's eight keys are in NO role set on
// `origin/main`, so today every cell below would be `false` for every actor: a
// key nobody holds resolves to nobody. Each `true` here is therefore a grant
// arriving — and, read the other way round, each `false` on a row whose actor can
// reach the operation TODAY is the capability that actor loses when that key's
// wiring card lands. The rows worth reading twice:
//
//   * `projectRole: 'viewer'` — holds `report:view` and NOTHING else of the
//     eight. A viewer who today starts a sprint, re-ranks the backlog, runs the
//     planner or accepts a triage submission stops being able to.
//   * `projectRole: null` with a workspace role — the implicit workspace member.
//     Same single key. This is the actor §2 of the decision is about: they may
//     read the charts of a project nobody put them on, and nothing else.
//   * `projectRole: 'member'` — holds six, and NOT `import:run` /
//     `work_item:delete`. A project member loses running an import and deleting a
//     subtree; both mirrors put those at admin.
//   * `workspaceRole: 'owner' | 'admin'` — all eight on every access level, via
//     the always-pass rail. Nothing decided here can lock a workspace owner out.
//   * `accessLevel: 'private'` with `projectRole: null` — nothing at all, because
//     the level denies a non-member before any key is consulted.
//
// ⚠️ TRANSCRIBED FROM `docs/decisions/member-facing-permissions.md`, NOT computed
// from `resolvePermissions`. The role assignment is §1's table, the implicit
// workspace-member row is §2, and the per-level behaviour is §3's decision to add
// no `levelGrants` branch — so each of the eight behaves per level exactly as
// `project:administer` does. Deriving these cells from the code under test would
// only prove the code agrees with itself.
const MEMBER_FACING_KEYS: readonly PermissionKey[] = [
  'sprint:manage',
  'report:view',
  'saved_filter:manage',
  'import:run',
  'work_item:delete',
  'work_item:triage',
  'ai:plan',
  'ai:view_plan',
];

type MemberFacingRow = {
  accessLevel: ProjectAccessLevel;
  workspaceRole: MemberRole | null;
  projectRole: MemberRole | null;
  held: Record<string, boolean>;
};

const MEMBER_FACING_TABLE: MemberFacingRow[] = [
  {
    accessLevel: 'public',
    workspaceRole: 'owner',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'owner',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'owner',
    projectRole: 'viewer',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'owner',
    projectRole: null,
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'admin',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'admin',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'admin',
    projectRole: 'viewer',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'admin',
    projectRole: null,
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'member',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'member',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'member',
    projectRole: 'viewer',
    held: {
      'sprint:manage': false,
      'report:view': true,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: 'member',
    projectRole: null,
    held: {
      'sprint:manage': false,
      'report:view': true,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: null,
    projectRole: 'admin',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: null,
    projectRole: 'member',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: null,
    projectRole: 'viewer',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'public',
    workspaceRole: null,
    projectRole: null,
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'owner',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'owner',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'owner',
    projectRole: 'viewer',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'owner',
    projectRole: null,
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'admin',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'admin',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'admin',
    projectRole: 'viewer',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'admin',
    projectRole: null,
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'member',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'member',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'member',
    projectRole: 'viewer',
    held: {
      'sprint:manage': false,
      'report:view': true,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: 'member',
    projectRole: null,
    held: {
      'sprint:manage': false,
      'report:view': true,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: null,
    projectRole: 'admin',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: null,
    projectRole: 'member',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: null,
    projectRole: 'viewer',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'open',
    workspaceRole: null,
    projectRole: null,
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'owner',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'owner',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'owner',
    projectRole: 'viewer',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'owner',
    projectRole: null,
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'admin',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'admin',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'admin',
    projectRole: 'viewer',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'admin',
    projectRole: null,
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'member',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'member',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'member',
    projectRole: 'viewer',
    held: {
      'sprint:manage': false,
      'report:view': true,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: 'member',
    projectRole: null,
    held: {
      'sprint:manage': false,
      'report:view': true,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: null,
    projectRole: 'admin',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: null,
    projectRole: 'member',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: null,
    projectRole: 'viewer',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'limited',
    workspaceRole: null,
    projectRole: null,
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'owner',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'owner',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'owner',
    projectRole: 'viewer',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'owner',
    projectRole: null,
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'admin',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'admin',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'admin',
    projectRole: 'viewer',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'admin',
    projectRole: null,
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'member',
    projectRole: 'admin',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': true,
      'work_item:delete': true,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'member',
    projectRole: 'member',
    held: {
      'sprint:manage': true,
      'report:view': true,
      'saved_filter:manage': true,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': true,
      'ai:plan': true,
      'ai:view_plan': true,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'member',
    projectRole: 'viewer',
    held: {
      'sprint:manage': false,
      'report:view': true,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: 'member',
    projectRole: null,
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: null,
    projectRole: 'admin',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: null,
    projectRole: 'member',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: null,
    projectRole: 'viewer',
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
  {
    accessLevel: 'private',
    workspaceRole: null,
    projectRole: null,
    held: {
      'sprint:manage': false,
      'report:view': false,
      'saved_filter:manage': false,
      'import:run': false,
      'work_item:delete': false,
      'work_item:triage': false,
      'ai:plan': false,
      'ai:view_plan': false,
    },
  },
];

describe('the eight member-facing keys resolve to exactly the actors the decision names', () => {
  it('covers every combination exactly once, and asserts all eight keys on every row', () => {
    expect(MEMBER_FACING_TABLE).toHaveLength(64);
    const seen = new Set(
      MEMBER_FACING_TABLE.map((r) => `${r.accessLevel}|${r.workspaceRole}|${r.projectRole}`),
    );
    expect(seen.size).toBe(64);
    for (const row of MEMBER_FACING_TABLE) {
      expect(Object.keys(row.held).sort()).toEqual([...MEMBER_FACING_KEYS].sort());
    }
  });

  it.each(MEMBER_FACING_TABLE)(
    'accessLevel=$accessLevel workspaceRole=$workspaceRole projectRole=$projectRole',
    ({ accessLevel, workspaceRole, projectRole, held }) => {
      const inputs: ProjectAccessInputs = { accessLevel, workspaceRole, projectRole };
      for (const key of MEMBER_FACING_KEYS) {
        expect(
          hasPermission(inputs, key),
          `${key}({ ${accessLevel}, ws=${workspaceRole}, proj=${projectRole} })`,
        ).toBe(held[key]);
      }
    },
  );

  it('all eight are role-holdable — the workspace-manager rail resolves to the whole array', () => {
    // The rail returns ROLE_GATED_PERMISSIONS verbatim, so this is really the
    // assertion that the eight JOINED that array. Stated directly rather than
    // trusted: a key left out of it is not holdable by anybody, and the wiring
    // card that calls assertPermission for it would refuse the project admin.
    for (const key of MEMBER_FACING_KEYS) {
      expect(ROLE_GATED_PERMISSIONS.includes(key), `${key} is not role-gated`).toBe(true);
    }
    for (const accessLevel of ['public', 'open', 'limited', 'private'] as const) {
      for (const workspaceRole of ['owner', 'admin'] as const) {
        const held = resolvePermissions({ accessLevel, workspaceRole, projectRole: null });
        for (const key of MEMBER_FACING_KEYS) {
          expect(held.has(key), `${workspaceRole} on ${accessLevel} lacks ${key}`).toBe(true);
        }
      }
    }
  });

  it('a project VIEWER holds report:view and none of the other seven', () => {
    for (const key of MEMBER_FACING_KEYS) {
      expect(BUILTIN_ROLE_PERMISSIONS.viewer.has(key), `viewer / ${key}`).toBe(
        key === 'report:view',
      );
    }
  });

  it('a project MEMBER holds six — not import:run, not work_item:delete', () => {
    for (const key of MEMBER_FACING_KEYS) {
      expect(BUILTIN_ROLE_PERMISSIONS.member.has(key), `member / ${key}`).toBe(
        key !== 'import:run' && key !== 'work_item:delete',
      );
    }
  });

  it('the implicit workspace-member grant grew by exactly report:view', () => {
    // The set the decision's §2 is about. Asserted as an exact set rather than a
    // per-key loop, so a key added here later fails loudly instead of widening
    // what a workspace membership means by itself.
    expect([...IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS].sort()).toEqual(
      [
        'attachment:create',
        'comment:add',
        'project:browse',
        'report:view',
        'work_item:edit',
      ].sort(),
    );
  });

  it('none of the eight is named by levelGrants — each behaves exactly as project:administer per level', () => {
    // §3's decision, proved rather than asserted in prose: the umbrella takes the
    // default arm of every level, so a key that also takes it must agree with the
    // umbrella wherever both are HELD by the actor's role. Restricting to rows
    // where the role holds the key is what separates "the level treats them the
    // same" (this) from "the same roles hold them" (the tests above) — the two
    // failures a levelGrants branch would produce look identical otherwise.
    for (const row of MEMBER_FACING_TABLE) {
      const inputs: ProjectAccessInputs = {
        accessLevel: row.accessLevel,
        workspaceRole: row.workspaceRole,
        projectRole: row.projectRole,
      };
      const umbrella = hasPermission(inputs, 'project:administer');
      if (!umbrella) continue;
      for (const key of MEMBER_FACING_KEYS) {
        expect(
          hasPermission(inputs, key),
          `${key} diverges from project:administer on { ${row.accessLevel}, ws=${row.workspaceRole}, proj=${row.projectRole} }`,
        ).toBe(true);
      }
    }
  });
});
