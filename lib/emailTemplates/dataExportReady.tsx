import { Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// The personal-data export is READY (Story 8.4 · Subtask MOTIR-3703). Design of
// record: `design/settings/design-notes.md` → `Data & privacy` → DECISION 2.
//
// ⚠️ THIS EMAIL CARRIES NO LINK TO THE FILE, AND THAT IS A MEASUREMENT RATHER
// THAN A PREFERENCE. A private object is handed over by a presigned URL with a
// 300-second TTL (`signedDownloadUrl` in `lib/blob/uploader.ts`, pinned by
// `docs/decisions/attachment-access-control.md` §5). A URL that dies in five
// minutes is expired before most people open their inbox, so mailing it would
// be a design the storage layer cannot implement. The email is a nudge back to
// a surface that can authenticate the reader; the download is minted on the
// click, in the pane.
//
// So the ONE link here is the PANE, and the retention window is the thing that
// makes coming back a real instruction rather than a race. `retentionDays` is
// interpolated from `DATA_EXPORT_RETENTION_DAYS` by the service — the promise
// and the behaviour cannot drift, which is the same doctrine
// `lib/users/dataSubjectRequests.ts` states for both windows.
//
// Localized via next-intl's synchronous `createTranslator` (rendering runs
// off-request, in the `email.send` job); `locale` defaults to the base locale
// when absent. Mirrors `emailChange.tsx`.

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface DataExportReadyEmailProps {
  recipientName: string;
  /** The `Data › Data & privacy` pane — the ONLY link this email carries. */
  paneUrl: string;
  /** How long the archive stays downloadable, from the shared constant. */
  retentionDays: number;
  locale?: Locale;
}

function DataExportReadyEmail({
  recipientName,
  paneUrl,
  retentionDays,
  t,
}: DataExportReadyEmailProps & { t: T }) {
  return (
    <EmailLayout preview={t('preview')} footer={t('retention', { days: retentionDays })}>
      <Text style={greeting}>{t('greeting', { name: recipientName })}</Text>
      <Text style={lede}>{t('lede')}</Text>
      <Section style={cta}>
        <PrimaryButton href={paneUrl} label={t('open')} />
      </Section>
      <Text style={note}>{t('freshLink')}</Text>
    </EmailLayout>
  );
}

const greeting = { fontSize: '16px', margin: '0 0 16px' };
const lede = { fontSize: '16px', margin: '0 0 24px' };
const cta = { margin: '0 0 24px' };
const note = { color: '#6b7280', fontSize: '14px', margin: '0 0 24px' };

export async function dataExportReadyEmail(
  props: DataExportReadyEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.dataExportReady',
  }) as T;
  const html = await render(<DataExportReadyEmail {...props} t={t} />);
  return {
    subject: t('subject'),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(props: DataExportReadyEmailProps, t: T): string {
  return [
    t('greeting', { name: props.recipientName }),
    '',
    t('lede'),
    '',
    `${t('open')}: ${props.paneUrl}`,
    '',
    t('freshLink'),
    '',
    t('retention', { days: props.retentionDays }),
    '',
    '— Motir',
  ].join('\n');
}

export default DataExportReadyEmail;
