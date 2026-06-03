import { Prisma, type Attachment } from '@prisma/client';

// Single-op data access for the `attachment` table (Subtask 2.3.7). Write
// requires `tx` (the 4-layer rule); the service wraps it in withWorkspaceContext
// so the RLS policy's `app.workspace_id` GUC is bound.
export const attachmentRepository = {
  async create(
    data: Prisma.AttachmentUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Attachment> {
    return tx.attachment.create({ data });
  },
};
