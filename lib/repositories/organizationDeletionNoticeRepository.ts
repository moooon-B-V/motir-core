import type {
  OrganizationDeletionNotice,
  OrganizationDeletionNoticeKind,
  Prisma,
} from '@/generated/prisma/client';

// Data access for `organization_deletion_notice` (Story MOTIR-6306 · MOTIR-6395) —
// the record that one email notice went out for one organization-deletion
// request. Single Prisma operations; the notifier owns the order.
//
// ⚠️ EVERY METHOD TAKES `tx`. The table is RLS-gated on `app.system_admin` alone,
// bound by `withSystemContext`; on the `db` singleton every read is empty and every
// write is refused, silently for the read.

export interface NoticeKey {
  requestId: string;
  kind: OrganizationDeletionNoticeKind;
  /** The reminder's day count; 0 for the one-off notices. */
  daysLeft: number;
}

export const organizationDeletionNoticeRepository = {
  /** The notice already recorded for this key, or null. */
  async find(
    key: NoticeKey,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationDeletionNotice | null> {
    return tx.organizationDeletionNotice.findUnique({
      where: { requestId_kind_daysLeft: key },
    });
  },

  /**
   * Record a notice as sent. A concurrent second recorder loses on the unique
   * `(request_id, kind, days_left)` with a `P2002`, which the notifier treats as
   * "already recorded".
   */
  async create(key: NoticeKey, tx: Prisma.TransactionClient): Promise<OrganizationDeletionNotice> {
    return tx.organizationDeletionNotice.create({ data: key });
  },
};
