'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { FileText, LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { signOut } from '@/lib/auth/client';
import type { OutstandingDocument } from '@/lib/legal/consent';
import { AuthShell, FormAlert } from '../../_components/AuthShell';
import { LegalDocumentRow } from './LegalDocumentRow';
import { acceptCurrentLegalDocumentsAction } from '../_actions';

/**
 * The re-consent interstitial's card (Story 8.4 · Subtask MOTIR-1135 · design
 * `design/auth/legal-agreement.mock.html`, panels 5–7).
 *
 * ⚠️ AN AFFIRMATIVE ACT, NOT A PASSIVE STATEMENT — the exact opposite of the
 * sign-up notice, and the asymmetry IS the argument. At sign-up there is another
 * act to attach the agreement to (creating the account, Art. 6(1)(b)), so the
 * notice is a paragraph. Here there is none, and `motir.co/legal/terms` §14
 * promises outright that we *"will not treat silence as agreement to a material
 * change"* — a passive line on a hold screen would be exactly the silence that
 * clause disclaims. So this screen has a real primary button.
 *
 * ⚠️ ONE AGREEMENT, ONE CONTROL. `motir.co/legal/terms` §15 makes the Terms, the Acceptable
 * Use Policy and the Privacy Policy a single agreement, so a per-document
 * tick-box would ask for three decisions where the product offers one outcome,
 * and each would need its own label. The button's own words carry the scope
 * instead (*"Agree to both and continue"*).
 *
 * ⚠️ NOT AN ERROR STATE. No `--el-danger` fill, no red banner, no `role="alert"`
 * and no `aria-live` anywhere on the held screen: nothing has gone wrong, a
 * document was updated, and announcing a policy update as an error is both wrong
 * and alarming. It is an ordinary page with an `h1` that says what it is. The one
 * `FormAlert` below is for a FAILED WRITE — an actual error — and it is the only
 * danger ink on the surface.
 *
 * The three exits are three different things, and the design is emphatic that
 * they must stay so:
 *
 *   * **Agree and continue** — the affirmative act; the versions and timestamp
 *     are recorded and the person lands back where they were going.
 *   * **Not now — sign out** — DEFERRING. Nothing is recorded, nothing changes,
 *     the same screen appears at the next sign-in. A ghost button in the foot,
 *     present always, never competing with the primary action: every other route
 *     is closed to this person, so a screen with no exit is a trap.
 *   * **I don't accept** — DECLINING. A local view, not a navigation, because
 *     **nothing is destroyed here**.
 */
export function ReconsentCard({
  documents,
  destination,
}: {
  documents: OutstandingDocument[];
  /** Already sanitized server-side — a same-origin path, never a URL. */
  destination: string;
}) {
  const t = useTranslations('legal.reconsent');
  const router = useRouter();
  const [view, setView] = useState<'agree' | 'decline'>('agree');
  const [failed, setFailed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [pending, startTransition] = useTransition();

  if (view === 'decline') {
    return <DeclineView onBack={() => setView('agree')} />;
  }

  const headline =
    documents.length === 1
      ? t('headlineOne', { document: documents[0]!.title })
      : t('headlineMany', { count: documents.length });

  // The button's own words carry the scope. Three arms rather than a plural
  // rule, because "both" is not a plural form English gets from a count.
  const agreeLabel =
    documents.length === 1
      ? t('agreeOne')
      : documents.length === 2
        ? t('agreeTwo')
        : t('agreeMany');

  // The chip carries the effective date of the FIRST changed document — the one
  // the headline names when there is one. `null` while nothing is in force yet
  // (`effectiveDate: TBD`), which is the meaningful state before the service
  // opens, and the chip then says so rather than rendering a sentinel.
  const effectiveDate = documents[0]?.effectiveDate ?? null;

  function onAgree() {
    setFailed(false);
    startTransition(async () => {
      try {
        await acceptCurrentLegalDocumentsAction();
      } catch {
        // The record is the whole point of the screen, so a failed write must
        // not send them onward as though it had succeeded — the gate would only
        // catch them again on the next page load, which reads as the button
        // being broken. Say so and let them retry.
        setFailed(true);
        return;
      }
      router.push(destination);
    });
  }

  async function onSignOut() {
    setSigningOut(true);
    // `/re-consent` with no session renders the DEFERRED screen (panel 8), which
    // is where this belongs: "nothing has changed" is a sentence somebody is
    // owed while they can still read it.
    await signOut({ fetchOptions: { onSuccess: () => router.push('/re-consent') } });
  }

  return (
    // ⚠️ `tight`, and the chip is an EYEBROW — both measured against the mock
    // rather than chosen. `.ac-head` draws the chip ABOVE the headline (chip →
    // `h1` → body copy) and sizes that `h1` at **32px**, which sits between
    // `AuthShell`'s two modes (24px `tight`, 36/48px default). `tight` is the
    // one that fits: it is the named mode for a screen with a measured content
    // budget, and this card carries a chip, body copy, up to three document
    // rows, a primary and a two-line foot. The default 5xl wrapped this
    // headline onto three lines at 448px — the card's fixed column width — and
    // pushed the way out below the fold, which is the failure `tight` exists
    // for. Inventing a third size for one screen, or hand-rolling the header
    // here, is what this component's own docstring forbids.
    <AuthShell
      tight
      headline={headline}
      subhead={t('body')}
      eyebrow={
        // The tint carries the hue in the BACKGROUND with `--el-text-strong`
        // ink — the same AA-safe recipe every other coloured Pill tone uses,
        // and the reason there is no danger ink anywhere on this screen.
        // `border-transparent` matches the tinted tones: `Pill`'s base sets
        // `border` and only a variant supplies its colour.
        <Pill className="border-transparent bg-(--el-tint-sky) text-(--el-text-strong)">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          {effectiveDate ? t('takesEffect', { date: effectiveDate }) : t('notYetEffective')}
        </Pill>
      }
    >
      <div className="flex flex-col gap-5">
        {failed ? <FormAlert>{t('agreeFailed')}</FormAlert> : null}

        <ul className="flex list-none flex-col gap-3 p-0">
          {documents.map((document) => (
            <ChangedDocumentRow key={document.slug} document={document} />
          ))}
        </ul>

        <Button
          type="button"
          variant="primary"
          size="lg"
          className="w-full"
          loading={pending}
          onClick={onAgree}
        >
          {pending ? t('agreeing') : agreeLabel}
        </Button>

        {/* THE WAY OUT — a ghost in the foot, on every held view. The line under
            it removes the fear that leaving costs something, which is why it is
            not optional chrome. */}
        <div className="flex flex-col items-start gap-2 border-t border-(--el-border) pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leftIcon={<LogOut className="h-4 w-4" aria-hidden />}
            loading={signingOut}
            onClick={onSignOut}
          >
            {signingOut ? t('signingOut') : t('notNow')}
          </Button>
          <p className="font-sans text-[13px] text-(--el-text-secondary)">
            {/* A `button` styled as a link, not an anchor with an address that
                does not exist: declining changes the card's own state, it does
                not navigate. */}
            {t.rich('askAgain', {
              decline: (chunks) => (
                <button
                  type="button"
                  onClick={() => setView('decline')}
                  className="text-(--el-link) hover:text-(--el-link-pressed) focus-visible:underline focus-visible:outline-none"
                >
                  {chunks}
                </button>
              ),
            })}
          </p>
        </div>
      </div>
    </AuthShell>
  );
}

/**
 * One changed document, as a {@link LegalDocumentRow}: the delta a reader is
 * being asked to accept, plus the author's sentence about what moved.
 */
function ChangedDocumentRow({ document }: { document: OutstandingDocument }) {
  const t = useTranslations('legal.reconsent');
  return (
    <LegalDocumentRow
      title={document.title}
      versionLabel={
        document.acceptedVersion
          ? t('versionDelta', { from: document.acceptedVersion, to: document.currentVersion })
          : // A document they never accepted reads as NEW rather than as a delta
            // from nothing.
            t('versionNew', { version: document.currentVersion })
      }
      summary={document.changeSummary}
      url={document.url}
      linkLabel={t('readNewVersion')}
    />
  );
}

/**
 * DECLINING — drawn whole, because it is the half most likely to be skipped and
 * the half a regulator reads first (design panel 7). A decline path that
 * silently does nothing is worse than no decline path.
 *
 * ⚠️ NOTHING IS DESTROYED HERE, and the copy says so outright. The screen states
 * the outcome the Terms already promise — *"if you do not accept it, you may
 * terminate and receive a pro-rata refund of prepaid fees for the unused
 * period"* (§14) — and offers a way to talk to someone. `← Back` returns to the
 * agree view; this is a local view change, not a navigation, precisely because
 * reading the consequence must not itself be a commitment.
 *
 * ⚠️ THE TWO ROUTE CARDS THE DESIGN DRAWS — *"Download your data first"* and
 * *"Close my account"* — ARE NOT BUILT HERE, and that is an amendment on the
 * record rather than a quiet omission. The design is explicit that this screen
 * MOUNTS the export / delete surface and does not redraw it (*"Drawing an export
 * flow here would build it twice and drift from the real one"*), and that surface
 * is **MOTIR-1136's**, designed in 8.4.16 (MOTIR-3680) and not yet shipped:
 * `app/(authed)/settings/account/` today holds profile, security, tokens,
 * notifications, appearance and language, and nothing that exports or closes an
 * account. Two cards linking to a page that 404s would be worse than the honest
 * form, and worse than the fallback the design itself supplies for this screen —
 * **legal@motir.co**, which is `motir.co/legal/terms` §15's own notice address
 * and a route a person can actually use today. When MOTIR-1136 lands, the two
 * cards mount above the contact line.
 */
function DeclineView({ onBack }: { onBack: () => void }) {
  const t = useTranslations('legal.reconsent');
  return (
    <AuthShell tight headline={t('declineHeadline')} subhead={t('declineBody')}>
      <div className="flex flex-col gap-5">
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t.rich('declineFoot', {
            contact: (chunks) => (
              <a
                href="mailto:legal@motir.co"
                className="text-(--el-link) hover:text-(--el-link-pressed) focus-visible:underline focus-visible:outline-none"
              >
                {chunks}
              </a>
            ),
          })}
        </p>
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack}>
          {t('back')}
        </Button>
      </div>
    </AuthShell>
  );
}
