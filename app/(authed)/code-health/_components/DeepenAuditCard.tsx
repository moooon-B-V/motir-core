'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ScanSearch,
  SearchCode,
  ShieldCheck,
  RefreshCw,
  Copy,
  Check,
  X,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { ExternalScannerStateDTO } from '@/lib/dto/codeHealth';

// The §10.3 "Deepen this audit" connect-scanner affordance (MOTIR-1592), rendered
// in-situ inside the audit report (design/coding-convention Panel 1 + Panel 6).
// A NON-BLOCKING, dismissible aside on the quiet `--el-surface-soft` fill (never a
// report Card): the Tier-1 + Opengrep report is already complete; this only
// *deepens* it when NO external scanner is connected. Best-fit guided setup
// (GitHub code scanning / CodeQL as the GH-native default; SonarQube/SonarCloud as
// the ecosystem branch) → the user configures the scanner → "Re-audit now"
// re-runs the audit so Motir auto-detects + ingests it (the parent owns the
// re-audit + poll; page-state-after-mutation contract).

type Tool = 'codeql' | 'sonar';

// Copy-paste setup guidance (code, not localized). The CodeQL workflow is the
// lightest native path — SARIF uploaded to the code-scanning API Motir already
// reads (MOTIR-1591 detection); sonar-project.properties is the ecosystem branch,
// ingested through the same §10.1 SARIF adapter.
const CODEQL_WORKFLOW = `# .github/workflows/codeql.yml
name: "CodeQL"
on:
  push:
    branches: ["main"]
  pull_request:
    branches: ["main"]
  schedule:
    - cron: "0 6 * * 1"
jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@v3
`;

const SONAR_CONFIG = `# sonar-project.properties
sonar.projectKey=your_project_key
sonar.organization=your_organization
sonar.sources=.
sonar.sourceEncoding=UTF-8
`;

function SetupBlock({
  tool,
  reauditing,
  onReaudit,
  onSwitch,
}: {
  tool: Tool;
  reauditing: boolean;
  onReaudit: () => void;
  onSwitch: () => void;
}) {
  const t = useTranslations('codeHealth');
  const [copied, setCopied] = useState(false);
  const snippet = tool === 'codeql' ? CODEQL_WORKFLOW : SONAR_CONFIG;

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context) — the snippet is still selectable.
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-sm text-(--el-text-secondary)">
        {t(tool === 'codeql' ? 'deepen.codeql.setupHint' : 'deepen.sonar.setupHint')}
      </p>
      <pre className="overflow-x-auto rounded-(--radius-input) border border-(--el-border) bg-(--el-code-bg) p-3 text-xs text-(--el-code-text)">
        <code>{snippet}</code>
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          leftIcon={<RefreshCw className="size-4" aria-hidden />}
          loading={reauditing}
          onClick={onReaudit}
        >
          {t('deepen.reauditNow')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={
            copied ? (
              <Check className="size-4" aria-hidden />
            ) : (
              <Copy className="size-4" aria-hidden />
            )
          }
          onClick={() => void copy()}
        >
          {copied ? t('deepen.copied') : t('deepen.copy')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onSwitch}>
          {t(tool === 'codeql' ? 'deepen.useSonarInstead' : 'deepen.useCodeqlInstead')}
        </Button>
      </div>
    </div>
  );
}

function ToolRow({
  tool,
  recommended,
  expanded,
  onOpen,
}: {
  tool: Tool;
  recommended: boolean;
  expanded: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations('codeHealth');
  const Icon = tool === 'codeql' ? SearchCode : ShieldCheck;
  return (
    <div
      className={`rounded-(--radius-card) border p-3 ${
        recommended
          ? 'border-(--el-accent-on-surface) bg-(--el-surface-soft)'
          : 'border-(--el-border) bg-(--el-page-bg)'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon
            className={`size-4 ${recommended ? 'text-(--el-accent-on-surface)' : 'text-(--el-text-secondary)'}`}
            aria-hidden
          />
          <span className="text-sm font-medium text-(--el-text-strong)">
            {t(tool === 'codeql' ? 'deepen.codeql.name' : 'deepen.sonar.name')}
          </span>
          {recommended ? (
            <span className="rounded-(--radius-badge) bg-(--el-callout-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-callout-text)">
              {t('deepen.recommended')}
            </span>
          ) : null}
        </div>
        <Button
          variant={recommended ? 'primary' : 'secondary'}
          size="sm"
          onClick={onOpen}
          aria-expanded={expanded}
        >
          {t(tool === 'codeql' ? 'deepen.codeql.action' : 'deepen.sonar.action')}
        </Button>
      </div>
      <p className="mt-1 text-xs text-(--el-text-muted)">
        {t(tool === 'codeql' ? 'deepen.codeql.blurb' : 'deepen.sonar.blurb')}
      </p>
    </div>
  );
}

export function DeepenAuditCard({
  scanner,
  reauditing,
  onReaudit,
  onDismiss,
}: {
  scanner: ExternalScannerStateDTO;
  reauditing: boolean;
  onReaudit: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('codeHealth');
  // Best-fit: the backend suggestion picks the recommended tool (GitHub-hosted →
  // CodeQL; otherwise SonarQube). Default to CodeQL (the GH-native path).
  const recommended: Tool = scanner.suggestion === 'sonarqube' ? 'sonar' : 'codeql';
  const [expanded, setExpanded] = useState<Tool | null>(null);

  return (
    <section
      aria-label={t('deepen.title')}
      className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding)"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-(--el-text-muted)">
          {t('deepen.eyebrow')}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('deepen.dismiss')}
          className="rounded-(--radius-control) p-1 text-(--el-text-muted) hover:text-(--el-text-strong) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="flex items-start gap-3">
        <ScanSearch className="mt-0.5 size-5 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
        <div className="flex flex-col gap-1">
          <h3 className="font-serif text-base font-semibold text-(--el-text-strong)">
            {t('deepen.title')}
          </h3>
          <p className="text-sm text-(--el-text-secondary)">{t('deepen.subtitle')}</p>
        </div>
      </div>

      {reauditing ? (
        <div className="flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface-soft) p-3">
          <Loader2 className="size-4 animate-spin text-(--el-accent-on-surface)" aria-hidden />
          <span className="text-sm font-medium text-(--el-text-strong)">
            {t('deepen.reauditing')}
          </span>
        </div>
      ) : (
        <>
          <p className="text-xs font-medium text-(--el-text-muted)">{t('deepen.bestFit')}</p>
          <div className="flex flex-col gap-2">
            {(['codeql', 'sonar'] as Tool[])
              .sort((a) => (a === recommended ? -1 : 1))
              .map((tool) => (
                <div key={tool}>
                  <ToolRow
                    tool={tool}
                    recommended={tool === recommended}
                    expanded={expanded === tool}
                    onOpen={() => setExpanded(expanded === tool ? null : tool)}
                  />
                  {expanded === tool ? (
                    <SetupBlock
                      tool={tool}
                      reauditing={reauditing}
                      onReaudit={onReaudit}
                      onSwitch={() => setExpanded(tool === 'codeql' ? 'sonar' : 'codeql')}
                    />
                  ) : null}
                </div>
              ))}
          </div>
        </>
      )}

      <p className="text-xs text-(--el-text-muted)">{t('deepen.footerHint')}</p>
    </section>
  );
}

// The dismissed state (Panel 6 State D): the report is fully usable; a quiet
// one-line link re-opens the affordance. Rendered by the parent when dismissed.
export function DeepenReopenLink({ onReopen }: { onReopen: () => void }) {
  const t = useTranslations('codeHealth');
  return (
    <button
      type="button"
      onClick={onReopen}
      className="flex items-center gap-1.5 self-start text-sm text-(--el-link) hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      <ScanSearch className="size-4" aria-hidden />
      {t('deepen.reopen')}
    </button>
  );
}
