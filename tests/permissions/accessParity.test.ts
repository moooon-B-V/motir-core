import type { MemberRole, ProjectAccessLevel } from '@prisma/client';
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
