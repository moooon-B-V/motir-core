import type { ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Archive, ChevronLeft, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { StaffIdeaDto } from '@/lib/dto/ideas';
import { IdeaCategoryPill, IdeaKindPill, IdeaStatusPill, IdeaTagChip } from './IdeaBits';

/**
 * One idea, READ — design § Ideas Panels 4, 5 and 10's support view. The header
 * (title, status / kind / category pills and the role's ACTIONS), the Retired
 * box when it is retired, then two columns: _The idea_ on the left — pitch,
 * what it does, the gap, why now, the two Motir-would-buy fields on that kind,
 * and the evidence in order — and _Tags_ and _Record_ on the right.
 *
 * An empty optional field reads in italic (_Not written._) rather than
 * vanishing, so a reviewer can tell "nobody wrote it" from "the page lost it".
 *
 * No hooks beyond next-intl's, so the server page renders it and the actions'
 * client island (MOTIR-7681) can render it again after a save, from the DTO the
 * save returned. `actions` is the slot that island fills; `retiredBy` names who
 * retired the idea when the caller knows it.
 */

export interface IdeaDetailViewProps {
  idea: StaffIdeaDto;
  /** The header's right-hand side: the role's buttons, or the support line. */
  actions?: ReactNode;
  /** Above the columns: a save confirmation, a refusal callout. */
  notice?: ReactNode;
  /** Who retired it, from the audit log, when the caller has read it. */
  retiredBy?: string | null;
  /** Evidence rows to mark _New_ (MOTIR-7681's just-saved rows), by position. */
  newEvidence?: ReadonlySet<number>;
  /** Replaces the two columns — the edit form, which opens in place (Panel 6). */
  body?: ReactNode;
}

export function IdeaDetailView({
  idea,
  actions,
  notice,
  retiredBy,
  newEvidence,
  body,
}: IdeaDetailViewProps) {
  const t = useTranslations('platformAdmin.ideas');
  const format = useFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-4" data-testid="idea-detail" data-status={idea.status}>
      <Link
        href="/admin/ideas"
        className="inline-flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
      >
        <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
        {t('detail.back')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="font-serif text-2xl text-(--el-text)">{idea.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <IdeaStatusPill status={idea.status} />
            <IdeaKindPill kind={idea.kind} />
            <IdeaCategoryPill label={idea.category.label} />
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>

      {notice}

      {idea.status === 'retired' ? (
        <div
          data-testid="idea-retired-box"
          className="flex items-start gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding) font-sans text-sm"
        >
          <Archive aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-secondary)" />
          <div className="flex flex-col gap-1">
            <p className="text-(--el-text)">
              {t('retiredBox.title', { reason: idea.retiredReason ?? '' })}
            </p>
            {idea.retiredAt ? (
              <p className="text-xs text-(--el-text-secondary)">
                {retiredBy
                  ? t('retiredBox.metaBy', { when: dateTime(idea.retiredAt), who: retiredBy })
                  : t('retiredBox.meta', { when: dateTime(idea.retiredAt) })}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {body ?? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card
            data-testid="idea-body"
            header={
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('detail.idea')}
              </h2>
            }
          >
            <div className="flex flex-col gap-5 font-sans text-sm">
              <Field label={t('detail.pitch')}>
                <p className="text-(--el-text)">{idea.pitch}</p>
              </Field>
              <Field label={t('detail.capabilities')}>
                {idea.capabilities.length > 0 ? (
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-(--el-text)">
                    {idea.capabilities.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : (
                  <Unwritten>{t('detail.noCapabilities')}</Unwritten>
                )}
              </Field>
              <Prose label={t('detail.gap')} value={idea.gap} none={t('detail.notWritten')} />
              <Prose label={t('detail.whyNow')} value={idea.whyNow} none={t('detail.notWritten')} />
              {idea.kind === 'motir_buys' ? (
                <>
                  <Prose
                    label={t('detail.whyMotir')}
                    value={idea.whyMotir}
                    none={t('detail.notWritten')}
                  />
                  <Prose
                    label={t('detail.whoElse')}
                    value={idea.whoElse}
                    none={t('detail.notWritten')}
                  />
                </>
              ) : null}
              <section aria-labelledby="idea-evidence-heading" className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h3
                    id="idea-evidence-heading"
                    className="text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)"
                  >
                    {t('detail.evidence')}
                  </h3>
                  <span className="text-xs text-(--el-text-secondary)">
                    {t('detail.sources', { n: idea.evidence.length })}
                  </span>
                </div>
                {idea.evidence.length === 0 ? (
                  <Unwritten>{t('detail.noEvidence')}</Unwritten>
                ) : (
                  <ol data-testid="idea-evidence" className="flex flex-col gap-2">
                    {idea.evidence.map((e, i) => (
                      <li
                        key={i}
                        data-testid="idea-evidence-row"
                        className="flex gap-3 rounded-(--radius-card) border border-(--el-border-soft) p-(--spacing-card-padding)"
                      >
                        <span aria-hidden className="font-mono text-xs text-(--el-text-identifier)">
                          {i + 1}
                        </span>
                        <div className="flex min-w-0 flex-col gap-1">
                          <p className="text-(--el-text)">
                            {e.claim}
                            {newEvidence?.has(i) ? (
                              <span className="ml-2 rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs text-(--el-text-strong)">
                                {t('detail.newRow')}
                              </span>
                            ) : null}
                          </p>
                          <p className="text-xs text-(--el-text-secondary)">
                            {e.sourceDate
                              ? `${e.sourceName} · ${date(`${e.sourceDate}T00:00:00Z`)}`
                              : e.sourceName}
                          </p>
                          <a
                            href={e.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex w-fit max-w-full items-center gap-1 break-all text-xs text-(--el-link) hover:underline"
                          >
                            <span className="break-all">{e.url}</span>
                            <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
                            <span className="sr-only">{t('detail.newTab')}</span>
                          </a>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </Card>

          <div className="flex flex-col gap-4">
            <Card
              data-testid="idea-tags"
              header={
                <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                  {t('detail.tags')}
                </h2>
              }
            >
              {idea.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {idea.tags.map((tag) => (
                    <IdeaTagChip key={tag.slug} tag={tag} />
                  ))}
                </div>
              ) : (
                <Unwritten>{t('detail.noTags')}</Unwritten>
              )}
            </Card>
            <Card
              data-testid="idea-record"
              header={
                <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                  {t('detail.record')}
                </h2>
              }
            >
              <dl className="flex flex-col gap-2 font-sans text-sm">
                <Row label={t('record.slug')}>
                  <code className="font-mono text-xs text-(--el-text-identifier)">{idea.slug}</code>
                </Row>
                <Row label={t('record.added')}>{date(idea.addedAt)}</Row>
                <Row label={t('record.lastEdited')}>{date(idea.updatedAt)}</Row>
                <Row label={t('record.lastReviewed')}>
                  {idea.lastReviewedAt ? date(idea.lastReviewedAt) : t('record.notReviewed')}
                </Row>
                <Row label={t('record.onSite')}>
                  {idea.status === 'active'
                    ? t('record.onSiteYes', { category: idea.category.label })
                    : t('record.onSiteNo')}
                </Row>
              </dl>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
        {label}
      </h3>
      {children}
    </div>
  );
}

function Prose({ label, value, none }: { label: string; value: string | null; none: string }) {
  return (
    <Field label={label}>
      {value ? (
        <p className="whitespace-pre-line text-(--el-text)">{value}</p>
      ) : (
        <Unwritten>{none}</Unwritten>
      )}
    </Field>
  );
}

function Unwritten({ children }: { children: ReactNode }) {
  return <p className="font-sans text-sm italic text-(--el-text-secondary)">{children}</p>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-(--el-text-secondary)">{label}</dt>
      <dd className="text-(--el-text)">{children}</dd>
    </div>
  );
}
