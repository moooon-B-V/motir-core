import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import type {
  EnterpriseRequestStatusValue,
  PlatformEnterpriseRequestDTO,
} from '@/lib/dto/platformEnterpriseRequest';

/**
 * The pieces the Enterprise-request list and detail share — design
 * `platform-admin/design-notes.md` § Enterprise requests, the state-set table.
 * No hooks beyond `useTranslations`, so a Server Component and a client island
 * both render them.
 *
 * Each open state's hue sits in a `--el-tint-*` BACKGROUND with
 * `--el-text-strong` ink (finding #35); Lost is the neutral surface pill. No
 * price appears anywhere: the tier at request is a NAME.
 */

const STATUS_CLASS: Record<EnterpriseRequestStatusValue, string> = {
  new: 'bg-(--el-tint-sky) border-transparent text-(--el-text-strong)',
  contacted: 'bg-(--el-tint-lavender) border-transparent text-(--el-text-strong)',
  offer_sent: 'bg-(--el-tint-yellow) border-transparent text-(--el-text-strong)',
  won: 'bg-(--el-tint-mint) border-transparent text-(--el-text-strong)',
  lost: 'bg-(--el-surface) border-(--el-border) text-(--el-text-secondary)',
};

export function EnterpriseRequestStatusPill({ status }: { status: EnterpriseRequestStatusValue }) {
  const t = useTranslations('platformAdmin.enterpriseRequests.status');
  return (
    <Pill tone="neutral" data-status={status} className={STATUS_CLASS[status]}>
      {t(status)}
    </Pill>
  );
}

/**
 * A tier key as a name — `team` → `Team`. The key is the tier's stable id, and
 * the console shows which plan the org was on, never what it cost.
 */
export function tierName(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The list's NEEDS cell — work items a day · parallel agents · which agents ·
 * runs on its own, joined by `·`. An unanswered one reads `{unit} —` in italic
 * secondary ink, so "they left it blank" is visible rather than a gap.
 */
export function RequestNeeds({ request }: { request: PlatformEnterpriseRequestDTO }) {
  const t = useTranslations('platformAdmin.enterpriseRequests');
  const bold = (chunks: React.ReactNode) => (
    <b className="font-semibold text-(--el-text)">{chunks}</b>
  );
  const parts: { key: string; node: React.ReactNode; unanswered: boolean }[] = [
    request.cardsPerDay === null
      ? { key: 'cards', node: t('needs.cardsPerDayNone'), unanswered: true }
      : {
          key: 'cards',
          node: t.rich('needs.cardsPerDay', { n: request.cardsPerDay, b: bold }),
          unanswered: false,
        },
    request.parallelAgents === null
      ? { key: 'agents', node: t('needs.agentsNone'), unanswered: true }
      : {
          key: 'agents',
          node: t.rich('needs.agents', { n: request.parallelAgents, b: bold }),
          unanswered: false,
        },
    request.agentPath === null
      ? { key: 'path', node: t('needs.agentPathNone'), unanswered: true }
      : { key: 'path', node: t(`agentPath.${request.agentPath}`), unanswered: false },
    request.autonomy === null
      ? { key: 'autonomy', node: t('needs.autonomyNone'), unanswered: true }
      : { key: 'autonomy', node: t(`autonomy.${request.autonomy}`), unanswered: false },
  ];
  return (
    <span
      data-testid="enterprise-request-needs"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-sans text-xs text-(--el-text-secondary)"
    >
      {parts.map((part, i) => (
        <span key={part.key} className="inline-flex items-center gap-1.5">
          {i > 0 ? <span aria-hidden>·</span> : null}
          <span className={part.unanswered ? 'italic' : undefined}>{part.node}</span>
        </span>
      ))}
    </span>
  );
}
