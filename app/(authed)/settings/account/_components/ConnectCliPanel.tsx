'use client';

import { BookOpen, Copy, Terminal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toast';

// The "Connect the CLI" panel (Story MOTIR-1863 · Subtask MOTIR-1869) — design
// `design/cli-connect/cli-connect.mock.html` Panels 9–11. This is the ONLY place
// in the product that says the CLI exists, so it is the FIRST card of the API
// tokens pane, above both the tokens table and the empty state: a first-time
// user has no tokens, and the two-command route has to read before "Create
// token" or they are walked into minting and pasting a secret by hand.
//
// It composes the shipped pane and adds no route, endpoint or token surface —
// the tie line points at the EXISTING revoke flow as the disconnect action
// rather than introducing a second one.

/** The CLI guide the footer links to, using the pane's shipped absolute-GitHub-docs
 * convention (`MCP_GUIDE_HREF` in `ApiTokensManager.tsx`). */
const CLI_GUIDE_HREF = 'https://github.com/moooon-B-V/motir-core/blob/main/docs/cli.md';

/** The two commands, verified against `packages/cli/src/program.ts` @ MOTIR-1868:
 * `motir login` is a top-level command in the SETUP help group and takes no
 * required flags, and `@motir/cli` is the published package name (MOTIR-1882). */
const INSTALL_COMMAND = 'npm install -g @motir/cli';
const LOGIN_COMMAND = 'motir login';

/** Stands in for the machine name in the tie line's `CLI · <hostname>` chip —
 * the shape `cliTokenLabel()` mints, so the reader can match the chip against a
 * row in the table below. Not translated: it is a literal, not prose. */
const HOSTNAME_PLACEHOLDER = '<hostname>';

export function ConnectCliPanel({ hasTokens }: { hasTokens: boolean }) {
  const t = useTranslations('settings.apiTokens');
  const { toast } = useToast();

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      toast({ variant: 'success', title: t('cli.toast.title'), description: t('cli.toast.body') });
    } catch {
      toast({ variant: 'error', title: t('cli.copyFailed') });
    }
  }

  // Two rich-text chunks, and the design distinguishes them (`.mono` vs
  // `.code-chip` in the mock): a command named INSIDE prose is monospace only, so
  // the sentence still reads as a sentence; the token LABEL in the tie line is a
  // real chip, because it names a string the reader will match against a row in
  // the table below.
  const mono = (chunks: React.ReactNode) => <code className="font-mono">{chunks}</code>;
  const code = (chunks: React.ReactNode) => (
    <code className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-(--el-code-text)">
      {chunks}
    </code>
  );

  return (
    <Card
      header={
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-sans text-base font-semibold text-(--el-text)">
            <Terminal className="size-4 text-(--el-text-muted)" aria-hidden />
            {t('cli.title')}
          </h3>
          <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">
            {t.rich('cli.subtitle', { mono })}
          </p>
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <a
            href={CLI_GUIDE_HREF}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-sans text-sm text-(--el-link) underline underline-offset-2 hover:text-(--el-link-pressed)"
          >
            <BookOpen className="size-4" aria-hidden />
            {t('cli.guide')}
          </a>
          {/* The tie to the list below: the CLI's kill switch is the revoke this
              pane already ships, not a second "disconnect" control. Future tense
              while the list is still empty. */}
          {/* `<hostname>` is a VALUE, not markup — next-intl parses `<…>` in a
              message as a rich-text tag, so the placeholder has to arrive as an
              interpolated string or it is swallowed (or, escaped, printed raw). */}
          <p className="font-sans text-xs text-(--el-text-muted)">
            {t.rich(hasTokens ? 'cli.tie' : 'cli.tieEmpty', { code, host: HOSTNAME_PLACEHOLDER })}
          </p>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Step
          caption={t('cli.step1')}
          command={INSTALL_COMMAND}
          copyLabel={t('cli.copyInstall')}
          onCopy={copyCommand}
        />
        <Step
          caption={t('cli.step2')}
          command={LOGIN_COMMAND}
          copyLabel={t('cli.copySignIn')}
          onCopy={copyCommand}
        />
      </div>

      <p className="mt-4 font-sans text-sm leading-relaxed text-(--el-text-secondary)">
        {t.rich('cli.next', { mono })}
      </p>
      <p className="mt-2 font-sans text-xs leading-relaxed text-(--el-text-muted)">
        {t.rich('cli.headless', { mono })}
      </p>
    </Card>
  );
}

/** One numbered step: an uppercase caption over an input-shaped command row with
 * a copy icon-button. `--el-text-muted` (not `-faint`) on the caption — it carries
 * meaning, and faint measures 2.61:1. */
function Step({
  caption,
  command,
  copyLabel,
  onCopy,
}: {
  caption: string;
  command: string;
  copyLabel: string;
  onCopy: (command: string) => void;
}) {
  return (
    <div className="min-w-0">
      <span className="mb-1.5 block font-sans text-xs font-semibold tracking-wide text-(--el-text-muted) uppercase">
        {caption}
      </span>
      <div className="flex h-(--height-input) items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-surface) pr-2 pl-(--spacing-input-x)">
        <code className="min-w-0 flex-1 truncate font-mono text-sm text-(--el-code-text)">
          {command}
        </code>
        <button
          type="button"
          aria-label={copyLabel}
          onClick={() => void onCopy(command)}
          className="inline-flex size-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Copy className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
