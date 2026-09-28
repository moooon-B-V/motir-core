'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ArrowLeft, Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { AuthShell, FormAlert } from '../../../../_components/AuthShell';
import { recordVisitorConsentAction } from '../_actions';

/**
 * The Visitor's consent card (Story MOTIR-6170 · MOTIR-6669; design MOTIR-6641
 * panels 2–3, `design/visitor/visitor--consent.mock.html`).
 *
 * ⚠️ AN AFFIRMATIVE ACT, NOT A NOTICE — and NOT AN ERROR STATE. It is the
 * re-consent card's frame (`app/(auth)/re-consent/_components/ReconsentCard.tsx`):
 * no danger ink, no `role="alert"`, an `h1` that says what it is. The one
 * `FormAlert` is for a FAILED WRITE, the only real error the screen can have.
 *
 * The sentence names WHO sees the details (this project's workspace Managers) and
 * WHAT (name, email, when you visit), and the row shows the reader their OWN name
 * and email — the one address this screen may show, because it is theirs.
 */
export function VisitorConsentCard({
  identifier,
  projectName,
  workspaceName,
  reader,
  destination,
  goBackHref,
}: {
  identifier: string;
  projectName: string;
  workspaceName: string;
  reader: { name: string | null; email: string };
  /** Already validated server-side: a path inside this project's Visitor views. */
  destination: string;
  /** motir.co's page for the project when the reader came from there, else `/`. */
  goBackHref: string;
}) {
  const t = useTranslations('visitor.consent');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  const displayName = reader.name?.trim() || tCommon('personFallback');
  const bold = (chunks: React.ReactNode) => (
    <b className="font-semibold text-(--el-text)">{chunks}</b>
  );

  function onContinue() {
    setFailed(false);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof recordVisitorConsentAction>>;
      try {
        result = await recordVisitorConsentAction(identifier);
      } catch {
        // The record IS the screen's purpose, so a failed write must not send the
        // reader on as though it had succeeded — the Visitor layout would only send
        // them back here. Say so and let them retry.
        setFailed(true);
        return;
      }
      if (result.ok || result.reason === 'member') {
        // Recorded — or they turned out to be a member, who never needed to agree
        // and whose own view the destination sends them on to.
        router.push(destination);
        return;
      }
      // The project stopped being public since the screen was drawn: a reload
      // answers the same not-found anyone else gets.
      router.refresh();
    });
  }

  return (
    <AuthShell
      tight
      headline={t('headline', { project: projectName })}
      subhead={t.rich('body', { project: projectName, workspace: workspaceName, b: bold })}
      eyebrow={
        // The tint carries the hue in the BACKGROUND with `--el-text-strong` ink —
        // the AA-safe recipe every coloured Pill tone uses.
        <Pill className="border-transparent bg-(--el-tint-sky) text-(--el-text-strong)">
          <Eye className="h-3.5 w-3.5" aria-hidden />
          {t('pill', { workspace: workspaceName })}
        </Pill>
      }
    >
      <div className="flex flex-col gap-5">
        {failed ? <FormAlert>{t('failed')}</FormAlert> : null}

        <div className="flex flex-col gap-2">
          <p className="font-sans text-xs font-medium tracking-wide text-(--el-text-secondary) uppercase">
            {t('seeLabel')}
          </p>
          <div className="flex items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding)">
            <span
              aria-hidden
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold text-(--el-text-strong) ${
                reader.name?.trim() ? 'bg-(--el-tint-sky)' : 'bg-(--el-tint-lavender)'
              }`}
            >
              {initials(displayName)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-sans text-sm font-medium text-(--el-text)">
                {displayName}
              </span>
              <span className="truncate font-sans text-[13px] text-(--el-text-secondary)">
                {t('seeRow', { email: reader.email })}
              </span>
            </span>
          </div>
        </div>

        <Button
          type="button"
          variant="primary"
          size="lg"
          className="w-full"
          loading={pending}
          onClick={onContinue}
        >
          {pending ? t('continuing') : t('continue')}
        </Button>

        {/* THE WAY OUT — a ghost in the foot. The line under it removes the fear
            that leaving costs something. Inert while Continue is saving, so the
            two cannot race. */}
        <div className="flex flex-col items-start gap-2 border-t border-(--el-border) pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            leftIcon={<ArrowLeft className="h-4 w-4" aria-hidden />}
            onClick={() => {
              window.location.assign(goBackHref);
            }}
          >
            {t('goBack')}
          </Button>
          <p className="font-sans text-[13px] text-(--el-text-secondary)">
            {t('goBackLine', { project: projectName })}
          </p>
        </div>
      </div>
    </AuthShell>
  );
}

/** Up to two initials of a display name, for the decorative avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]![0], parts[parts.length - 1]![0]] : [parts[0]?.[0]];
  return letters.filter(Boolean).join('').toUpperCase();
}
