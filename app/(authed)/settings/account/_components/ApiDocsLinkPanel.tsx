import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

// The IN-APP DOOR to the API reference (Story 11.4 · Subtask 11.4.7 —
// MOTIR-2188 · design `design/api-docs/` Panel 8).
//
// ── Why it sits ABOVE the CLI panel and the token manager ───────────────────
// The reader with the sharpest need is someone who has just minted a PAT and is
// holding a secret with nothing to do with it. That is the same "the route out
// reads first" argument MOTIR-1869 used to put `ConnectCliPanel` above the token
// list — applied one line higher, because reading the docs is a cheaper first
// step than either minting a token by hand or installing a CLI.
//
// ⚠️ This component is the ONLY thing Story 11.4 adds to that page. The header,
// the CLI panel and the token manager below it belong to `design/settings/`
// (account-settings Panels 3–8 · token-scopes) and `design/cli-connect/`, and
// nothing about them changes — the design says so on both counts, and the card's
// acceptance criteria hold the page to it.

export async function ApiDocsLinkPanel() {
  const t = await getTranslations('apiDocs');
  return (
    <Card className="border-(--el-accent)">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <p className="m-0 text-sm font-medium text-(--el-text)">{t('doorHeading')}</p>
          <p className="mt-0.5 max-w-[58ch] text-[12.5px] leading-relaxed text-(--el-text-muted)">
            {t('doorBody')}
          </p>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          <Link href="/api-docs/getting-started">
            <Button variant="secondary" size="sm">
              {t('navGettingStarted')}
            </Button>
          </Link>
          <Link href="/api-docs">
            <Button variant="primary" size="sm">
              {t('doorReferenceCta')}
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}
