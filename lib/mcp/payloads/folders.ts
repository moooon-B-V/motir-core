import { z } from 'zod/v4';
import { folderDeletionSchema, folderSchema } from '@/lib/api/v1/folders/schema';
import { definePayload } from './define';

// The FOLDER payload shapes (Story MOTIR-5310 · MOTIR-5409).
//
// ── The happy case, like sprints ────────────────────────────────────────────
// `/api/v1` publishes the folder resource (`Folder`, MOTIR-5408) and the delete
// body (`FolderDeletion`), so the two folder WRITES return exactly those shapes
// and carry a REAL probe: the drift guard compares the MCP payload with the v1
// resource directly, and a field added on one surface and forgotten on the
// other fails the build.
//
// ── `list_folders` is a declared NARROWING ──────────────────────────────────
// The whole-tree read serves the Move to… picker's rows, which carry no
// timestamps and no project key per row — so each row is `.pick`ed off the v1
// resource and the payload carries no probe, the same reason the `search_work_items`
// row carries none. The derivation is proven at the TYPE level: the pick breaks
// when the base does.

/** The single-folder confirmation `create_folder` / `update_folder` return — v1's `Folder`. */
export const folderWritePayload = definePayload({
  schema: folderSchema as unknown as z.ZodType<z.infer<typeof folderSchema>>,
  probes: [{ resource: 'Folder', select: (p) => [p] }],
});

/** What `delete_folder` moved, and where — v1's `FolderDeletion`. */
export const folderDeletionPayload = definePayload({
  schema: folderDeletionSchema as unknown as z.ZodType<z.infer<typeof folderDeletionSchema>>,
  probes: [{ resource: 'FolderDeletion', select: (p) => [p] }],
});

/** One `list_folders` row: a narrowing of v1's `Folder`. */
export const mcpFolderRowSchema = folderSchema.pick({
  id: true,
  parentFolderId: true,
  name: true,
  path: true,
});
export type McpFolderRow = z.infer<typeof mcpFolderRowSchema>;

/** The `list_folders` tree. */
export const listFoldersPayload = definePayload({
  schema: z
    .object({
      projectKey: z.string(),
      folders: z.array(mcpFolderRowSchema),
      truncated: z.boolean(),
    })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { projectKey: string; folders: McpFolderRow[]; truncated: boolean } & Record<string, unknown>
  >,
  probes: [],
});
