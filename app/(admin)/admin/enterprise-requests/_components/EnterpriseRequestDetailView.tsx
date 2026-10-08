import type { ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowRight, ChevronLeft, History } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { PlatformEnterpriseRequestDetailDTO } from '@/lib/dto/platformEnterpriseRequest';
import { EnterpriseRequestStatusPill, tierName } from './EnterpriseRequestBits';
import { tenantHref } from './requestListQuery';

/**
 * One Enterprise request, READ — design § Enterprise requests Panels 4, 6 and
 * 7. A **Back to requests** link, the org name as the heading with the state
 * pill and _Sent {date}_; then _The request_ (every answer the org gave, the
 * contact and the note, with **Open {org} in Tenants →** in its head) and, on
 * the right, the state card (`stateCard` — the caller's island) above
 * **History**, oldest first.
 *
 * Below `md` it is one column in the design's order — header, the state card,
 * the request, then History (Panel 9) — so the DOM carries that order and the
 * wide grid places the request in the left column across both rows.
 *
 * An unanswered field reads _Not answered_ rather than vanishing, so a reader
 * can tell "they left it blank" from "the page lost it". No price anywhere.
 */
export function EnterpriseRequestDetailView({
  detail,
  stateCard,
}: {
  detail: PlatformEnterpriseRequestDetailDTO;
  stateCard: ReactNode;
}) {
  const t = useTranslations('platformAdmin.enterpriseRequests');
  const format = useFormatter();
  const { request, history } = detail;
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const none = <span className="italic text-(--el-text-secondary)">{t('notAnswered')}</span>;
  const answered = (value: ReactNode | null) => (value === null ? none : value);

  const fields: { key: string; label: string; value: ReactNode }[] = [
    {
      key: 'organisation',
      label: t('detail.field.organisation'),
      value: request.tierKeyAtRequest
        ? `${request.organizationName} · ${t('tierWhenSent', { tier: tierName(request.tierKeyAtRequest) })}`
        : request.organizationName,
    },
    {
      key: 'requester',
      label: t('detail.field.requester'),
      value: request.requester ? (
        `${request.requester.name} · ${request.requester.email}`
      ) : (
        <span className="italic text-(--el-text-secondary)">{t('requesterGone')}</span>
      ),
    },
    {
      key: 'contact',
      label: t('detail.field.contact'),
      value: answered(request.contact || null),
    },
    { key: 'sent', label: t('detail.field.sent'), value: dateTime(request.createdAt) },
    {
      key: 'cardsPerDay',
      label: t('detail.field.cardsPerDay'),
      value: answered(request.cardsPerDay === null ? null : format.number(request.cardsPerDay)),
    },
    {
      key: 'parallelAgents',
      label: t('detail.field.parallelAgents'),
      value: answered(
        request.parallelAgents === null ? null : format.number(request.parallelAgents),
      ),
    },
    {
      key: 'agentPath',
      label: t('detail.field.agentPath'),
      value: answered(request.agentPath ? t(`agentPath.${request.agentPath}`) : null),
    },
    {
      key: 'autonomy',
      label: t('detail.field.autonomy'),
      value: answered(request.autonomy ? t(`autonomy.${request.autonomy}`) : null),
    },
    {
      key: 'startWhen',
      label: t('detail.field.startWhen'),
      value: answered(request.startWhen ? t(`startWhen.${request.startWhen}`) : null),
    },
    {
      key: 'teamSize',
      label: t('detail.field.teamSize'),
      value: answered(request.teamSize ? t(`teamSize.${request.teamSize}`) : null),
    },
  ];

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="enterprise-request-detail"
      data-status={request.status}
    >
      <Link
        href="/admin/enterprise-requests"
        className="inline-flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
      >
        <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
        {t('detail.back')}
      </Link>

      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{request.organizationName}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <EnterpriseRequestStatusPill status={request.status} />
          <Pill tone="neutral">{t('detail.sent', { date: date(request.createdAt) })}</Pill>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="md:col-start-2 md:row-start-1">{stateCard}</div>

        <Card
          data-testid="enterprise-request-body"
          className="md:col-start-1 md:row-span-2 md:row-start-1"
          header={
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('detail.requestTitle')}
              </h2>
              <Link
                data-testid="enterprise-request-org-link"
                href={tenantHref(request.organizationId)}
                className="inline-flex items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
              >
                {t('detail.orgLink', { org: request.organizationName })}
                <ArrowRight aria-hidden className="h-3.5 w-3.5" />
              </Link>
            </div>
          }
        >
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 font-sans text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
            {fields.map((field) => (
              <div key={field.key} className="contents">
                <dt className="text-(--el-text-secondary)">{field.label}</dt>
                <dd data-field={field.key} className="break-words text-(--el-text)">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-5 mb-1.5 font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
            {t('detail.field.note')}
          </h3>
          {request.note ? (
            <blockquote
              data-testid="enterprise-request-note"
              className="whitespace-pre-wrap rounded-(--radius-control) border-l-2 border-(--el-border-strong) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text)"
            >
              {request.note}
            </blockquote>
          ) : (
            <p className="font-sans text-sm">{none}</p>
          )}
        </Card>

        <Card
          data-testid="enterprise-request-history"
          className="md:col-start-2 md:row-start-2"
          header={
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-text-strong)"
                >
                  <History className="h-3.5 w-3.5" />
                </span>
                <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                  {t('history.title')}
                </h2>
              </div>
              <Pill tone="neutral">{t('history.order')}</Pill>
            </div>
          }
        >
          <ol className="flex flex-col font-sans text-sm">
            <HistoryEntry
              move={
                <>
                  {t('history.sent')} <EnterpriseRequestStatusPill status="new" />
                </>
              }
              who={`${
                request.requester
                  ? t('history.requesterOf', {
                      name: request.requester.name,
                      org: request.organizationName,
                    })
                  : request.organizationName
              } · ${dateTime(request.createdAt)}`}
            />
            {history.map((move, i) => (
              <HistoryEntry
                key={`${move.at}-${i}`}
                move={
                  <>
                    <EnterpriseRequestStatusPill status={move.from} />
                    <ArrowRight
                      role="img"
                      aria-label={t('history.to')}
                      className="h-3 w-3 text-(--el-text-secondary)"
                    />
                    <EnterpriseRequestStatusPill status={move.to} />
                  </>
                }
                who={`${move.actorEmail} · ${dateTime(move.at)}`}
              />
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}

function HistoryEntry({ move, who }: { move: ReactNode; who: string }) {
  return (
    <li
      data-testid="enterprise-request-history-entry"
      className="flex gap-2.5 border-b border-(--el-border-soft) py-2.5 last:border-b-0"
    >
      <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-(--el-border-strong)" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5 text-(--el-text)">{move}</span>
        <span className="text-xs text-(--el-text-secondary)">{who}</span>
      </div>
    </li>
  );
}
